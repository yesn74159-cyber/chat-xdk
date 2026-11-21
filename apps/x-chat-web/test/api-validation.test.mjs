import assert from "node:assert/strict";
import test from "node:test";
import {
  directConversationKeysPayload,
  groupCreatePayload,
  groupMemberMutationPayload,
  mediaSegmentIndex,
  mockNetworkPayload,
  paginationToken,
} from "../lib/api-validation.mjs";

const OWNER = "1000000000000000001";
const PEER = "1000000000000000002";
const THIRD = "1000000000000000003";

function signature(id = "action-1") {
  return {
    message_id: id,
    encoded_message_event_detail: "encoded",
    message_event_signature: {
      signature: "sig",
      signature_version: "1",
      public_key_version: "1",
      signing_public_key: "spki",
    },
  };
}

function participantKey(user) {
  return { user_id: user, encrypted_conversation_key: "wrapped", public_key_version: "1" };
}

test("group create payload normalizes members, admins, and signatures", () => {
  const payload = groupCreatePayload({
    conversation_id: "g-1",
    conversation_key_version: "1",
    conversation_participant_keys: [participantKey(OWNER), participantKey(PEER)],
    group_members: [OWNER, PEER],
    group_admins: [OWNER],
    group_name: "Test group",
    action_signatures: [signature("a"), signature("b")],
  });
  assert.deepEqual(payload.group_members, [OWNER, PEER]);
  assert.deepEqual(payload.group_admins, [OWNER]);
  assert.equal(payload.action_signatures.length, 2);
});

test("group create rejects an admin who is not a member", () => {
  assert.throws(
    () =>
      groupCreatePayload({
        conversation_id: "g-1",
        conversation_key_version: "1",
        conversation_participant_keys: [participantKey(OWNER)],
        group_members: [OWNER],
        group_admins: [THIRD],
        group_name: "Test group",
        action_signatures: [signature("a"), signature("b")],
      }),
    /Invalid group_admins/,
  );
});

test("direct key payload requires the canonical A:B conversation id", () => {
  const body = {
    conversation_key_version: "1",
    conversation_participant_keys: [participantKey(OWNER), participantKey(PEER)],
    action_signatures: [signature()],
  };
  assert.throws(
    () => directConversationKeysPayload(body, OWNER, PEER, `${OWNER}:${THIRD}`),
    /Invalid canonical conversation_id/,
  );
  assert.throws(() => directConversationKeysPayload(body, OWNER, PEER, `${OWNER}-${PEER}:${THIRD}`));
  const accepted = directConversationKeysPayload(body, OWNER, PEER, `${OWNER}:${PEER}`);
  assert.equal(accepted.conversation_key_version, "1");
});

test("group member removal reads rotation data and needs one signature", () => {
  const payload = groupMemberMutationPayload(
    {
      conversation_id: "g-1",
      expected_key_version: "1",
      user_ids: [PEER],
      group_key_rotation_data: {
        conversation_key_version: "2",
        conversation_participant_keys: [participantKey(OWNER)],
      },
      action_signatures: [signature()],
    },
    "remove",
  );
  assert.deepEqual(payload.participantIds, [OWNER]);
  assert.equal(payload.conversationKeyVersion, "2");
});

test("group member addition requires two signatures", () => {
  const base = {
    conversation_id: "g-1",
    expected_key_version: "1",
    user_ids: [THIRD],
    conversation_key_version: "2",
    conversation_participant_keys: [participantKey(OWNER), participantKey(PEER), participantKey(THIRD)],
  };
  assert.throws(
    () => groupMemberMutationPayload({ ...base, action_signatures: [signature()] }, "add"),
    /Invalid action_signatures/,
  );
  const payload = groupMemberMutationPayload({ ...base, action_signatures: [signature("a"), signature("b")] }, "add");
  assert.equal(payload.actionSignatures.length, 2);
});

test("mock network settings reject unknown delivery order", () => {
  assert.throws(
    () => mockNetworkPayload({ offline: false, order: "sideways", duplicate: false }),
    /Invalid delivery order/,
  );
  assert.deepEqual(mockNetworkPayload({ offline: true, order: "reverse", duplicate: true }), {
    offline: true,
    order: "reverse",
    duplicate: true,
  });
});

test("media segment index and pagination token bounds are enforced", () => {
  assert.equal(mediaSegmentIndex(0), 0);
  assert.throws(() => mediaSegmentIndex(1000), /Invalid segment_index/);
  assert.throws(() => mediaSegmentIndex(1.5), /Invalid segment_index/);
  assert.equal(paginationToken(null), null);
  assert.equal(paginationToken("5"), "5");
  assert.throws(() => paginationToken(""), /Invalid pagination_token/);
  assert.throws(() => paginationToken("x".repeat(2049)), /Invalid pagination_token/);
});
