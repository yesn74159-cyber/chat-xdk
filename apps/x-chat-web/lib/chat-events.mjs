export const CHAT_EVENT_FIELDS = [
  "conversation_id",
  "conversation_key_version",
  "conversation_token",
  "created_at",
  "encoded_event",
  "id",
  "is_trusted",
  "message_event_signature",
  "previous_id",
  "sender_id",
];

export function conversationEventsPath(conversationPathId, paginationToken) {
  const params = new URLSearchParams({
    max_results: "100",
    "chat_message_event.fields": CHAT_EVENT_FIELDS.join(","),
  });
  if (paginationToken) params.set("pagination_token", paginationToken);
  return `/2/chat/conversations/${conversationPathId}/events?${params}`;
}
