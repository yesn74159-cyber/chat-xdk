// Request-body validators for the local adapter. They throw plain Errors; the
// router maps any thrown error without a numeric status to HTTP 400.

export function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
}

export function identifier(value, name) {
  const text = required(value, name);
  if (!/^[A-Za-z0-9_:.-]+$/.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

export function mediaSegmentIndex(value) {
  const index = nonNegativeInteger(value, "segment_index");
  if (index > 999) throw new Error("Invalid segment_index");
  return index;
}

export function base64(value, name) {
  const text = required(value, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error(`Invalid ${name}`);
  }
  return text;
}

export function paginationToken(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error("Invalid pagination_token");
  return value;
}

export function userId(value, name = "user_id") {
  const text = required(value, name);
  if (!/^\d{1,19}$/.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

export function stringList(value, name, item = required) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`Invalid ${name}`);
  const values = value.map((entry) => item(entry, name));
  if (new Set(values).size !== values.length) throw new Error(`Invalid ${name}`);
  return values;
}

export function groupCreatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid group create request");
  const members = stringList(value.group_members, "group_members", userId);
  const admins = stringList(value.group_admins, "group_admins", userId);
  if (!admins.every((id) => members.includes(id))) throw new Error("Invalid group_admins");
  const participantKeys = value.conversation_participant_keys;
  if (!Array.isArray(participantKeys) || participantKeys.length !== members.length) {
    throw new Error("Invalid conversation_participant_keys");
  }
  const participantIds = participantKeys.map((key) => {
    if (!key || typeof key !== "object" || Array.isArray(key)) throw new Error("Invalid conversation_participant_keys");
    required(key.encrypted_conversation_key, "encrypted_conversation_key");
    required(key.public_key_version, "public_key_version");
    return userId(key.user_id);
  });
  if (new Set(participantIds).size !== participantIds.length || !members.every((id) => participantIds.includes(id))) {
    throw new Error("Invalid conversation_participant_keys");
  }
  if (!Array.isArray(value.action_signatures) || value.action_signatures.length !== 2) {
    throw new Error("Invalid action_signatures");
  }
  for (const action of value.action_signatures) {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Invalid action_signatures");
    required(action.message_id, "message_id");
    required(action.encoded_message_event_detail, "encoded_message_event_detail");
    const signature = action.message_event_signature;
    if (!signature || typeof signature !== "object" || Array.isArray(signature))
      throw new Error("Invalid message_event_signature");
    required(signature.signature, "signature");
    required(signature.signature_version, "signature_version");
    required(signature.public_key_version, "public_key_version");
    required(signature.signing_public_key, "signing_public_key");
  }
  return {
    conversation_id: identifier(value.conversation_id, "conversation_id"),
    conversation_key_version: required(value.conversation_key_version, "conversation_key_version"),
    conversation_participant_keys: participantKeys,
    group_members: members,
    group_admins: admins,
    group_name: required(value.group_name, "group_name"),
    action_signatures: value.action_signatures,
  };
}

export function directConversationKeysPayload(value, authenticatedUserId, recipientId, conversationId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid direct conversation keys request");
  }
  const participants = conversationId.split(":");
  if (
    participants.length !== 2 ||
    new Set(participants).size !== 2 ||
    !participants.includes(authenticatedUserId) ||
    !participants.includes(recipientId)
  ) {
    throw new Error("Invalid canonical conversation_id");
  }
  const participantKeys = value.conversation_participant_keys;
  if (!Array.isArray(participantKeys) || participantKeys.length !== 2) {
    throw new Error("Invalid conversation_participant_keys");
  }
  const participantIds = participantKeys.map((key) => {
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw new Error("Invalid conversation_participant_keys");
    }
    required(key.encrypted_conversation_key, "encrypted_conversation_key");
    required(key.public_key_version, "public_key_version");
    return userId(key.user_id);
  });
  if (
    new Set(participantIds).size !== 2 ||
    !participantIds.includes(authenticatedUserId) ||
    !participantIds.includes(recipientId)
  ) {
    throw new Error("Invalid conversation_participant_keys");
  }
  const signatures = actionSignatures(value.action_signatures);
  if (signatures.length !== 1) throw new Error("Invalid action_signatures");
  return {
    conversation_key_version: required(value.conversation_key_version, "conversation_key_version"),
    conversation_participant_keys: participantKeys,
    action_signatures: signatures,
  };
}

export function actionSignatures(value, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) throw new Error("Invalid action_signatures");
  for (const action of value) {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Invalid action_signatures");
    required(action.message_id, "message_id");
    required(action.encoded_message_event_detail, "encoded_message_event_detail");
    const signature = action.message_event_signature;
    if (!signature || typeof signature !== "object" || Array.isArray(signature))
      throw new Error("Invalid message_event_signature");
    required(signature.signature, "signature");
    required(signature.signature_version, "signature_version");
    required(signature.public_key_version, "public_key_version");
    required(signature.signing_public_key, "signing_public_key");
  }
  return value;
}

export function rotationData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid group_key_rotation_data");
  const participantKeys = value.conversation_participant_keys;
  if (!Array.isArray(participantKeys) || !participantKeys.length)
    throw new Error("Invalid conversation_participant_keys");
  const participantIds = participantKeys.map((key) => {
    if (!key || typeof key !== "object" || Array.isArray(key)) throw new Error("Invalid conversation_participant_keys");
    required(key.encrypted_conversation_key, "encrypted_conversation_key");
    required(key.public_key_version, "public_key_version");
    return userId(key.user_id);
  });
  if (new Set(participantIds).size !== participantIds.length) throw new Error("Invalid conversation_participant_keys");
  return {
    conversationKeyVersion: required(value.conversation_key_version, "conversation_key_version"),
    participantIds,
  };
}

export function groupMemberMutationPayload(value, operation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid group member request");
  const members = stringList(value.user_ids, "user_ids", userId);
  const rotation =
    operation === "remove"
      ? rotationData(value.group_key_rotation_data)
      : rotationData({
          conversation_key_version: value.conversation_key_version,
          conversation_participant_keys: value.conversation_participant_keys,
        });
  return {
    conversationId: identifier(value.conversation_id, "conversation_id"),
    expectedKeyVersion: required(value.expected_key_version, "expected_key_version"),
    userIds: members,
    ...rotation,
    actionSignatures: actionSignatures(value.action_signatures, operation === "add" ? 2 : 1),
  };
}

export function mockIdentityPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mock identity");
  const publicKey = value.public_key;
  if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) throw new Error("Invalid public_key");
  return {
    userId: userId(value.user_id),
    record: {
      public_key_version: "1",
      public_key: required(publicKey.publicKey, "public_key"),
      signing_public_key: required(publicKey.signingPublicKey, "signing_public_key"),
      identity_public_key_signature: required(publicKey.identityPublicKeySignature, "identity_public_key_signature"),
    },
  };
}

export function mockNetworkPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mock network settings");
  if (typeof value.offline !== "boolean") throw new Error("Invalid offline");
  if (!["normal", "reverse"].includes(value.order)) throw new Error("Invalid delivery order");
  if (typeof value.duplicate !== "boolean") throw new Error("Invalid duplicate");
  return { offline: value.offline, order: value.order, duplicate: value.duplicate };
}
