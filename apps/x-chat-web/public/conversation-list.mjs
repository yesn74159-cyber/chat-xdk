const USER_ID_PATTERN = /^\d{1,19}$/;

export function conversationIdOf(conversation) {
  const id = conversation?.id ?? conversation?.conversation_id ?? conversation?.conversationId;
  return typeof id === "string" ? id.trim() : "";
}

export function conversationTypeOf(conversation) {
  const type =
    conversation?.type ?? conversation?.conversation_type ?? conversation?.conversationType ?? conversation?.kind;
  if (type === "direct" || type === "1:1") return "direct";
  if (type === "group") return "group";
  return "";
}

function participantIdsOf(conversation) {
  const value =
    conversation?.participant_ids ??
    conversation?.participantIds ??
    conversation?.member_ids ??
    conversation?.memberIds;
  if (!Array.isArray(value) || value.length < 1) return [];
  if (!value.every((id) => typeof id === "string" && USER_ID_PATTERN.test(id))) return [];
  if (new Set(value).size !== value.length) return [];
  return [...value];
}

export function verifiedRecipientId(conversation, authenticatedUserId) {
  if (conversationTypeOf(conversation) !== "direct") return "";
  if (typeof authenticatedUserId !== "string" || !USER_ID_PATTERN.test(authenticatedUserId)) return "";
  const participantIds = participantIdsOf(conversation);
  if (participantIds.length === 1) {
    const recipientId = participantIds[0];
    if (recipientId === authenticatedUserId) return "";
    if (conversation?.recipient_verified === true && conversation?.recipient_id === recipientId) return recipientId;
    const canonicalIds = conversationIdOf(conversation).split(/[:-]/);
    if (
      canonicalIds.length === 2 &&
      canonicalIds.every((id) => USER_ID_PATTERN.test(id)) &&
      canonicalIds[0] !== canonicalIds[1] &&
      canonicalIds.includes(authenticatedUserId) &&
      canonicalIds.includes(recipientId)
    ) {
      return recipientId;
    }
    return "";
  }
  if (participantIds.length !== 2 || !participantIds.includes(authenticatedUserId)) return "";
  return participantIds.find((id) => id !== authenticatedUserId) ?? "";
}

export function canOpenConversation(conversation, authenticatedUserId) {
  return Boolean(conversationIdOf(conversation) && verifiedRecipientId(conversation, authenticatedUserId));
}

export function mapConversationResponse(response, authenticatedUserId) {
  const records = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
  const profiles = new Map();
  for (const profile of Array.isArray(response?.includes?.users) ? response.includes.users : []) {
    if (!profile || typeof profile.id !== "string" || !USER_ID_PATTERN.test(profile.id)) continue;
    profiles.set(profile.id, profiles.has(profile.id) ? null : profile);
  }

  return records
    .filter((record) => record && typeof record === "object" && !Array.isArray(record))
    .map((record) => {
      const apiId = conversationIdOf(record);
      const type = conversationTypeOf(record);
      const participantIds = participantIdsOf(record);
      const selfConversation =
        type === "direct" && participantIds.length === 1 && participantIds[0] === authenticatedUserId;
      let recipientId = verifiedRecipientId({ ...record, type, participant_ids: participantIds }, authenticatedUserId);
      const id = apiId || (recipientId && participantIds.length === 2 ? participantIds.join("-") : "");
      const profile = recipientId ? profiles.get(recipientId) : null;
      const name = typeof profile?.name === "string" ? profile.name.trim() : "";
      const username = typeof profile?.username === "string" ? profile.username.trim() : "";
      let profileImageUrl = "";
      if (typeof profile?.profile_image_url === "string") {
        try {
          const imageUrl = new URL(profile.profile_image_url);
          if (imageUrl.protocol === "https:" && imageUrl.hostname === "pbs.twimg.com") {
            profileImageUrl = imageUrl.href;
          }
        } catch {
          profileImageUrl = "";
        }
      }

      return {
        id,
        type,
        self_conversation: selfConversation,
        participant_ids: participantIds,
        recipient_id: recipientId,
        recipient_verified: Boolean(recipientId),
        recipient_name: name,
        recipient_username: username,
        recipient_profile_image_url: profileImageUrl,
        key_version: record.key_version ?? record.conversation_key_version ?? "",
        unread: record.unread ?? false,
        updated_at: record.updated_at ?? record.updatedAt ?? "",
      };
    });
}
