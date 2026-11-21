function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value.trim();
}

/** Draft content is explicitly memory-only. Persist only toDraftAudit output. */
export function createDraft({ conversationId, text, hasFile = false, reason = "" }) {
  return {
    id: crypto.randomUUID(),
    conversationId: requiredText(conversationId, "conversation ID"),
    text: requiredText(text, "draft text"),
    hasFile: Boolean(hasFile),
    reason: String(reason || "").trim(),
    createdAt: new Date().toISOString(),
    status: "pending_approval",
  };
}

export function approveDraft(draft) {
  if (!draft || draft.status !== "pending_approval") throw new Error("Draft is not pending approval");
  return { ...draft, status: "approved", approvedAt: new Date().toISOString() };
}

export function discardDraft(draft) {
  if (!draft || !["pending_approval", "approved"].includes(draft.status)) throw new Error("Draft cannot be discarded");
  return { ...draft, status: "discarded", discardedAt: new Date().toISOString() };
}

export function toDraftAudit(draft) {
  return {
    id: draft.id,
    conversationId: draft.conversationId,
    hasFile: draft.hasFile,
    reason: draft.reason,
    status: draft.status,
    createdAt: draft.createdAt,
    ...(draft.approvedAt ? { approvedAt: draft.approvedAt } : {}),
    ...(draft.discardedAt ? { discardedAt: draft.discardedAt } : {}),
  };
}
