import assert from "node:assert/strict";
import test from "node:test";
import {
  claimRenderableEvent,
  claimUnverifiedEvent,
  classifyUnverifiedEvent,
  isKnownUnsignedEvent,
  missingConversationKey,
  unverifiedEventPlaceholder,
} from "../public/event-state.mjs";

test("only one verified message with a signed ID is claimed for rendering", () => {
  const shown = new Set();
  const entry = { event: { type: "message", verified: true, id: "signed-id" }, originalB64: "event" };
  assert.equal(claimRenderableEvent(shown, entry), true);
  assert.equal(claimRenderableEvent(shown, entry), false);
  assert.equal(claimRenderableEvent(shown, { event: { type: "message", verified: false, id: "unverified" } }), false);
  assert.equal(claimRenderableEvent(shown, { event: { type: "key_change", verified: true, id: "key-change" } }), false);
  assert.deepEqual([...shown], ["signed-id"]);
});

test("classifies unsigned, invalid-signature, missing-key and fallback failures separately", () => {
  assert.equal(
    classifyUnverifiedEvent({ PARSER_STATUS: "ok", EMBEDDED_SIGNATURE_PRESENT: false }, "verification failed"),
    "unsigned",
  );
  assert.equal(
    classifyUnverifiedEvent({ EMBEDDED_SIGNATURE_PRESENT: true, SIGNING_KEY_VERSION_MATCH: true }, "ECDSA mismatch"),
    "invalid_signature",
  );
  assert.equal(
    classifyUnverifiedEvent({ EMBEDDED_SIGNATURE_PRESENT: true, SIGNING_KEY_VERSION_MATCH: false }, "SDK error"),
    "missing_key",
  );
  assert.equal(classifyUnverifiedEvent({ PARSER_STATUS: "malformed" }, "parse failed"), "unverified");
});

test("unverified placeholders contain no event or plaintext and are claimed once", () => {
  const placeholder = unverifiedEventPlaceholder("unsigned");
  assert.equal(placeholder.status, "unsigned");
  assert.match(placeholder.title, /ไม่มีลายเซ็น/);
  assert.doesNotMatch(JSON.stringify(placeholder), /plaintext|secret-event/);

  const shown = new Set();
  assert.equal(claimUnverifiedEvent(shown, "event-id"), true);
  assert.equal(claimUnverifiedEvent(shown, "event-id"), false);
  assert.equal(claimUnverifiedEvent(shown, ""), false);

  const knownUnsigned = new Set(["conversation\u0000event-id"]);
  assert.equal(isKnownUnsignedEvent(knownUnsigned, "conversation\u0000event-id"), true);
  assert.equal(isKnownUnsignedEvent(knownUnsigned, "conversation\u0000other-event"), false);

  const verifiedShown = new Set();
  assert.equal(
    claimRenderableEvent(verifiedShown, { event: { type: "message", verified: true, id: "event-id" } }),
    true,
  );
});

test("identifies the specific missing-conversation-key SDK failure for safe recovery", () => {
  assert.equal(
    missingConversationKey("Message encrypted with key version '5' but no matching key found. Available versions: []."),
    true,
  );
  assert.equal(missingConversationKey("signature missing or no matching signing key"), false);
});
