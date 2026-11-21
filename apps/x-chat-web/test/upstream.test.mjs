import assert from "node:assert/strict";
import test from "node:test";
import { fetchX, MAX_X_JSON_RESPONSE_BYTES, readBoundedBytes, readXJson, UpstreamError } from "../lib/upstream.mjs";

function responseFromChunks(chunks, headers = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    }),
    { headers },
  );
}

test("bounded response reader accepts small JSON and rejects declared or streamed oversized bodies", async () => {
  const body = await readXJson(new Response('{"data":"ok"}'));
  assert.deepEqual(body, { data: "ok" });

  await assert.rejects(
    readBoundedBytes(new Response("x", { headers: { "content-length": "11" } }), 10),
    (error) => error instanceof UpstreamError && error.message === "X API response body is too large",
  );
  await assert.rejects(
    readBoundedBytes(
      responseFromChunks([
        [1, 2, 3],
        [4, 5, 6],
      ]),
      5,
    ),
    (error) => error instanceof UpstreamError && error.message === "X API response body is too large",
  );
  await assert.rejects(
    readXJson(new Response("x", { headers: { "content-length": String(MAX_X_JSON_RESPONSE_BYTES + 1) } })),
    (error) => error instanceof UpstreamError && error.message === "X API response body is too large",
  );
  await assert.rejects(
    readXJson(new Response("not json")),
    (error) => error instanceof UpstreamError && error.message === "X API returned invalid JSON",
  );
  assert.equal(MAX_X_JSON_RESPONSE_BYTES, 1024 * 1024);
});

test("X request wrapper applies authorization, maps failures, and times out", async () => {
  const response = await fetchX({
    baseUrl: "https://example.invalid",
    path: "/chat",
    token: "test-token",
    fetchImpl: async (url, options) => {
      assert.equal(url.href, "https://example.invalid/chat");
      assert.equal(options.headers.authorization, "Bearer test-token");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(response.status, 200);

  await assert.rejects(
    fetchX({
      baseUrl: "https://example.invalid",
      path: "/chat",
      token: "test-token",
      fetchImpl: async () => new Response("", { status: 429 }),
    }),
    (error) =>
      error instanceof UpstreamError && error.message === "X API returned HTTP 429" && error.retryable === true,
  );
  await assert.rejects(
    fetchX({
      baseUrl: "https://example.invalid",
      path: "/chat",
      token: "test-token",
      fetchImpl: async () => new Response("", { status: 400 }),
    }),
    (error) =>
      error instanceof UpstreamError && error.message === "X API returned HTTP 400" && error.retryable === false,
  );
  const statusCases = /** @type {Array<[number, boolean]>} */ ([
    [401, false],
    [403, false],
    [404, false],
    [409, false],
    [500, true],
    [503, true],
  ]);
  for (const [status, retryable] of statusCases) {
    await assert.rejects(
      fetchX({
        baseUrl: "https://example.invalid",
        path: "/chat",
        token: "test-token",
        fetchImpl: async () => new Response("upstream detail must not reach the app", { status }),
      }),
      (error) =>
        error instanceof UpstreamError &&
        error.message === `X API returned HTTP ${status}` &&
        error.retryable === retryable,
    );
  }
  await assert.rejects(
    fetchX({
      baseUrl: "https://example.invalid",
      path: "/chat",
      token: "test-token",
      timeoutMs: 1,
      fetchImpl: async (_url, options) =>
        new Promise((_resolve, reject) => {
          // AbortSignal.timeout()'s timer is unref'd, so on a quiet event loop
          // the abort can race the test runner draining. Keep the loop alive
          // with a referenced timer so this promise always settles.
          const keepAlive = setTimeout(
            () => reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
            5_000,
          );
          options.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(options.signal.reason);
          });
        }),
    }),
    (error) =>
      error instanceof UpstreamError && error.message === "X API request timed out" && error.retryable === true,
  );
});
