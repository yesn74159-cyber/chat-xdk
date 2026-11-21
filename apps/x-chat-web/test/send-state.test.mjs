import assert from "node:assert/strict";
import test from "node:test";
import { pendingSendFromPayload, retainPendingSend } from "../public/send-state.mjs";

const payload = {
  messageId: "signed-message-id",
  encodedMessageCreateEvent: "encrypted-event",
  encodedMessageEventSignature: "signature",
  xdkVersion: "1",
  eventB64: "mock-only-event",
};

test("an ambiguous send retains exactly one signed payload for retry", () => {
  const pending = pendingSendFromPayload("100:200", payload, "live");
  assert.deepEqual(pending, {
    conversation_id: "100:200",
    message_id: "signed-message-id",
    encoded_message_create_event: "encrypted-event",
    encoded_message_event_signature: "signature",
    xdk_version: "1",
  });
  assert.equal(retainPendingSend({ retryable: true }), true);
  assert.strictEqual(pending, pending);
  assert.equal(pending.message_id, "signed-message-id");
  assert.equal(retainPendingSend({ retryable: false }), false);
  assert.equal(retainPendingSend(new Error("network ambiguity")), true);
});

test("mock event data is never included in a live payload", () => {
  assert.equal("event_b64" in pendingSendFromPayload("100:200", payload, "live"), false);
  assert.equal(pendingSendFromPayload("100:200", payload, "mock").event_b64, "mock-only-event");
});
