// In-memory stand-in for api.x.com used when X_CHAT_API_MODE=mock.
// The store never holds real credentials or private keys.

import { UpstreamError } from "./upstream.mjs";
import { directConversationKeysPayload, required } from "./api-validation.mjs";

const xBase = "https://api.x.com";

export function createMockStore(mockFixture = {}) {
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
  mock.users.set(String(mock.user.id), mock.user);
  for (const user of Object.values(mockFixture.users || {})) {
    if (user && typeof user.id === "string") mock.users.set(user.id, user);
  }
  for (const conversation of mockFixture.conversations || []) {
    if (conversation && typeof conversation.conversationId === "string") {
      mock.conversations.set(conversation.conversationId, conversation);
    }
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

  return { mock, mockFixture, mockJson };
}
