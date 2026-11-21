import assert from "node:assert/strict";
import test from "node:test";
import { isConfirmedMessage } from "../public/reconcile.mjs";

test("reconciliation only confirms a non-empty signed message ID already in verified render state", () => {
  const shown = new Set(["signed-message-id"]);
  assert.equal(isConfirmedMessage(shown, "signed-message-id"), true);
  assert.equal(isConfirmedMessage(shown, "other-id"), false);
  assert.equal(isConfirmedMessage(shown, ""), false);
  assert.equal(isConfirmedMessage(shown, null), false);
});
