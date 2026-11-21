/**
 * Preserve the exact signed payload when a send outcome is ambiguous.
 * @param {string} conversationId
 * @param {{ messageId: string, encodedMessageCreateEvent: string, encodedMessageEventSignature: string, xdkVersion: string, eventB64: string }} payload
 * @param {string} mode
 */
export function pendingSendFromPayload(conversationId, payload, mode) {
  return {
    conversation_id: conversationId,
    message_id: payload.messageId,
    encoded_message_create_event: payload.encodedMessageCreateEvent,
    encoded_message_event_signature: payload.encodedMessageEventSignature,
    xdk_version: payload.xdkVersion,
    ...(mode === "mock" ? { event_b64: payload.eventB64 } : {}),
  };
}

/** @param {unknown} error */
export function retainPendingSend(error) {
  return !(error && typeof error === "object" && "retryable" in error && error.retryable === false);
}
