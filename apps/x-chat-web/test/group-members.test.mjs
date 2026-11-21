import assert from "node:assert/strict";
import test from "node:test";
import { groupMembersAddRequest, groupMembersRemoveRequest } from "../public/group-members.mjs";

const action = {
  messageId: "message-1",
  encodedMessageEventDetail: "ciphertext",
  messageEventSignature: { signature: "sig", signatureVersion: "7", publicKeyVersion: "1", signingPublicKey: "pub" },
};
const prepared = {
  conversationId: "g-mock-1",
  conversationKeyVersion: "2",
  conversationKey: new Uint8Array([1, 2, 3]),
  conversationParticipantKeys: [
    { userId: "1", encryptedConversationKey: "key1", publicKeyVersion: "1" },
    { userId: "2", encryptedConversationKey: "key2", publicKeyVersion: "1" },
  ],
  actionSignatures: [action, { ...action, messageId: "message-2" }],
};

test("group membership requests preserve encrypted material but never the raw conversation key", () => {
  const added = groupMembersAddRequest(prepared, ["2"], "1");
  assert.equal(added.conversation_key_version, "2");
  assert.equal("conversationKey" in added, false);
  assert.equal(added.action_signatures.length, 2);
  const removed = groupMembersRemoveRequest(prepared, ["2"], "1");
  assert.equal(removed.group_key_rotation_data.conversation_participant_keys.length, 2);
  assert.equal("conversationKey" in removed.group_key_rotation_data, false);
  assert.throws(() => groupMembersAddRequest(prepared, ["bad"], "1"), /Invalid user_ids/);
});
