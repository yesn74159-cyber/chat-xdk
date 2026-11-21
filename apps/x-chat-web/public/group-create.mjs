const USER_ID = /^\d{1,19}$/;
const MAX_GROUP_MEMBERS = 100;

function requiredString(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function userId(value, name = "member ID") {
  const text = requiredString(value, name);
  if (!USER_ID.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

/** Parse a comma, whitespace, or newline separated list without guessing IDs. */
export function groupMemberIds(value, ownerId) {
  const owner = userId(ownerId, "owner ID");
  if (typeof value !== "string") throw new Error("Invalid member IDs");
  const entered = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((id) => userId(id));
  const ids = [...new Set([owner, ...entered])];
  if (ids.length < 2) throw new Error("เพิ่มสมาชิกอย่างน้อย 1 คน นอกเหนือจากบัญชีของคุณ");
  if (ids.length > MAX_GROUP_MEMBERS) throw new Error(`กลุ่มนี้รองรับได้ไม่เกิน ${MAX_GROUP_MEMBERS} คน`);
  return ids;
}

/** Keep the X API wire mapping in one place; the secret conversation key stays in the browser. */
export function groupCreateRequest(prepared, memberIds, adminIds) {
  if (!prepared || typeof prepared !== "object") throw new Error("Invalid prepared group");
  const members = memberIds.map((id) => userId(id));
  const admins = adminIds.map((id) => userId(id, "admin ID"));
  if (!members.length || !admins.length) throw new Error("Invalid group members");
  const participantKeys = prepared.conversationParticipantKeys;
  const signatures = prepared.actionSignatures;
  if (
    !Array.isArray(participantKeys) ||
    !participantKeys.length ||
    !Array.isArray(signatures) ||
    signatures.length !== 2
  ) {
    throw new Error("Invalid prepared group");
  }
  return {
    conversation_id: requiredString(prepared.conversationId, "conversation_id"),
    conversation_key_version: requiredString(prepared.conversationKeyVersion, "conversation_key_version"),
    conversation_participant_keys: participantKeys.map((key) => ({
      user_id: userId(key.userId),
      encrypted_conversation_key: requiredString(key.encryptedConversationKey, "encrypted_conversation_key"),
      public_key_version: requiredString(key.publicKeyVersion, "public_key_version"),
    })),
    group_members: members,
    group_admins: admins,
    group_name: requiredString(prepared.encryptedTitle, "group_name"),
    action_signatures: signatures.map((action) => ({
      message_id: requiredString(action.messageId, "message_id"),
      encoded_message_event_detail: requiredString(action.encodedMessageEventDetail, "encoded_message_event_detail"),
      message_event_signature: {
        signature: requiredString(action.messageEventSignature?.signature, "signature"),
        signature_version: requiredString(action.messageEventSignature?.signatureVersion, "signature_version"),
        public_key_version: requiredString(action.messageEventSignature?.publicKeyVersion, "public_key_version"),
        signing_public_key: requiredString(action.messageEventSignature?.signingPublicKey, "signing_public_key"),
      },
    })),
  };
}
