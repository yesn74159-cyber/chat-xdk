import {
  canOpenConversation,
  conversationIdOf,
  conversationTypeOf,
  verifiedRecipientId,
} from "./conversation-list.mjs";

const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

export function normalizeUsername(value) {
  if (typeof value !== "string") throw new Error("กรอก Username ที่ต้องการค้นหา");
  const username = value.trim().replace(/^@/, "");
  if (!USERNAME_PATTERN.test(username)) throw new Error("Username ต้องมี 1–15 ตัวและใช้ได้เฉพาะตัวอักษร ตัวเลข หรือ _");
  return username.toLowerCase();
}

export function permissionForEncryptedChat(value) {
  if (value === "encrypted") return "encrypted";
  if (value === "unencrypted") return "unencrypted";
  if (value === "none") return "none";
  return "unknown";
}

export function canConfirmDirectChat(contact, mode, identityUnlocked, consentChecked = false) {
  return Boolean(
    contact?.identityVerified &&
      contact.conversationLookup === "available" &&
      contact.existing?.status === "not_found" &&
      contact.permission === "encrypted" &&
      contact.keyStatus === "verified" &&
      contact.retryBlocked !== true &&
      identityUnlocked &&
      mode === "mock" &&
      consentChecked,
  );
}

export function claimDirectChatAttempt(state) {
  if (state.startingDirectChat) return false;
  state.startingDirectChat = true;
  return true;
}

export function requiresExplicitDirectLookup(status) {
  const code = Number(status || 0);
  return code === 408 || code === 409 || code === 429 || code >= 500 || code === 0;
}

export function isCurrentOAuthIdentity(expectedUserId, currentUserId, unlockedUserId) {
  return (
    /^\d{1,19}$/.test(String(currentUserId ?? "")) &&
    String(currentUserId) === expectedUserId &&
    unlockedUserId === expectedUserId
  );
}

export function matchesDirectChatRecipient(expected, actual) {
  const expectedId = String(expected?.id ?? "");
  const actualId = String(actual?.id ?? "");
  if (!/^\d{1,19}$/.test(expectedId) || actualId !== expectedId || typeof actual?.username !== "string") {
    return false;
  }
  try {
    return normalizeUsername(actual.username) === normalizeUsername(expected.username);
  } catch {
    return false;
  }
}

export function zeroizePreparedDirectChat(prepared) {
  prepared?.conversationKey?.fill(0);
}

function hasCanonicalPair(conversation, authenticatedUserId, recipientId) {
  const pair = conversationIdOf(conversation).split(/[:-]/);
  return (
    pair.length === 2 &&
    pair.every((id) => /^\d{1,19}$/.test(id)) &&
    new Set(pair).size === 2 &&
    pair.includes(authenticatedUserId) &&
    pair.includes(recipientId)
  );
}

export function findExistingDirectConversation(conversations, authenticatedUserId, recipientId) {
  const matches = new Map();
  for (const conversation of Array.isArray(conversations) ? conversations : []) {
    const id = conversationIdOf(conversation);
    if (
      !id ||
      conversationTypeOf(conversation) !== "direct" ||
      verifiedRecipientId(conversation, authenticatedUserId) !== recipientId ||
      !hasCanonicalPair(conversation, authenticatedUserId, recipientId) ||
      !canOpenConversation(conversation, authenticatedUserId)
    ) {
      continue;
    }
    matches.set(id, conversation);
  }
  const values = [...matches.values()];
  if (!values.length) return { status: "not_found", conversation: null };
  if (values.length === 1) return { status: "found", conversation: values[0] };
  return { status: "ambiguous", conversation: null, matches: values };
}

export function resolveExistingDirectConversation(
  serverConversations,
  inboxConversations,
  authenticatedUserId,
  recipientId,
  lookupStatus,
) {
  const knownMatches = findExistingDirectConversation(
    [
      ...(Array.isArray(serverConversations) ? serverConversations : []),
      ...(Array.isArray(inboxConversations) ? inboxConversations : []),
    ],
    authenticatedUserId,
    recipientId,
  );
  if (knownMatches.status === "ambiguous") return knownMatches;

  const inboxMatch = findExistingDirectConversation(inboxConversations, authenticatedUserId, recipientId);
  if (inboxMatch.status === "found") return inboxMatch;

  const serverMatch = findExistingDirectConversation(serverConversations, authenticatedUserId, recipientId);
  if (lookupStatus === "existing" && serverMatch.status === "found") return serverMatch;
  return { status: "not_found", conversation: null };
}

export function createLookupEpoch() {
  let epoch = 0;
  return {
    begin() {
      epoch += 1;
      return epoch;
    },
    invalidate() {
      epoch += 1;
    },
    isCurrent(value) {
      return value === epoch;
    },
  };
}
