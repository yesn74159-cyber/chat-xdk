import assert from "node:assert/strict";
import test from "node:test";
import { groupCreateRequest, groupMemberIds } from "../public/group-create.mjs";

test("group member IDs include the owner once and reject ambiguous input", () => {
  assert.deepEqual(groupMemberIds("2222, 3333\n2222", "1111"), ["1111", "2222", "3333"]);
  assert.throws(() => groupMemberIds("", "1111"), /เพิ่มสมาชิก/);
  assert.throws(() => groupMemberIds("not-an-id", "1111"), /Invalid member ID/);
});

test("group create request maps prepared SDK values without a raw conversation key", () => {
  const body = groupCreateRequest(
    {
      conversationId: "g-test",
      conversationKeyVersion: "7",
      encryptedTitle: "encrypted-title",
      conversationKey: new Uint8Array(32),
      conversationParticipantKeys: [
        { userId: "1111", encryptedConversationKey: "wrapped-1", publicKeyVersion: "1" },
        { userId: "2222", encryptedConversationKey: "wrapped-2", publicKeyVersion: "1" },
      ],
      actionSignatures: [
        {
          messageId: "first",
          encodedMessageEventDetail: "detail-1",
          messageEventSignature: {
            signature: "sig-1",
            signatureVersion: "1",
            publicKeyVersion: "1",
            signingPublicKey: "signing-1",
          },
        },
        {
          messageId: "second",
          encodedMessageEventDetail: "detail-2",
          messageEventSignature: {
            signature: "sig-2",
            signatureVersion: "1",
            publicKeyVersion: "1",
            signingPublicKey: "signing-1",
          },
        },
      ],
    },
    ["1111", "2222"],
    ["1111"],
  );
  assert.equal(body.group_name, "encrypted-title");
  assert.equal(body.action_signatures.length, 2);
  assert.equal("conversationKey" in body, false);
  assert.deepEqual(body.conversation_participant_keys[1], {
    user_id: "2222",
    encrypted_conversation_key: "wrapped-2",
    public_key_version: "1",
  });
});
