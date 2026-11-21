import { normalizeUsername } from "../public/contact-lookup.mjs";
import { isCanonicalDirectConversationId } from "../public/direct-conversation-id.mjs";

const USER_ID_PATTERN = /^\d{1,19}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

function httpError(message, status, retryable = false) {
  return Object.assign(new Error(message), { status, retryable });
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw httpError(`Invalid ${name}`, 400);
  return value;
}

function validUserId(value, name) {
  const text = requiredString(value, name);
  if (!USER_ID_PATTERN.test(text)) throw httpError(`Invalid ${name}`, 400);
  return text;
}

function exactConversationId(ownerUserId, recipientUserId, conversationId) {
  return isCanonicalDirectConversationId(conversationId, ownerUserId, recipientUserId);
}

function requestBody(value, ownerUserId, recipientUserId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError("Invalid direct conversation keys request", 400);
  }
  const allowedFields = new Set(["conversation_key_version", "conversation_participant_keys", "action_signatures"]);
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw httpError("Unexpected direct conversation keys field", 400);
  }
  requiredString(value.conversation_key_version, "conversation_key_version");

  const participantKeys = value.conversation_participant_keys;
  if (!Array.isArray(participantKeys) || participantKeys.length !== 2) {
    throw httpError("Invalid conversation_participant_keys", 400);
  }
  const participantIds = participantKeys.map((key) => {
    if (!key || typeof key !== "object" || Array.isArray(key)) {
      throw httpError("Invalid conversation_participant_keys", 400);
    }
    const userId = validUserId(key.user_id, "participant user_id");
    const encryptedKey = requiredString(key.encrypted_conversation_key, "encrypted_conversation_key");
    const publicKeyVersion = requiredString(key.public_key_version, "participant public_key_version");
    if (!BASE64_PATTERN.test(encryptedKey) || !/^\d+$/.test(publicKeyVersion)) {
      throw httpError("Invalid participant key wrap", 400);
    }
    return userId;
  });
  if (
    new Set(participantIds).size !== 2 ||
    !participantIds.includes(ownerUserId) ||
    !participantIds.includes(recipientUserId)
  ) {
    throw httpError("Participant keys do not match the authenticated accounts", 400);
  }

  const signatures = value.action_signatures;
  if (!Array.isArray(signatures) || signatures.length !== 1) {
    throw httpError("Invalid action_signatures", 400);
  }
  const action = signatures[0];
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw httpError("Invalid action_signatures", 400);
  }
  requiredString(action.message_id, "message_id");
  const eventDetail = requiredString(action.encoded_message_event_detail, "encoded_message_event_detail");
  if (!BASE64_PATTERN.test(eventDetail)) throw httpError("Invalid encoded_message_event_detail", 400);
  const signature = action.message_event_signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    throw httpError("Invalid message_event_signature", 400);
  }
  const signatureValue = requiredString(signature.signature, "signature");
  const signatureVersion = requiredString(signature.signature_version, "signature_version");
  const signingKeyVersion = requiredString(signature.public_key_version, "signature public_key_version");
  const signingPublicKey = requiredString(signature.signing_public_key, "signing_public_key");
  if (
    !BASE64_PATTERN.test(signatureValue) ||
    !/^\d+$/.test(signatureVersion) ||
    !/^\d+$/.test(signingKeyVersion) ||
    !BASE64_PATTERN.test(signingPublicKey)
  ) {
    throw httpError("Invalid action signature", 400);
  }
  return { participantKeys, action, signingKeyVersion };
}

function recordsFrom(value) {
  const records = value?.data ?? value;
  if (!Array.isArray(records) || !records.length) throw httpError("Registered public keys are unavailable", 403);
  return records;
}

function lookupState(snapshot) {
  const result = snapshot?.conversations ?? snapshot;
  if (
    !result ||
    typeof result !== "object" ||
    !["available", "existing", "ambiguous", "incomplete", "error"].includes(snapshot?.lookup)
  ) {
    throw httpError("Conversation lookup result is malformed", 503, true);
  }
  if (snapshot.lookup === "existing" || snapshot.lookup === "ambiguous") {
    throw httpError("An existing or ambiguous direct conversation blocks creation", 409, true);
  }
  if (snapshot.lookup !== "available" || !Array.isArray(result.data) || result.data.length !== 0) {
    throw httpError("A complete no-room result could not be verified", 503, true);
  }
}

/** @type {(input: unknown) => boolean | Promise<boolean>} */
const denyAuthorization = () => false;
/** @type {(input: unknown) => Promise<void>} */
const noAuthorizationClaim = async () => {};

export function createLiveDirectCreateAdapter({
  isAuthorized = denyAuthorization,
  claimAuthorization = noAuthorizationClaim,
  getAuthenticatedUser,
  lookupRecipient,
  lookupDirectConversations,
  getPublicKeys,
  verifyKeyBinding,
  post,
}) {
  const claimedAttempts = new Set();

  async function verifiedKeyRecord(userId, version) {
    const records = recordsFrom(await getPublicKeys(userId));
    const matching = records.filter((record) => String(record?.public_key_version ?? "") === version);
    if (matching.length !== 1) throw httpError("Registered key version is missing or ambiguous", 403);
    const record = matching[0];
    const identityPublicKey = requiredString(record.public_key, "registered public_key");
    const signingPublicKey = requiredString(record.signing_public_key, "registered signing_public_key");
    const identitySignature = requiredString(record.identity_public_key_signature, "identity_public_key_signature");
    let bindingVerified = false;
    try {
      bindingVerified =
        typeof verifyKeyBinding === "function" &&
        (await verifyKeyBinding(identityPublicKey, signingPublicKey, identitySignature)) === true;
    } catch {
      bindingVerified = false;
    }
    if (!bindingVerified) {
      throw httpError("Registered public-key binding did not verify", 403);
    }
    return { publicKeyVersion: version, identityPublicKey, signingPublicKey };
  }

  async function requireNoExistingConversation(ownerUserId, recipientUserId) {
    const snapshot = await lookupDirectConversations(ownerUserId, recipientUserId);
    lookupState(snapshot);
  }

  return {
    async initialize(input = {}) {
      if ((await isAuthorized(input)) !== true) {
        throw httpError("Live direct-conversation initialization is disabled", 501);
      }

      if (input.recipient_consent_confirmed !== true || input.final_approval_confirmed !== true) {
        throw httpError("Recipient consent and separate final approval are required", 400);
      }
      const ownerUserId = validUserId(input.owner_user_id, "owner_user_id");
      const recipientUserId = validUserId(input.recipient_user_id, "recipient_user_id");
      const recipientUsername = normalizeUsername(input.recipient_username);
      const conversationId = requiredString(input.conversation_id, "conversation_id");
      if (ownerUserId === recipientUserId || !exactConversationId(ownerUserId, recipientUserId, conversationId)) {
        throw httpError("Recipient or canonical conversation ID mismatch", 400);
      }
      const ownerSigningKeyVersion = requiredString(input.owner_signing_key_version, "owner_signing_key_version");
      if (!/^\d+$/.test(ownerSigningKeyVersion)) throw httpError("Invalid owner_signing_key_version", 400);
      const parsed = requestBody(input.request_body, ownerUserId, recipientUserId);
      if (parsed.signingKeyVersion !== ownerSigningKeyVersion) {
        throw httpError("Action signature is not bound to the unlocked signing-key version", 403);
      }
      const attemptKey = `${ownerUserId}:${recipientUserId}:${conversationId}`;
      if (claimedAttempts.has(attemptKey)) throw httpError("Live create attempt is already claimed", 409, true);
      claimedAttempts.add(attemptKey);

      const account = await getAuthenticatedUser();
      if (String(account?.id ?? "") !== ownerUserId) {
        throw httpError("Authenticated X account does not match the unlocked account", 403);
      }
      const recipient = await lookupRecipient(recipientUsername);
      if (
        String(recipient?.id ?? "") !== recipientUserId ||
        normalizeUsername(recipient?.username) !== recipientUsername
      ) {
        throw httpError("Recipient ID or normalized username changed", 409, true);
      }
      if (recipient?.receives_your_chat !== "encrypted") {
        throw httpError("Recipient does not accept encrypted chats", 403);
      }

      const ownerKeyVersion = parsed.participantKeys.find((key) => key.user_id === ownerUserId)?.public_key_version;
      const recipientKeyVersion = parsed.participantKeys.find(
        (key) => key.user_id === recipientUserId,
      )?.public_key_version;
      if (ownerKeyVersion !== ownerSigningKeyVersion) {
        throw httpError("Owner key wrap does not use the unlocked signing-key version", 403);
      }
      const ownerKey = await verifiedKeyRecord(ownerUserId, ownerSigningKeyVersion);
      const recipientKey = await verifiedKeyRecord(recipientUserId, recipientKeyVersion);
      let actionKeyBound = false;
      try {
        actionKeyBound =
          parsed.action.message_event_signature.public_key_version === ownerKey.publicKeyVersion &&
          (await verifyKeyBinding(
            ownerKey.identityPublicKey,
            parsed.action.message_event_signature.signing_public_key,
            recordsFrom(await getPublicKeys(ownerUserId)).find(
              (record) => String(record?.public_key_version ?? "") === ownerSigningKeyVersion,
            )?.identity_public_key_signature ?? "",
          )) === true;
      } catch {
        actionKeyBound = false;
      }
      if (!actionKeyBound) {
        throw httpError("Action signature does not match the registered owner signing key", 403);
      }

      await requireNoExistingConversation(ownerUserId, recipientUserId);

      const currentAccount = await getAuthenticatedUser();
      if (String(currentAccount?.id ?? "") !== ownerUserId) {
        throw httpError("Authenticated X account changed before create", 403);
      }
      const currentRecipient = await lookupRecipient(recipientUsername);
      if (
        String(currentRecipient?.id ?? "") !== recipientUserId ||
        normalizeUsername(currentRecipient?.username) !== recipientUsername ||
        currentRecipient?.receives_your_chat !== "encrypted"
      ) {
        throw httpError("Recipient identity or encrypted-chat permission changed before create", 409, true);
      }
      const currentOwnerKey = await verifiedKeyRecord(ownerUserId, ownerSigningKeyVersion);
      const currentRecipientKey = await verifiedKeyRecord(recipientUserId, recipientKeyVersion);
      if (
        currentOwnerKey.signingPublicKey !== ownerKey.signingPublicKey ||
        currentOwnerKey.identityPublicKey !== ownerKey.identityPublicKey ||
        currentRecipientKey.identityPublicKey !== recipientKey.identityPublicKey
      ) {
        throw httpError("A registered participant key changed before create", 409, true);
      }
      await requireNoExistingConversation(ownerUserId, recipientUserId);

      await claimAuthorization(input);

      let acknowledgement;
      try {
        acknowledgement = await post(`/2/chat/conversations/${recipientUserId}/keys`, input.request_body, {
          conversationId,
        });
      } catch (error) {
        const status = Number(error?.status || 0);
        if (status === 401 || status === 403) throw httpError("X rejected the create request", status);
        if (status === 408 || status === 409 || status === 429 || status >= 500 || !status) {
          throw httpError("Live create outcome requires reconciliation", status || 502, true);
        }
        throw httpError("X rejected the create request", status);
      }

      if (
        !acknowledgement ||
        typeof acknowledgement !== "object" ||
        Array.isArray(acknowledgement) ||
        (acknowledgement.errors !== undefined &&
          (!Array.isArray(acknowledgement.errors) || acknowledgement.errors.length > 0)) ||
        acknowledgement.data?.conversation_id !== conversationId ||
        (acknowledgement.data?.sequence_id !== undefined &&
          (typeof acknowledgement.data.sequence_id !== "string" || !acknowledgement.data.sequence_id))
      ) {
        throw httpError("X acknowledgement did not confirm the expected conversation", 502, true);
      }
      return { data: acknowledgement.data };
    },
  };
}
