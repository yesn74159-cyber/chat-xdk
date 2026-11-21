import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_EVENT_FIELDS, conversationEventsPath } from "../lib/chat-events.mjs";

test("conversation history requests all documented encrypted-event metadata", () => {
  const path = conversationEventsPath("111-222", "next-cursor");
  const url = new URL(path, "https://api.x.com");
  const fields = url.searchParams.get("chat_message_event.fields").split(",");

  assert.equal(url.pathname, "/2/chat/conversations/111-222/events");
  assert.equal(url.searchParams.get("max_results"), "100");
  assert.equal(url.searchParams.get("pagination_token"), "next-cursor");
  assert.deepEqual(fields, CHAT_EVENT_FIELDS);
  assert.ok(fields.includes("message_event_signature"));
  assert.ok(fields.includes("conversation_token"));
});

test("conversation history path omits pagination when loading the first page", () => {
  const url = new URL(conversationEventsPath("g123", null), "https://api.x.com");
  assert.equal(url.searchParams.has("pagination_token"), false);
});
