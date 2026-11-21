export const X_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_X_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_X_MEDIA_RESPONSE_BYTES = 16 * 1024 * 1024;

export class UpstreamError extends Error {
  constructor(message, { retryable = false, status = 502 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
    /** @type {string} */
    this.detail = "";
    /** @type {string} */
    this.requestId = "";
  }
}

const MAX_X_PROBLEM_BYTES = 4096;

async function readProblemSummary(response) {
  if (!response.body) return "";
  try {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < MAX_X_PROBLEM_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(Math.min(total, MAX_X_PROBLEM_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= bytes.length) break;
      const slice = chunk.subarray(0, bytes.length - offset);
      bytes.set(slice, offset);
      offset += slice.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    let summary;
    try {
      const body = JSON.parse(text);
      summary = [body?.title, body?.type, body?.detail]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" | ");
    } catch {
      summary = text;
    }
    return summary
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .slice(0, 300)
      .trim();
  } catch {
    return "";
  }
}

/**
 * @param {{ baseUrl: string, path: string, token: string, options?: RequestInit, fetchImpl?: typeof fetch, timeoutMs?: number }} request
 */
export async function fetchX({
  baseUrl,
  path,
  token,
  options = {},
  fetchImpl = fetch,
  timeoutMs = X_REQUEST_TIMEOUT_MS,
}) {
  let response;
  try {
    response = await fetchImpl(new URL(path, baseUrl), {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new UpstreamError("X API request timed out", { retryable: true });
    }
    throw new UpstreamError("X API request failed", { retryable: true });
  }
  if (!response.ok) {
    const error = new UpstreamError(`X API returned HTTP ${response.status}`, {
      retryable:
        response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
      status: response.status >= 400 && response.status < 500 ? response.status : 502,
    });
    error.detail = await readProblemSummary(response);
    error.requestId = response.headers.get("x-request-id") || "";
    throw error;
  }
  return response;
}

export async function readBoundedBytes(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpstreamError("X API response body is too large", { status: 413 });
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new UpstreamError("X API response body is too large", { status: 413 });
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readXJson(response) {
  const bytes = await readBoundedBytes(response, MAX_X_JSON_RESPONSE_BYTES);
  try {
    const text = new TextDecoder().decode(bytes);
    return text ? JSON.parse(text) : {};
  } catch {
    throw new UpstreamError("X API returned invalid JSON");
  }
}
