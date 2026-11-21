/**
 * Claims a verified message event exactly once for rendering.
 * @param {Set<string>} shown
 * @param {{ event?: { type?: string, verified?: boolean, messageId?: string, id?: string }, originalB64?: string }} entry
 */
export function claimRenderableEvent(shown, entry) {
  const event = entry?.event;
  if (event?.type !== "message" || event.verified !== true) return false;
  const id = String(event.messageId || event.id || entry.originalB64 || "");
  if (!id || shown.has(id)) return false;
  shown.add(id);
  return true;
}

export function classifyUnverifiedEvent(metadata, error) {
  if (metadata?.PARSER_STATUS === "ok" && metadata.EMBEDDED_SIGNATURE_PRESENT === false) return "unsigned";

  const message = String(error || "").toLowerCase();
  if (/ecdsa mismatch|signature verification failed|invalid signature/.test(message)) return "invalid_signature";
  if (
    metadata?.SENDER_MATCH === false ||
    metadata?.SIGNING_KEY_VERSION_MATCH === false ||
    /no matching signing key|missing signing key|no matching conversation key/.test(message)
  ) {
    return "missing_key";
  }
  return "unverified";
}

export function unverifiedEventPlaceholder(status) {
  const details = {
    unsigned: ["ไม่มีลายเซ็นดิจิทัล", "ซ่อนเนื้อหาเพื่อความปลอดภัย"],
    invalid_signature: ["ลายเซ็นไม่ผ่านการตรวจ", "ซ่อนเนื้อหาเพื่อความปลอดภัย"],
    missing_key: ["ไม่พบกุญแจที่ตรงกัน", "ซ่อนเนื้อหาเพื่อความปลอดภัย"],
    unverified: ["ยืนยันเหตุการณ์ไม่ได้", "ซ่อนเนื้อหาเพื่อความปลอดภัย"],
  };
  const [title, description] = details[status] || details.unverified;
  return { status: details[status] ? status : "unverified", title, description };
}

export function claimUnverifiedEvent(shown, eventId) {
  if (typeof eventId !== "string" || !eventId || shown.has(eventId)) return false;
  shown.add(eventId);
  return true;
}

export function isKnownUnsignedEvent(knownUnsigned, eventId) {
  return typeof eventId === "string" && knownUnsigned.has(eventId);
}

export function missingConversationKey(error) {
  return /message encrypted with key version .* but no matching key found/i.test(String(error || ""));
}
