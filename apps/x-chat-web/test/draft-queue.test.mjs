import assert from "node:assert/strict";
import test from "node:test";
import { approveDraft, createDraft, discardDraft, toDraftAudit } from "../public/draft-queue.mjs";

test("draft requires an explicit approval and audit excludes plaintext", () => {
  const draft = createDraft({ conversationId: "g-mock-1", text: "private message", hasFile: true, reason: "review" });
  assert.equal(draft.status, "pending_approval");
  const approved = approveDraft(draft);
  const audit = toDraftAudit(approved);
  assert.equal(audit.status, "approved");
  assert.equal("text" in audit, false);
  assert.equal(discardDraft(createDraft({ conversationId: "g-mock-1", text: "discard" })).status, "discarded");
  assert.throws(() => approveDraft(approved), /not pending/);
});
