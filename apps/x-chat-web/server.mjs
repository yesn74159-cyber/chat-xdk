import { createReadStream } from "node:fs";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchX, MAX_X_MEDIA_RESPONSE_BYTES, readXJson, UpstreamError } from "./lib/upstream.mjs";
import { conversationEventsPath } from "./lib/chat-events.mjs";
import { juiceboxConfiguration } from "./lib/juicebox-config.mjs";
import { mockUsernameAlias } from "./lib/mock-username.mjs";
import { normalizeUsername } from "./public/contact-lookup.mjs";
import { createChat } from "@xdevplatform/chat-xdk";
import { createLiveDirectCreateAdapter } from "./lib/live-direct-create.mjs";
import { createLiveCreatePermit } from "./lib/live-create-permit.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const staticDir = resolve(root, "node_modules/.cache/x-chat-web");
const sdkDir = resolve(root, "node_modules/@xdevplatform/chat-xdk");
let port = Number(process.env.PORT || 8787);
const token = process.env.X_ACCESS_TOKEN || "";
const mode = process.env.X_CHAT_API_MODE || "live";
const xBase = "https://api.x.com";
const maxBody = 5 * 1024 * 1024;
let juiceboxPolicyOrigins = [];

function securityHeaders() {
  return {
    "content-security-policy": `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: https://pbs.twimg.com; connect-src 'self' ${xBase} ${juiceboxPolicyOrigins.join(" ")}; object-src 'none'`,
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}
const routeMethods = {
  "/api/status": ["GET"],
  "/api/me": ["GET"],
  "/api/public-keys": ["GET"],
  "/api/contacts/lookup": ["GET"],
  "/api/juicebox/config": ["GET"],
  "/api/conversations": ["GET"],
  "/api/conversations/initialize": ["POST"],
  "/api/mock/live-create": ["POST"],
  "/api/mock/live-create/requests": ["GET"],
  "/api/conversations/read": ["POST"],
  "/api/mock/identity": ["POST"],
  "/api/mock/deliveries": ["GET"],
  "/api/mock/network": ["POST"],
  "/api/group/roster": ["GET"],
  "/api/group/members/add": ["POST"],
  "/api/group/members/remove": ["POST"],
  "/api/group/initialize": ["POST"],
  "/api/group/create": ["POST"],
  "/api/events": ["GET"],
  "/api/send": ["POST"],
  "/api/media/initialize": ["POST"],
  "/api/media/append": ["POST"],
  "/api/media/finalize": ["POST"],
  "/api/media/download": ["GET"],
};
const mockFixture =
  mode === "mock" && process.env.X_CHAT_MOCK_FIXTURE ? JSON.parse(process.env.X_CHAT_MOCK_FIXTURE) : {};
const mock = {
  media: new Map(),
  sends: [],
  groups: new Map(),
  conversations: new Map(),
  liveCreateRequests: [],
  deliveries: [],
  nextDeliveryId: 1,
  network: { offline: false, order: "normal", duplicate: false },
  nextGroupId: 1,
  keyInitializationAttempts: new Map(),
  conversationLookupRecipientId: "",
  user: mockFixture.user || { id: "1000000000000000001" },
  users: new Map(),
  publicKeys: mockFixture.publicKeys || {},
  conversationKeyEvents: mockFixture.conversationKeyEvents || {},
  eventPageSize:
    Number.isSafeInteger(mockFixture.eventPageSize) && mockFixture.eventPageSize > 0 ? mockFixture.eventPageSize : 0,
};
const liveCreatePermit = createLiveCreatePermit();
mock.users.set(String(mock.user.id), mock.user);
for (const user of Object.values(mockFixture.users || {})) {
  if (user && typeof user.id === "string") mock.users.set(user.id, user);
}
for (const conversation of mockFixture.conversations || []) {
  if (conversation && typeof conversation.conversationId === "string") {
    mock.conversations.set(conversation.conversationId, conversation);
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body.error && body.retryable === undefined ? { ...body, retryable: false } : body));
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${name}`);
  return value;
}

function identifier(value, name) {
  const text = required(value, name);
  if (!/^[A-Za-z0-9_:.-]+$/.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}

function mediaSegmentIndex(value) {
  const index = nonNegativeInteger(value, "segment_index");
  if (index > 999) throw new Error("Invalid segment_index");
  return index;
}

function base64(value, name) {
  const text = required(value, name);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error(`Invalid ${name}`);
  }
  return text;
}

function paginationToken(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 2048) throw new Error("Invalid pagination_token");
  return value;
}

function userId(value, name = "user_id") {
  const text = required(value, name);
  if (!/^\d{1,19}$/.test(text)) throw new Error(`Invalid ${name}`);
  return text;
}

function stringList(value, name, item = required) {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new Error(`Invalid ${name}`);
  const values = value.map((entry) => item(entry, name));
  if (new Set(values).size !== values.length) throw new Error(`Invalid ${name}`);
  return values;
}

function groupCreatePayload(value) {
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

function directConversationKeysPayload(value, authenticatedUserId, recipientId, conversationId) {
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

function actionSignatures(value, minimum = 1) {
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

function rotationData(value) {
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

function groupMemberMutationPayload(value, operation) {
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

function mockIdentityPayload(value) {
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

function mockNetworkPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid mock network settings");
  if (typeof value.offline !== "boolean") throw new Error("Invalid offline");
  if (!["normal", "reverse"].includes(value.order)) throw new Error("Invalid delivery order");
  if (typeof value.duplicate !== "boolean") throw new Error("Invalid duplicate");
  return { offline: value.offline, order: value.order, duplicate: value.duplicate };
}

function ensureMockConversation(conversationId) {
  let conversation = mock.conversations.get(conversationId);
  if (!conversation) {
    const directParticipants = conversationId.match(/^(\d{1,19})[:-](\d{1,19})$/);
    conversation = {
      conversationId,
      kind: conversationId.startsWith("g") ? "group" : "direct",
      memberIds: directParticipants ? [directParticipants[1], directParticipants[2]] : [],
      adminIds: [],
      unread: 0,
      updatedAt: new Date(0).toISOString(),
    };
    mock.conversations.set(conversationId, conversation);
  }
  return conversation;
}

function recordMockDelivery(conversationId, eventB64) {
  mock.deliveries.push({
    delivery_id: `mock-delivery-${mock.nextDeliveryId++}`,
    conversation_id: conversationId,
    encoded_event: eventB64,
    event_type: "chat.sent",
  });
}

async function bodyJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) {
      const error = Object.assign(new Error("Request body too large"), { status: 413 });
      throw error;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function xRequest(path, options = {}) {
  if (!token) throw new UpstreamError("X_ACCESS_TOKEN is not configured on this local server", { status: 503 });
  return fetchX({ baseUrl: xBase, path, token, options });
}

async function xJson(path, method = "GET", data) {
  const response = await xRequest(path, {
    method,
    ...(data === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        }),
  });
  return readXJson(response);
}

async function authenticatedJuiceboxConfig() {
  const meResponse = await adapterJson("/2/users/me");
  const account = meResponse?.data;
  const accountId = userId(String(account?.id ?? ""), "authenticated user ID");
  const fields = new URLSearchParams({
    "public_key.fields":
      "identity_public_key_signature,juicebox_config,public_key,public_key_version,signing_public_key",
  });
  const keysResponse = await adapterJson(`/2/users/${encodeURIComponent(accountId)}/public_keys?${fields}`);
  const keyRecords = Array.isArray(keysResponse?.data)
    ? keysResponse.data
    : keysResponse?.data
      ? [keysResponse.data]
      : [];
  const configured = juiceboxConfiguration(keyRecords);
  const policyChanged =
    configured.origins.length !== juiceboxPolicyOrigins.length ||
    configured.origins.some((origin, index) => origin !== juiceboxPolicyOrigins[index]);
  juiceboxPolicyOrigins = configured.origins;
  return {
    account: {
      id: accountId,
      username: typeof account.username === "string" ? account.username : "",
      name: typeof account.name === "string" ? account.name : "",
    },
    configJson: configured.configJson,
    origins: configured.origins,
    records: configured.records,
    policyChanged,
  };
}

async function streamBoundedMedia(response, res, maxBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new UpstreamError("X API response body is too large");
  }
  res.writeHead(200, {
    ...securityHeaders(),
    "content-type": "application/octet-stream",
    "cache-control": "no-store",
  });
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        res.destroy();
        return;
      }
      if (!res.write(Buffer.from(value))) await once(res, "drain");
    }
    res.end();
  } catch (error) {
    await reader.cancel().catch(() => {});
    res.destroy(error);
  }
}

function mockJson(path, method = "GET", data) {
  if (mock.network.offline) throw Object.assign(new Error("Mock network offline"), { status: 503, retryable: true });
  if (path === "/2/users/me" && method === "GET") return { data: mock.user };
  const usernameLookup = path.match(/^\/2\/users\/by\/username\/([^?]+)(?:\?|$)/);
  if (usernameLookup && method === "GET") {
    const username = decodeURIComponent(usernameLookup[1]).toLowerCase();
    const user = [...mock.users.values()].find((entry) => entry.username?.toLowerCase() === username);
    mock.conversationLookupRecipientId = user ? String(user.id) : "";
    return { data: user || null };
  }
  const publicKeys = path.match(/^\/2\/users\/([^/]+)\/public_keys(?:\?|$)/);
  if (publicKeys && method === "GET") {
    return { data: mock.publicKeys[decodeURIComponent(publicKeys[1])] || [] };
  }
  if (path === "/2/chat/conversations/group/initialize" && method === "POST") {
    const conversationId = `g-mock-${mock.nextGroupId++}`;
    mock.groups.set(conversationId, { initialized: true });
    return { data: { conversation_id: conversationId } };
  }
  if (path === "/2/chat/conversations/group" && method === "POST") {
    const group = mock.groups.get(data.conversation_id);
    if (!group?.initialized || group.created) throw new Error("Unknown mock group");
    group.created = true;
    group.payload = data;
    mock.conversations.set(data.conversation_id, {
      conversationId: data.conversation_id,
      kind: "group",
      memberIds: data.group_members,
      adminIds: data.group_admins,
      keyVersion: data.conversation_key_version,
      unread: 0,
      updatedAt: new Date().toISOString(),
    });
    return {
      data: { conversation_id: data.conversation_id, conversation_key_change_sequence_id: "mock-group-key-change" },
    };
  }
  const directKeys = path.match(/^\/2\/chat\/conversations\/(\d{1,19})\/keys$/);
  if (directKeys && method === "POST") {
    const recipientId = directKeys[1];
    const existing = [...mock.conversations.values()].find(
      (conversation) =>
        conversation.kind === "direct" &&
        conversation.memberIds.map(String).includes(String(mock.user.id)) &&
        conversation.memberIds.map(String).includes(recipientId),
    );
    if (existing) throw new UpstreamError("Mock direct conversation already exists", { status: 409 });
    const recipient = mock.users.get(recipientId);
    if (!recipient || recipient.receives_your_chat !== "encrypted") {
      throw new UpstreamError("Mock recipient cannot receive encrypted chats", { status: 403 });
    }
    const configuredStatus = mockFixture.conversationKeyStatusByRecipient?.[recipientId];
    if (Number.isInteger(configuredStatus)) {
      throw new UpstreamError("Mock key initialization rejected", {
        status: configuredStatus,
        retryable: configuredStatus === 408 || configuredStatus === 429 || configuredStatus >= 500,
      });
    }
    if (mockFixture.conversationKeyTimeoutBeforeAcceptOnceFor === recipientId) {
      const attempts = mock.keyInitializationAttempts.get(recipientId) || 0;
      if (attempts === 0) {
        mock.keyInitializationAttempts.set(recipientId, 1);
        throw new UpstreamError("Mock key initialization timed out before acceptance", {
          status: 408,
          retryable: true,
        });
      }
    }
    const conversationId = required(data?.mock_conversation_id, "conversation_id");
    const payload = data?.mock_request_body;
    const validated = directConversationKeysPayload(payload, String(mock.user.id), recipientId, conversationId);
    const conversation = {
      conversationId,
      kind: "direct",
      memberIds: [String(mock.user.id), recipientId],
      adminIds: [],
      keyVersion: validated.conversation_key_version,
      unread: 0,
      updatedAt: new Date().toISOString(),
    };
    mock.conversations.set(conversationId, conversation);
    if (mockFixture.conversationKeyTimeoutAfterAcceptFor === recipientId) {
      throw new UpstreamError("Mock key initialization outcome is unknown", { status: 408, retryable: true });
    }
    return {
      data: { conversation_id: conversationId, sequence_id: `mock-key-change-${mock.conversations.size}` },
    };
  }
  if (path.startsWith("/2/chat/conversations?") && method === "GET") {
    const params = new URL(path, xBase).searchParams;
    const isContactLookup = params.get("user.fields")?.split(",").includes("receives_your_chat");
    if (params.get("max_results") !== "100" || params.has("participant_ids") || params.has("type")) {
      throw new Error("Invalid mock conversation lookup query");
    }
    const recipientId = isContactLookup ? mock.conversationLookupRecipientId : "";
    const forcedStatus = mockFixture.conversationLookupErrorsByRecipientId?.[recipientId];
    if (forcedStatus) {
      throw new UpstreamError("Mock conversation lookup failed", { status: forcedStatus, retryable: true });
    }
    const matching = [...mock.conversations.values()]
      .filter(
        (conversation) =>
          !conversation.lookupOnlyForRecipientId || conversation.lookupOnlyForRecipientId === recipientId,
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const offset = Number(params.get("pagination_token") || 0);
    const requestedPageSize = Number(params.get("max_results")) || 100;
    const pageSize =
      isContactLookup && Number.isSafeInteger(mockFixture.conversationLookupPageSize)
        ? Math.min(requestedPageSize, mockFixture.conversationLookupPageSize)
        : requestedPageSize;
    const incompletePage =
      isContactLookup && matching.some((conversation) => conversation.incompleteLookupForRecipientId === recipientId);
    const conversations = matching
      .slice(offset, offset + pageSize)
      .map(({ conversationId, kind, memberIds, adminIds, keyVersion, unread, updatedAt, omitParticipantIds }) => ({
        id: conversationId,
        type: kind,
        ...(omitParticipantIds ? {} : { participant_ids: memberIds }),
        admin_ids: adminIds,
        ...(keyVersion ? { key_version: keyVersion } : {}),
        unread: Boolean(unread),
        updated_at: updatedAt,
      }));
    return {
      data: conversations,
      includes: {
        users: [
          ...new Set(
            conversations.flatMap((conversation) =>
              Array.isArray(conversation.participant_ids) ? conversation.participant_ids.map(String) : [],
            ),
          ),
        ].flatMap((id) => (mock.users.has(id) ? [mock.users.get(id)] : [])),
      },
      meta: incompletePage
        ? { has_more: true }
        : {
            has_more: offset + conversations.length < matching.length,
            ...(offset + conversations.length < matching.length
              ? { next_token: String(offset + conversations.length) }
              : {}),
          },
    };
  }
  const events = path.match(/^\/2\/chat\/conversations\/([^/]+)\/events(?:\?|$)/);
  if (events && method === "GET") {
    const conversationId = decodeURIComponent(events[1]);
    const pageToken = new URL(path, xBase).searchParams.get("pagination_token");
    const offset = pageToken === null ? 0 : Number(pageToken);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid mock pagination token");
    const matching = mock.sends.filter((entry) => entry.conversationId === conversationId);
    const pageSize = mock.eventPageSize || matching.length;
    const entries = matching.slice(offset, offset + pageSize);
    const nextOffset = offset + entries.length;
    return {
      data: entries.map((entry) => ({ encoded_event: entry.eventB64 })),
      meta: {
        conversationKeyEvents: mock.conversationKeyEvents[conversationId] || [],
        ...(nextOffset < matching.length ? { next_token: String(nextOffset) } : {}),
      },
    };
  }
  const messages = path.match(/^\/2\/chat\/conversations\/([^/]+)\/messages$/);
  if (messages && method === "POST") {
    const conversationId = decodeURIComponent(messages[1]);
    const existing = mock.sends.find(
      (entry) => entry.conversationId === conversationId && entry.payload.message_id === data.message_id,
    );
    if (!existing) {
      mock.sends.push({
        conversationId,
        eventB64: required(data.mock_event_b64, "mock event"),
        payload: data,
      });
      const conversation = ensureMockConversation(conversationId);
      conversation.updatedAt = new Date().toISOString();
      recordMockDelivery(conversationId, data.mock_event_b64);
    }
    return { data: { message_id: data.message_id, status: "accepted" } };
  }
  if (path === "/2/chat/media/upload/initialize" && method === "POST") {
    const sessionId = `mock-session-${mock.media.size + 1}`;
    const mediaHashKey = `mock-media-${mock.media.size + 1}`;
    mock.media.set(sessionId, {
      mediaHashKey,
      totalBytes: data.total_bytes,
      uploadedBytes: 0,
      parts: new Map(),
      finalized: false,
    });
    return { data: { session_id: sessionId, media_hash_key: mediaHashKey } };
  }
  const append = path.match(/^\/2\/chat\/media\/upload\/([^/]+)\/append$/);
  if (append && method === "POST") {
    const record = mock.media.get(decodeURIComponent(append[1]));
    if (!record) throw new Error("Unknown mock media session");
    if (!Number.isSafeInteger(data.segment_index)) throw new Error("Invalid mock media segment index");
    const segmentIndex = data.segment_index;
    if (segmentIndex !== record.parts.size) throw new Error("Unexpected mock media segment");
    const bytes = Buffer.from(required(data.media, "media"), "base64");
    if (!bytes.length) throw new Error("Invalid media");
    record.parts.set(segmentIndex, data.media);
    record.uploadedBytes += bytes.length;
    return { data: { status: "accepted" } };
  }
  const finalize = path.match(/^\/2\/chat\/media\/upload\/([^/]+)\/finalize$/);
  if (finalize && method === "POST") {
    const record = mock.media.get(decodeURIComponent(finalize[1]));
    if (!record) throw new Error("Unknown mock media session");
    if (
      !/^\d+$/.test(data.num_parts) ||
      Number(data.num_parts) !== record.parts.size ||
      record.uploadedBytes !== record.totalBytes
    ) {
      throw new Error("Incomplete mock media upload");
    }
    record.finalized = true;
    return { data: { status: "finalized" } };
  }
  const download = path.match(/^\/2\/chat\/media\/[^/]+\/([^/]+)$/);
  if (download && method === "GET") {
    const hash = decodeURIComponent(download[1]);
    for (const record of mock.media.values()) {
      if (record.mediaHashKey === hash && record.finalized) {
        const values = [...record.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, value]) => Buffer.from(value, "base64"));
        return Buffer.concat(values);
      }
    }
    throw new Error("Unknown mock media");
  }
  throw new Error("Unknown mock API route");
}

async function adapterJson(path, method = "GET", data) {
  return mode === "mock" ? mockJson(path, method, data) : xJson(path, method, data);
}

let keyBindingVerifierPromise;
async function verifyRegisteredKeyBinding(identityPublicKey, signingPublicKey, identitySignature) {
  keyBindingVerifierPromise ??= createChat();
  const verifier = await keyBindingVerifierPromise;
  return verifier.verifyKeyBinding(identityPublicKey, signingPublicKey, identitySignature);
}

async function directCreateRecipient(username) {
  const normalized = normalizeUsername(username);
  const params = new URLSearchParams({
    "user.fields": "id,name,username,profile_image_url,receives_your_chat",
  });
  return (await adapterJson(`/2/users/by/username/${encodeURIComponent(normalized)}?${params}`))?.data;
}

async function directCreatePublicKeys(userId) {
  const params = new URLSearchParams({
    "public_key.fields": "identity_public_key_signature,public_key,public_key_version,signing_public_key",
  });
  return adapterJson(`/2/users/${encodeURIComponent(userId)}/public_keys?${params}`);
}

function directCreateAdapter(isAuthorized, post, claimAuthorization) {
  return createLiveDirectCreateAdapter({
    isAuthorized,
    claimAuthorization,
    getAuthenticatedUser: async () => (await adapterJson("/2/users/me"))?.data,
    lookupRecipient: directCreateRecipient,
    lookupDirectConversations,
    getPublicKeys: directCreatePublicKeys,
    verifyKeyBinding: verifyRegisteredKeyBinding,
    post,
  });
}

const liveDirectCreateAdapter = directCreateAdapter(
  (input) => liveCreatePermit.isAuthorized(input),
  (path, body) => xJson(path, "POST", body),
  (input) => liveCreatePermit.claim(input),
);

const simulatedLiveDirectCreateAdapter = directCreateAdapter(
  () => mode === "mock" && mockFixture.liveCreateSimulationEnabled === true,
  async (path, body, { conversationId }) => {
    mock.liveCreateRequests.push({ path, body });
    return mockJson(path, "POST", {
      ...body,
      mock_conversation_id: conversationId,
      mock_request_body: body,
    });
  },
);

function upstreamErrorCategory(status) {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "upstream" : "request_failed";
}

function isCanonicalDirectConversationId(value, authenticatedUserId, recipientId) {
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

async function lookupDirectConversations(authenticatedUserId, recipientId) {
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

function apiConversation(value) {
  return encodeURIComponent(identifier(value, "conversation_id").replaceAll(":", "-"));
}

async function api(req, res, url) {
  const path = url.pathname;
  if (path === "/api/status" && req.method === "GET") {
    return json(res, 200, {
      mode,
      tokenConfigured: Boolean(token),
      liveCreateSimulationEnabled: mode === "mock" && mockFixture.liveCreateSimulationEnabled === true,
      ...(mode === "live"
        ? {
            liveCreateTargetConfigured: liveCreatePermit.isTargetConfigured(),
            liveCreateOneShotAvailable: await liveCreatePermit.isEnabled(),
          }
        : {}),
      sdkInstalled: await stat(sdkDir).then(
        () => true,
        () => false,
      ),
    });
  }
  if (
    req.method === "POST" &&
    (req.headers["x-chat-local"] !== "1" ||
      req.headers["content-type"]?.split(";")[0] !== "application/json" ||
      (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`))
  )
    return json(res, 403, { error: "Local app request required" });
  if (path === "/api/conversations/initialize" && req.method === "POST" && mode !== "mock") {
    return json(res, 200, await liveDirectCreateAdapter.initialize(await bodyJson(req)));
  }
  if (mode !== "mock" && !token)
    return json(res, 503, { error: "X_ACCESS_TOKEN is not configured on this local server" });
  const allowedMethods = routeMethods[path];
  if (allowedMethods && !allowedMethods.includes(req.method || "")) {
    return json(res, 405, { error: "Method not allowed" }, { allow: allowedMethods.join(", ") });
  }
  if (path === "/api/me" && req.method === "GET") {
    return json(res, 200, await adapterJson("/2/users/me"));
  }
  if (path === "/api/juicebox/config" && req.method === "GET") {
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) {
      return json(res, 403, { error: "Local app request required" });
    }
    return json(res, 200, { data: await authenticatedJuiceboxConfig() });
  }
  if (path === "/api/public-keys" && req.method === "GET") {
    const id = encodeURIComponent(identifier(url.searchParams.get("user_id"), "user_id"));
    const fields = new URLSearchParams({
      "public_key.fields": "identity_public_key_signature,public_key,public_key_version,signing_public_key",
    });
    return json(res, 200, await adapterJson(`/2/users/${id}/public_keys?${fields}`));
  }
  if (path === "/api/contacts/lookup" && req.method === "GET") {
    const username = normalizeUsername(url.searchParams.get("username"));
    const authenticatedUser = (await adapterJson("/2/users/me"))?.data;
    const authenticatedUserId = userId(String(authenticatedUser?.id ?? ""), "authenticated user ID");
    const userFields = new URLSearchParams({
      "user.fields": "id,name,username,profile_image_url,receives_your_chat",
    });
    const lookup = await adapterJson(`/2/users/by/username/${encodeURIComponent(username)}?${userFields}`);
    const recipient = lookup?.data;
    if (!recipient || typeof recipient !== "object" || !/^\d{1,19}$/.test(String(recipient.id ?? ""))) {
      return json(res, 404, { error: "ไม่พบบัญชี Username นี้" });
    }
    if (String(recipient.id) === authenticatedUserId) {
      return json(res, 400, { error: "ไม่สามารถเริ่มบทสนทนากับบัญชีตัวเองได้" });
    }
    const {
      conversations,
      lookup: conversationLookup,
      error: conversationError,
    } = await lookupDirectConversations(authenticatedUserId, String(recipient.id));
    return json(res, 200, {
      data: {
        authenticated_user_id: authenticatedUserId,
        user: {
          id: String(recipient.id),
          name: typeof recipient.name === "string" ? recipient.name : "",
          username: typeof recipient.username === "string" ? recipient.username : username,
          profile_image_url: typeof recipient.profile_image_url === "string" ? recipient.profile_image_url : "",
          receives_your_chat: typeof recipient.receives_your_chat === "string" ? recipient.receives_your_chat : null,
        },
        conversations,
        conversation_lookup: conversationLookup,
        ...(conversationError ? { conversation_error: conversationError } : {}),
      },
    });
  }
  if (path === "/api/conversations" && req.method === "GET") {
    const params = new URLSearchParams({
      max_results: "100",
      "chat_conversation.fields": "id,type,unread,updated_at",
      expansions: "participant_ids",
      "user.fields": "id,name,username,profile_image_url",
    });
    return json(res, 200, await adapterJson(`/2/chat/conversations?${params}`));
  }
  if (path === "/api/conversations/read" && req.method === "POST") {
    if (mode !== "mock") return json(res, 501, { error: "Live read-state route is not implemented" });
    const data = await bodyJson(req);
    const conversation = mock.conversations.get(identifier(data.conversation_id, "conversation_id"));
    if (!conversation) throw new Error("Unknown mock conversation");
    conversation.unread = false;
    return json(res, 200, { data: { status: "read" } });
  }
  if (path === "/api/conversations/initialize" && req.method === "POST") {
    const data = await bodyJson(req);
    const recipientId = userId(data.recipient_user_id, "recipient_user_id");
    const conversationId = identifier(data.conversation_id, "conversation_id");
    const requestBody = directConversationKeysPayload(
      data.request_body,
      String(mock.user.id),
      recipientId,
      conversationId,
    );
    return json(
      res,
      200,
      await adapterJson(`/2/chat/conversations/${recipientId}/keys`, "POST", {
        ...requestBody,
        mock_conversation_id: conversationId,
        mock_request_body: requestBody,
      }),
    );
  }
  if (path === "/api/mock/live-create/requests" && req.method === "GET") {
    if (mode !== "mock" || mockFixture.liveCreateSimulationEnabled !== true) {
      return json(res, 404, { error: "Unknown API route" });
    }
    return json(res, 200, { count: mock.liveCreateRequests.length, requests: mock.liveCreateRequests });
  }
  if (path === "/api/mock/live-create" && req.method === "POST") {
    if (mode !== "mock" || mockFixture.liveCreateSimulationEnabled !== true) {
      return json(res, 404, { error: "Unknown API route" });
    }
    return json(res, 200, await simulatedLiveDirectCreateAdapter.initialize(await bodyJson(req)));
  }
  if (path === "/api/mock/identity" && req.method === "POST") {
    if (mode !== "mock") return json(res, 404, { error: "Unknown API route" });
    const { userId, record } = mockIdentityPayload(await bodyJson(req));
    const existingUser = mock.users.get(userId);
    const username = existingUser?.username || mockUsernameAlias(userId);
    const conflictingUser = [...mock.users.values()].find(
      (user) =>
        String(user.id) !== userId &&
        typeof user.username === "string" &&
        user.username.toLowerCase() === username.toLowerCase(),
    );
    if (conflictingUser) {
      return json(res, 409, { error: "Mock username alias is already assigned" });
    }
    mock.publicKeys[userId] = [record];
    if (!existingUser) {
      mock.users.set(userId, {
        id: userId,
        name: `Mock ${userId}`,
        username,
        receives_your_chat: "encrypted",
      });
    } else if (!existingUser.username) {
      existingUser.username = username;
    }
    return json(res, 200, { data: { user_id: userId, public_key_version: record.public_key_version, username } });
  }
  if (path === "/api/mock/network" && req.method === "POST") {
    if (mode !== "mock") return json(res, 404, { error: "Unknown API route" });
    mock.network = mockNetworkPayload(await bodyJson(req));
    return json(res, 200, { data: mock.network });
  }
  if (path === "/api/mock/deliveries" && req.method === "GET") {
    if (mode !== "mock") return json(res, 404, { error: "Unknown API route" });
    const after = url.searchParams.get("after");
    const offset = after === null ? 0 : Number(after);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid delivery cursor");
    let deliveries = mock.deliveries.slice(offset);
    if (mock.network.order === "reverse") deliveries = [...deliveries].reverse();
    if (mock.network.duplicate) deliveries = deliveries.flatMap((delivery) => [delivery, { ...delivery }]);
    return json(res, 200, { data: deliveries, meta: { next_cursor: String(mock.deliveries.length) } });
  }
  if (path === "/api/group/roster" && req.method === "GET") {
    if (mode !== "mock") return json(res, 501, { error: "Live group roster route is not implemented" });
    const conversation = mock.conversations.get(identifier(url.searchParams.get("conversation_id"), "conversation_id"));
    if (!conversation || conversation.kind !== "group") throw new Error("Unknown mock group");
    return json(res, 200, { data: conversation });
  }
  if ((path === "/api/group/members/add" || path === "/api/group/members/remove") && req.method === "POST") {
    if (mode !== "mock") return json(res, 501, { error: "Live group membership route is not implemented" });
    const operation = path.endsWith("/add") ? "add" : "remove";
    const payload = groupMemberMutationPayload(await bodyJson(req), operation);
    const group = mock.conversations.get(payload.conversationId);
    if (!group || group.kind !== "group" || group.keyVersion !== payload.expectedKeyVersion) {
      throw new Error("Stale or unknown mock group roster");
    }
    const current = new Set(group.memberIds);
    const next = new Set(group.memberIds);
    if (operation === "add") {
      if (payload.userIds.some((id) => current.has(id) || !mock.publicKeys[id]?.length))
        throw new Error("Invalid group member add");
      for (const id of payload.userIds) next.add(id);
    } else {
      if (payload.userIds.some((id) => !current.has(id) || id === String(mock.user.id)))
        throw new Error("Invalid group member removal");
      for (const id of payload.userIds) next.delete(id);
      if (!next.size) throw new Error("Invalid group member removal");
    }
    const nextIds = [...next];
    if (
      nextIds.length !== payload.participantIds.length ||
      nextIds.some((id) => !payload.participantIds.includes(id))
    ) {
      throw new Error("Group rotation roster mismatch");
    }
    group.memberIds = nextIds;
    group.adminIds = group.adminIds.filter((id) => next.has(id));
    group.keyVersion = payload.conversationKeyVersion;
    group.updatedAt = new Date().toISOString();
    return json(res, 200, {
      data: { conversation_id: group.conversationId, key_version: group.keyVersion, member_ids: group.memberIds },
    });
  }
  if (path === "/api/group/initialize" && req.method === "POST") {
    await bodyJson(req);
    return json(res, 200, await adapterJson("/2/chat/conversations/group/initialize", "POST"));
  }
  if (path === "/api/group/create" && req.method === "POST") {
    const payload = groupCreatePayload(await bodyJson(req));
    return json(res, 200, await adapterJson("/2/chat/conversations/group", "POST", payload));
  }
  if (path === "/api/events" && req.method === "GET") {
    const id = apiConversation(url.searchParams.get("conversation_id"));
    const page = paginationToken(url.searchParams.get("pagination_token"));
    return json(res, 200, await adapterJson(conversationEventsPath(id, page)));
  }
  if (path === "/api/send" && req.method === "POST") {
    const data = await bodyJson(req);
    const id = apiConversation(data.conversation_id);
    const payload = {
      message_id: required(data.message_id, "message_id"),
      encoded_message_create_event: required(data.encoded_message_create_event, "encrypted event"),
      encoded_message_event_signature: required(data.encoded_message_event_signature, "signature"),
      xdk_version: required(data.xdk_version, "xdk_version"),
    };
    const adapterPayload =
      mode === "mock" ? { ...payload, mock_event_b64: required(data.event_b64, "mock event") } : payload;
    return json(res, 200, await adapterJson(`/2/chat/conversations/${id}/messages`, "POST", adapterPayload));
  }
  if (path === "/api/media/initialize" && req.method === "POST") {
    const data = await bodyJson(req);
    return json(
      res,
      200,
      await adapterJson("/2/chat/media/upload/initialize", "POST", {
        conversation_id: identifier(data.conversation_id, "conversation_id").replaceAll("-", ":"),
        total_bytes: positiveInteger(data.total_bytes, "total_bytes"),
      }),
    );
  }
  if (path === "/api/media/append" && req.method === "POST") {
    const data = await bodyJson(req);
    const session = encodeURIComponent(required(data.session_id, "session_id"));
    return json(
      res,
      200,
      await adapterJson(`/2/chat/media/upload/${session}/append`, "POST", {
        conversation_id: identifier(data.conversation_id, "conversation_id").replaceAll("-", ":"),
        media_hash_key: required(data.media_hash_key, "media_hash_key"),
        segment_index: mediaSegmentIndex(data.segment_index),
        media: base64(data.media, "media"),
      }),
    );
  }
  if (path === "/api/media/finalize" && req.method === "POST") {
    const data = await bodyJson(req);
    const session = encodeURIComponent(required(data.session_id, "session_id"));
    return json(
      res,
      200,
      await adapterJson(`/2/chat/media/upload/${session}/finalize`, "POST", {
        conversation_id: identifier(data.conversation_id, "conversation_id").replaceAll("-", ":"),
        media_hash_key: required(data.media_hash_key, "media_hash_key"),
        num_parts: String(positiveInteger(data.num_parts, "num_parts")),
      }),
    );
  }
  if (path === "/api/media/download" && req.method === "GET") {
    const id = apiConversation(url.searchParams.get("conversation_id"));
    const hash = encodeURIComponent(required(url.searchParams.get("media_hash_key"), "media_hash_key"));
    if (mode === "mock") {
      const bytes = await adapterJson(`/2/chat/media/${id}/${hash}`);
      res.writeHead(200, {
        ...securityHeaders(),
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(bytes);
      return;
    }
    const response = await xRequest(`/2/chat/media/${id}/${hash}`);
    return streamBoundedMedia(response, res, MAX_X_MEDIA_RESPONSE_BYTES);
  }
  json(res, 404, { error: "Unknown API route" });
}

async function serve(res, baseDir, relative) {
  const path = resolve(baseDir, relative);
  if (path !== baseDir && !path.startsWith(baseDir + sep)) return json(res, 404, { error: "Not found" });
  try {
    const info = await stat(path);
    if (!info.isFile()) return json(res, 404, { error: "Not found" });
    const type = path.endsWith(".wasm")
      ? "application/wasm"
      : path.endsWith(".js") || path.endsWith(".mjs")
        ? "text/javascript"
        : path.endsWith(".css")
          ? "text/css"
          : "text/html";
    res.writeHead(200, { ...securityHeaders(), "content-type": type, "cache-control": "no-store" });
    createReadStream(path).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return await serve(res, staticDir, file);
  } catch (error) {
    json(res, error?.status || 400, { error: error.message, retryable: error?.retryable === true });
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  port = boundPort;
  console.log(`X Chat local inbox: http://127.0.0.1:${boundPort}`);
});
