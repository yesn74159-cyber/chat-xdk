import assert from "node:assert/strict";
import test from "node:test";
import {
  canOpenConversation,
  conversationIdOf,
  mapConversationResponse,
  verifiedRecipientId,
} from "../public/conversation-list.mjs";

const liveResponseFixture = {
  data: [
    {
      id: "101:202",
      type: "direct",
      participant_ids: ["101", "202"],
      unread: true,
      updated_at: "2026-11-20T12:00:00Z",
    },
    { type: "direct", participant_ids: ["101", "303"] },
    { id: "101-606", type: "direct", participant_ids: ["606"] },
    { id: "101-101", type: "direct", participant_ids: ["101"] },
    { id: "101-707", type: "direct", participant_ids: ["707"] },
    { id: "101:404", type: "direct", participant_ids: ["101", "not-a-user-id"] },
    { id: "101:505", type: "direct", participant_ids: ["505", "606"] },
    { id: "g-test-1", type: "group", participant_ids: ["101", "202", "303"] },
    { id: "202-303", type: "direct", participant_ids: ["303"] },
    { id: "101-808", type: "direct", participant_ids: ["606"] },
    { id: "101-909-extra", type: "direct", participant_ids: ["909"] },
  ],
  includes: {
    users: [
      { id: "202", name: "Fixture Participant", username: "fixture_user" },
      {
        id: "606",
        name: "Single Participant",
        username: "single_fixture",
        profile_image_url: "https://pbs.twimg.com/profile_images/123/avatar_normal.jpg",
      },
    ],
  },
};

test("maps the Live conversation response shape and verified participant profile", () => {
  const [direct] = mapConversationResponse(liveResponseFixture, "101");
  assert.equal(direct.id, "101:202");
  assert.equal(direct.type, "direct");
  assert.deepEqual(direct.participant_ids, ["101", "202"]);
  assert.equal(direct.recipient_id, "202");
  assert.equal(direct.recipient_name, "Fixture Participant");
  assert.equal(direct.recipient_username, "fixture_user");
  assert.equal(direct.recipient_profile_image_url, "");
  assert.equal(canOpenConversation(direct, "101"), true);
  assert.equal(conversationIdOf(direct), "101:202");
  assert.equal(direct.unread, true);
});

test("binds one-party direct responses to the canonical ID and separates self chats", () => {
  const conversations = mapConversationResponse(liveResponseFixture, "101");
  const direct = conversations[2];
  assert.equal(direct.recipient_id, "606");
  assert.equal(direct.recipient_name, "Single Participant");
  assert.equal(direct.recipient_username, "single_fixture");
  assert.equal(direct.recipient_profile_image_url, "https://pbs.twimg.com/profile_images/123/avatar_normal.jpg");
  assert.equal(direct.recipient_verified, true);
  assert.equal(canOpenConversation(direct, "101"), true);

  const self = conversations[3];
  assert.equal(self.self_conversation, true);
  assert.equal(self.recipient_id, "");
  assert.equal(canOpenConversation(self, "101"), false);

  const unprofiled = conversations[4];
  assert.equal(unprofiled.recipient_id, "707");
  assert.equal(canOpenConversation(unprofiled, "101"), true);

  assert.equal(canOpenConversation(conversations[8], "101"), false);
  assert.equal(canOpenConversation(conversations[9], "101"), false);
  assert.equal(canOpenConversation(conversations[10], "101"), false);
});

test("derives missing direct IDs only from verified participants and refuses unverifiable records", () => {
  const conversations = mapConversationResponse(liveResponseFixture, "101");
  assert.equal(conversations[1].id, "101-303");
  assert.equal(canOpenConversation(conversations[1], "101"), true);
  assert.equal(conversations[1].recipient_id, "303");
  assert.equal(canOpenConversation(conversations[5], "101"), false);
  assert.equal(canOpenConversation(conversations[6], "101"), false);
  assert.equal(verifiedRecipientId(conversations[6], "101"), "");
  assert.equal(canOpenConversation(conversations[7], "101"), false);
  assert.equal(canOpenConversation(conversations[8], "101"), false);
  assert.equal(canOpenConversation(conversations[9], "101"), false);
  assert.equal(canOpenConversation(conversations[10], "101"), false);
  assert.equal(conversationIdOf(conversations[5]), "101:404");
});

test("supports legacy mock/cache aliases without weakening recipient checks", () => {
  const [conversation] = mapConversationResponse(
    [{ conversation_id: "101:202", conversation_type: "direct", member_ids: ["101", "202"] }],
    "101",
  );
  assert.equal(conversation.id, "101:202");
  assert.equal(conversation.type, "direct");
  assert.equal(canOpenConversation(conversation, "101"), true);
  assert.equal(canOpenConversation(conversation, "999"), false);
});
