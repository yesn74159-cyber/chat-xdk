// Pages through /2/chat/conversations to decide whether a direct conversation
// with one recipient already exists. Any ambiguous upstream shape is reported
// as "incomplete" instead of guessing, because a wrong "available" answer would
// make the client open a second conversation for the same pair.

import { UpstreamError } from "./upstream.mjs";

export function upstreamErrorCategory(status) {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream" : "request_failed";
}

export function isCanonicalDirectConversationId(value, authenticatedUserId, recipientId) {
  if (typeof value !== "string") return false;
  const participants = value.split(/[:-]/);
  return (
    participants.length === 2 &&
    participants.every((id) => /^\d{1,19}$/.test(id)) &&
    new Set(participants).size === 2 &&
    participants.includes(authenticatedUserId) &&
    participants.includes(recipientId)
  );
}

export async function lookupDirectConversations(adapterJson, authenticatedUserId, recipientId) {
  const matches = new Map();
  const users = new Map();
  const seenTokens = new Set();
  let paginationToken = "";
  let lookup = "incomplete";
  let error = null;
  let uncertain = false;

  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const params = new URLSearchParams({
      max_results: "100",
      "chat_conversation.fields": "id,type,unread,updated_at",
      expansions: "participant_ids",
      "user.fields": "id,name,username,profile_image_url,receives_your_chat",
    });
    if (paginationToken) params.set("pagination_token", paginationToken);

    let page;
    try {
      page = await adapterJson(`/2/chat/conversations?${params}`);
    } catch (cause) {
      if (!(cause instanceof UpstreamError)) throw cause;
      const status = Number.isInteger(cause.status) && cause.status >= 400 && cause.status <= 599 ? cause.status : 502;
      error = { category: upstreamErrorCategory(status), status };
      lookup = "error";
      break;
    }

    if (
      !Array.isArray(page?.data) ||
      page.data.length > 100 ||
      !page?.meta ||
      typeof page.meta !== "object" ||
      typeof page.meta.has_more !== "boolean"
    ) {
      break;
    }
    for (const conversation of page.data) {
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
        uncertain = true;
        continue;
      }
      const id = typeof conversation.id === "string" ? conversation.id : "";
      if (!id || (conversation.type !== "direct" && conversation.type !== "group")) {
        uncertain = true;
        continue;
      }
      if (conversation.type !== "direct") continue;

      const participantIds = conversation.participant_ids ?? conversation.member_ids;
      if (
        !Array.isArray(participantIds) ||
        !participantIds.every((value) => typeof value === "string" && /^\d{1,19}$/.test(value)) ||
        new Set(participantIds).size !== participantIds.length
      ) {
        uncertain = true;
        continue;
      }
      const canonicalIds = id.split(/[:-]/);
      if (participantIds.length === 1 && participantIds[0] === authenticatedUserId) {
        if (
          canonicalIds.length === 2 &&
          canonicalIds.every((value) => /^\d{1,19}$/.test(value) && value === authenticatedUserId)
        ) {
          continue;
        }
        uncertain = true;
        continue;
      }
      if (
        canonicalIds.length !== 2 ||
        !canonicalIds.every((value) => /^\d{1,19}$/.test(value)) ||
        new Set(canonicalIds).size !== 2
      ) {
        uncertain = true;
        continue;
      }
      const hasSelf = participantIds.includes(authenticatedUserId);
      const hasRecipient = participantIds.includes(recipientId);
      const canonicalHasSelf = canonicalIds.includes(authenticatedUserId);
      const canonicalHasRecipient = canonicalIds.includes(recipientId);
      if (participantIds.length === 1) {
        if (participantIds[0] === recipientId) {
          if (!isCanonicalDirectConversationId(id, authenticatedUserId, recipientId)) {
            uncertain = true;
            continue;
          }
        } else if (canonicalHasSelf && !canonicalHasRecipient && canonicalIds.includes(participantIds[0])) {
          continue;
        } else {
          uncertain = true;
          continue;
        }
      } else if (participantIds.length === 2) {
        if (hasRecipient || canonicalHasRecipient) {
          if (!hasSelf || !hasRecipient || !isCanonicalDirectConversationId(id, authenticatedUserId, recipientId)) {
            uncertain = true;
            continue;
          }
        } else if (canonicalHasSelf && hasSelf && canonicalIds.every((value) => participantIds.includes(value))) {
          continue;
        } else {
          uncertain = true;
          continue;
        }
      } else {
        uncertain = true;
        continue;
      }
      const canonicalId = id.replaceAll("-", ":");
      const previous = matches.get(canonicalId);
      if (previous && JSON.stringify(previous.participant_ids) !== JSON.stringify(participantIds)) uncertain = true;
      else matches.set(canonicalId, conversation);
    }
    for (const user of Array.isArray(page.includes?.users) ? page.includes.users : []) {
      if (typeof user?.id === "string") users.set(user.id, user);
    }

    if (page.meta.has_more === false && page.meta.next_token === undefined) {
      lookup = uncertain ? "incomplete" : matches.size > 1 ? "ambiguous" : matches.size ? "existing" : "available";
      break;
    }
    if (page.meta.has_more !== true || typeof page.meta.next_token !== "string" || !page.meta.next_token) break;
    if (seenTokens.has(page.meta.next_token)) break;
    seenTokens.add(page.meta.next_token);
    paginationToken = page.meta.next_token;
  }

  return {
    conversations: {
      data: lookup === "existing" || lookup === "ambiguous" ? [...matches.values()] : [],
      includes: { users: [...users.values()] },
    },
    lookup,
    error,
  };
}
