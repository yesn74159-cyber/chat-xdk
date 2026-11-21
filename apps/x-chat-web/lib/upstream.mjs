export const X_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_X_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_X_MEDIA_RESPONSE_BYTES = 16 * 1024 * 1024;

export class UpstreamError extends Error {
  constructor(message, { retryable = false, status = 502 } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
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
    throw new UpstreamError(`X API returned HTTP ${response.status}`, {
      retryable:
        response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500,
    });
  }
  return response;
}

export async function readBoundedBytes(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpstreamError("X API response body is too large");
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
      if (total > maxBytes) throw new UpstreamError("X API response body is too large");
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
