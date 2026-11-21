import assert from "node:assert/strict";
import test from "node:test";
import { createGateway } from "../public/gateway.mjs";

test("gateway provides one UI contract and retains retryability without upstream detail", async () => {
  const calls = [];
  const gateway = createGateway(async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await gateway.markRead("g-mock-1"), { data: { ok: true } });
  assert.equal(calls[0].path, "/api/conversations/read");
  assert.equal(calls[0].options.headers["x-chat-local"], "1");
  await gateway.lookupContact("alice_1");
  assert.equal(calls[1].path, "/api/contacts/lookup?username=alice_1");
  const failed = createGateway(
    async () => new Response(JSON.stringify({ error: "offline", retryable: true }), { status: 503 }),
  );
  await assert.rejects(
    () => failed.conversations(),
    /** @param {any} error */ (error) =>
      error.message === "offline" && error.retryable === true && error.status === 503,
  );
  const missingContact = createGateway(
    async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
  );
  await assert.rejects(
    () => missingContact.lookupContact("missing"),
    /** @param {any} error */ (error) => error.message === "not found" && error.status === 404,
  );
});
