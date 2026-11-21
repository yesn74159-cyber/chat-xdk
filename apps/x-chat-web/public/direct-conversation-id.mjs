const USER_ID_PATTERN = /^\d{1,19}$/;

export function canonicalDirectConversationId(firstUserId, secondUserId) {
  const first = String(firstUserId ?? "");
  const second = String(secondUserId ?? "");
  if (
    !USER_ID_PATTERN.test(first) ||
    !USER_ID_PATTERN.test(second) ||
    String(BigInt(first)) !== first ||
    String(BigInt(second)) !== second ||
    first === second
  ) {
    throw new Error("Direct conversation requires two distinct canonical numeric user IDs");
  }
  return BigInt(first) < BigInt(second) ? `${first}:${second}` : `${second}:${first}`;
}

export function isCanonicalDirectConversationId(conversationId, ownerUserId, recipientUserId) {
  try {
    return conversationId === canonicalDirectConversationId(ownerUserId, recipientUserId);
  } catch {
    return false;
  }
}
