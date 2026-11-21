/** @param {Set<string>} shown @param {string | null | undefined} messageId */
export function isConfirmedMessage(shown, messageId) {
  return typeof messageId === "string" && messageId.length > 0 && shown.has(messageId);
}
