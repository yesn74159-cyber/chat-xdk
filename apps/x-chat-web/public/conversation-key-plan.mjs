import { isCanonicalDirectConversationId } from "./direct-conversation-id.mjs";

export { isCanonicalDirectConversationId } from "./direct-conversation-id.mjs";

const USER_ID_PATTERN = /^\d{1,19}$/;

export function prepareConversationKeyPlan(chat, publicKeys) {
  if (!chat || !Array.isArray(publicKeys) || publicKeys.length < 2) {
    throw new Error("ต้องตรวจ public key ของผู้เข้าร่วมทั้งสองบัญชีก่อน");
  }
  const prepared = chat.prepareConversationKeyChange({ publicKeys });
  try {
    if (
      typeof prepared.conversationId !== "string" ||
      !/^\d{1,19}:\d{1,19}$/.test(prepared.conversationId) ||
      typeof prepared.conversationKeyVersion !== "string" ||
      !prepared.conversationKeyVersion ||
      !Array.isArray(prepared.conversationParticipantKeys) ||
      prepared.conversationParticipantKeys.length !== 2 ||
      !Array.isArray(prepared.actionSignatures) ||
      !prepared.actionSignatures.length
    ) {
      throw new Error("SDK คืนข้อมูลแผนกุญแจไม่ครบถ้วน");
    }
    return {
      conversationId: prepared.conversationId,
      conversationKeyVersion: prepared.conversationKeyVersion,
      participantCount: prepared.conversationParticipantKeys.length,
      signatureCount: prepared.actionSignatures.length,
    };
  } finally {
    prepared.conversationKey?.fill(0);
  }
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`SDK คืนข้อมูล ${name} ไม่ครบ`);
  return value;
}

function participantKeyRequest(key) {
  if (!key || typeof key !== "object") throw new Error("SDK คืน participant key ไม่ถูกต้อง");
  return {
    user_id: requiredString(key.userId, "user_id"),
    encrypted_conversation_key: requiredString(key.encryptedConversationKey, "encrypted_conversation_key"),
    public_key_version: requiredString(key.publicKeyVersion, "public_key_version"),
  };
}

function actionSignatureRequest(action) {
  if (!action || typeof action !== "object" || !action.messageEventSignature) {
    throw new Error("SDK คืน action signature ไม่ครบ");
  }
  return {
    message_id: requiredString(action.messageId, "message_id"),
    encoded_message_event_detail: requiredString(action.encodedMessageEventDetail, "encoded_message_event_detail"),
    message_event_signature: {
      signature: requiredString(action.messageEventSignature.signature, "signature"),
      signature_version: requiredString(action.messageEventSignature.signatureVersion, "signature_version"),
      public_key_version: requiredString(action.messageEventSignature.publicKeyVersion, "public_key_version"),
      signing_public_key: requiredString(action.messageEventSignature.signingPublicKey, "signing_public_key"),
    },
  };
}

export function validateDirectConversationInitialization(
  response,
  expectedConversationId,
  authenticatedUserId,
  recipientUserId,
) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Mock ตอบผลเริ่มแชทไม่ถูกต้อง");
  }
  if (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0)) {
    throw new Error("Mock ตอบผลเริ่มแชทพร้อมข้อผิดพลาด");
  }
  const data = response.data;
  const conversationId = data?.conversation_id;
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    conversationId !== expectedConversationId ||
    !isCanonicalDirectConversationId(conversationId, authenticatedUserId, recipientUserId) ||
    (data.sequence_id !== undefined && (typeof data.sequence_id !== "string" || !data.sequence_id))
  ) {
    throw new Error("Mock ตอบ canonical conversation ID หรือข้อมูลตอบกลับไม่ถูกต้อง");
  }
  return data;
}

export function prepareDirectConversationChange(chat, publicKeys, authenticatedUserId, recipientUserId) {
  if (
    !chat ||
    !Array.isArray(publicKeys) ||
    publicKeys.length < 2 ||
    !USER_ID_PATTERN.test(authenticatedUserId) ||
    !USER_ID_PATTERN.test(recipientUserId) ||
    authenticatedUserId === recipientUserId
  ) {
    throw new Error("ต้องตรวจ public key ของบัญชีทั้งสองก่อนเริ่มแชท");
  }
  const keyOwners = new Set(publicKeys.map((key) => key?.userId));
  if (keyOwners.size !== 2 || !keyOwners.has(authenticatedUserId) || !keyOwners.has(recipientUserId)) {
    throw new Error("public key ต้องเป็นของบัญชี OAuth และผู้รับเท่านั้น");
  }

  const prepared = chat.prepareConversationKeyChange({ publicKeys });
  try {
    if (!prepared || typeof prepared !== "object") throw new Error("SDK ไม่คืนแผนกุญแจ");
    if (!isCanonicalDirectConversationId(prepared.conversationId, authenticatedUserId, recipientUserId)) {
      throw new Error("SDK คืน canonical conversation ID ไม่ตรงกับผู้เข้าร่วมที่ยืนยัน");
    }
    if (!(prepared.conversationKey instanceof Uint8Array) || prepared.conversationKey.length !== 32) {
      throw new Error("SDK คืน conversation key ไม่ถูกต้อง");
    }
    const participantKeys = prepared.conversationParticipantKeys;
    const actionSignatures = prepared.actionSignatures;
    if (!Array.isArray(participantKeys) || participantKeys.length !== 2) {
      throw new Error("SDK คืน participant keys ไม่ครบ");
    }
    if (!Array.isArray(actionSignatures) || actionSignatures.length !== 1) {
      throw new Error("SDK คืน action signature ไม่ครบ");
    }
    const requestKeys = participantKeys.map(participantKeyRequest);
    const requestParticipants = new Set(requestKeys.map((key) => key.user_id));
    if (
      requestParticipants.size !== 2 ||
      !requestParticipants.has(authenticatedUserId) ||
      !requestParticipants.has(recipientUserId)
    ) {
      throw new Error("SDK คืน participant keys ไม่ตรงกับผู้เข้าร่วมที่ยืนยัน");
    }
    const requestBody = {
      conversation_key_version: requiredString(prepared.conversationKeyVersion, "conversation_key_version"),
      conversation_participant_keys: requestKeys,
      action_signatures: actionSignatures.map(actionSignatureRequest),
    };
    return {
      conversationId: prepared.conversationId,
      conversationKey: prepared.conversationKey,
      conversationKeyVersion: requestBody.conversation_key_version,
      requestBody,
    };
  } catch (error) {
    prepared?.conversationKey?.fill(0);
    throw error;
  }
}
