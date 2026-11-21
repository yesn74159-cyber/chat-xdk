const USER_ID = /^\d{1,19}$/;

function requiredString(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function userIds(values, name) {
  if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length)
    throw new Error(`Invalid ${name}`);
  return values.map((value) => {
    const id = requiredString(value, name);
    if (!USER_ID.test(id)) throw new Error(`Invalid ${name}`);
    return id;
  });
}

function participantKeys(prepared) {
  if (!Array.isArray(prepared?.conversationParticipantKeys) || !prepared.conversationParticipantKeys.length) {
    throw new Error("Invalid prepared group change");
  }
  return prepared.conversationParticipantKeys.map((entry) => ({
    user_id: userIds([entry.userId], "participant user ID")[0],
    encrypted_conversation_key: requiredString(entry.encryptedConversationKey, "encrypted_conversation_key"),
    public_key_version: requiredString(entry.publicKeyVersion, "public_key_version"),
  }));
}

function actionSignatures(prepared, minimum) {
  if (!Array.isArray(prepared?.actionSignatures) || prepared.actionSignatures.length < minimum) {
    throw new Error("Invalid prepared group change");
  }
  return prepared.actionSignatures.map((action) => ({
    message_id: requiredString(action.messageId, "message_id"),
    encoded_message_event_detail: requiredString(action.encodedMessageEventDetail, "encoded_message_event_detail"),
    message_event_signature: {
      signature: requiredString(action.messageEventSignature?.signature, "signature"),
      signature_version: requiredString(action.messageEventSignature?.signatureVersion, "signature_version"),
      public_key_version: requiredString(action.messageEventSignature?.publicKeyVersion, "public_key_version"),
      signing_public_key: requiredString(action.messageEventSignature?.signingPublicKey, "signing_public_key"),
    },
  }));
}

function baseRotation(prepared) {
  return {
    conversation_key_version: requiredString(prepared?.conversationKeyVersion, "conversation_key_version"),
    conversation_participant_keys: participantKeys(prepared),
  };
}

/** Map the XDK's signed add-members output without serializing the raw conversation key. */
export function groupMembersAddRequest(prepared, addedUserIds, expectedKeyVersion) {
  const user_ids = userIds(addedUserIds, "user_ids");
  return {
    conversation_id: requiredString(prepared?.conversationId, "conversation_id"),
    expected_key_version: requiredString(expectedKeyVersion, "expected_key_version"),
    user_ids,
    ...baseRotation(prepared),
    ...(prepared.encryptedTitle ? { encrypted_title: requiredString(prepared.encryptedTitle, "encrypted_title") } : {}),
    action_signatures: actionSignatures(prepared, 2),
  };
}

/** Map removal rotation data separately, matching the X endpoint's remove contract. */
export function groupMembersRemoveRequest(prepared, removedUserIds, expectedKeyVersion) {
  return {
    conversation_id: requiredString(prepared?.conversationId, "conversation_id"),
    expected_key_version: requiredString(expectedKeyVersion, "expected_key_version"),
    user_ids: userIds(removedUserIds, "user_ids"),
    action_signatures: actionSignatures(prepared, 1),
    group_key_rotation_data: baseRotation(prepared),
  };
}
