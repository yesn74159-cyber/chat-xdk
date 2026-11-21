import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { base64ToBytes, bytesToBase64, createChat, encryptedFileSize } from "@xdevplatform/chat-xdk";
import { mockUsernameAlias } from "../lib/mock-username.mjs";
import {
  canConfirmDirectChat,
  permissionForEncryptedChat,
  resolveExistingDirectConversation,
} from "../public/contact-lookup.mjs";
import { groupCreateRequest } from "../public/group-create.mjs";
import { groupMembersAddRequest, groupMembersRemoveRequest } from "../public/group-members.mjs";
import { prepareConversationKeyPlan, prepareDirectConversationChange } from "../public/conversation-key-plan.mjs";

const appRoot = new URL("../", import.meta.url);
const vectors = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/sdk_vectors.json", import.meta.url), "utf8"),
);
const conversationPathId = vectors.event_conversation_id.replaceAll(":", "-");
const signingKey = {
  public_key_version: vectors.event_signing_key_version,
  signing_public_key: vectors.signing_public_b64,
  public_key: vectors.identity_public_b64,
  identity_public_key_signature: vectors.identity_public_key_signature_b64,
};

test("Mock username aliases are deterministic, unique for numeric IDs, and at most 15 characters", () => {
  const userIds = ["0", "00", "1", "01", "10", "0010", "1234567890123456789", "9999999999999999999"];
  const aliases = userIds.map(mockUsernameAlias);
  assert.deepEqual(aliases, userIds.map(mockUsernameAlias));
  assert.equal(new Set(aliases).size, userIds.length);
  for (const alias of aliases) assert.match(alias, /^[a-z0-9_]{1,15}$/);
  assert.equal(mockUsernameAlias("9999999999999999999").length, 15);
  assert.throws(() => mockUsernameAlias("not-an-id"), /Invalid mock user ID/);
});

const mockFixture = JSON.stringify({
  user: { id: vectors.event_sender_id, name: "Fixture Owner", username: "fixture_owner" },
  users: {
    [vectors.event_sender_id]: {
      id: vectors.event_sender_id,
      name: "Fixture Owner",
      username: "fixture_owner",
      receives_your_chat: "encrypted",
    },
    2222: {
      id: "2222",
      name: "Fixture Peer",
      username: "fixture_peer",
      profile_image_url: "https://pbs.twimg.com/profile_images/123/fixture.jpg",
      receives_your_chat: "encrypted",
    },
    3333: {
      id: "3333",
      name: "New Fixture",
      username: "new_fixture",
      receives_your_chat: "encrypted",
    },
    3334: {
      id: "3334",
      name: "Live Simulation Fixture",
      username: "live_simulation",
      receives_your_chat: "encrypted",
    },
    4567: {
      id: "4567",
      name: "Alias Collision Fixture",
      username: mockUsernameAlias("7654321098765432103"),
      receives_your_chat: "encrypted",
    },
    4444: {
      id: "4444",
      name: "Paged Fixture",
      username: "paged_fixture",
      receives_your_chat: "encrypted",
    },
    5555: {
      id: "5555",
      name: "Error Fixture",
      username: "error_fixture",
      receives_your_chat: "encrypted",
    },
    6666: {
      id: "6666",
      name: "Incomplete Fixture",
      username: "incomplete",
      receives_your_chat: "encrypted",
    },
    3344: { id: "3344", name: "One Participant", username: "one_participant", receives_your_chat: "encrypted" },
    3345: { id: "3345", name: "Unrelated Room", username: "unrelated_dm", receives_your_chat: "encrypted" },
    3346: { id: "3346", name: "Malformed Target", username: "bad_target", receives_your_chat: "encrypted" },
    3347: { id: "3347", name: "Missing Participant", username: "missing_part", receives_your_chat: "encrypted" },
    3360: { id: "3360", name: "Four Room Target", username: "four_room", receives_your_chat: "encrypted" },
    3361: { id: "3361", name: "Malformed Self Only", username: "bad_self_room", receives_your_chat: "encrypted" },
    3362: { id: "3362", name: "Conflicting Self Only", username: "conflict_self", receives_your_chat: "encrypted" },
    7778: { id: "7778", name: "Server Error", username: "server_error", receives_your_chat: "encrypted" },
    7779: { id: "7779", name: "Ambiguous ID", username: "ambiguous_id", receives_your_chat: "encrypted" },
    7777: { id: "7777", name: "Closed Inbox", username: "closed_inbox", receives_your_chat: "none" },
    8888: { id: "8888", name: "Unknown Permission", username: "unknown_permission" },
    9999: { id: "9999", name: "Timeout Peer", username: "timeout_peer", receives_your_chat: "encrypted" },
    9111: { id: "9111", name: "Retry Peer", username: "retry_peer", receives_your_chat: "encrypted" },
    9001: { id: "9001", name: "Unauthorized", username: "unauthorized", receives_your_chat: "encrypted" },
    9002: { id: "9002", name: "Forbidden", username: "forbidden", receives_your_chat: "encrypted" },
    9003: { id: "9003", name: "Conflict", username: "conflict", receives_your_chat: "encrypted" },
    9004: { id: "9004", name: "Rate Limited", username: "rate_limited", receives_your_chat: "encrypted" },
    9005: { id: "9005", name: "Server Failure", username: "server_failure", receives_your_chat: "encrypted" },
  },
  publicKeys: {
    [vectors.event_sender_id]: [signingKey],
    2222: [signingKey],
    3333: [signingKey],
    3334: [signingKey],
    9999: [signingKey],
    9111: [signingKey],
  },
  conversations: [
    {
      conversationId: vectors.event_conversation_id,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "2222"],
      unread: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:4444`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "4444"],
      unread: 0,
      updatedAt: "2026-01-03T00:00:00.000Z",
    },
    {
      conversationId: `4444:${vectors.event_sender_id}`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "4444"],
      unread: 0,
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:6666`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "6666"],
      incompleteLookupForRecipientId: "6666",
      unread: 0,
      updatedAt: "2026-01-04T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:1234`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "7779"],
      lookupOnlyForRecipientId: "7779",
      unread: 0,
      updatedAt: "2026-01-05T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3344`,
      kind: "direct",
      memberIds: ["3344"],
      lookupOnlyForRecipientId: "3344",
      unread: 0,
      updatedAt: "2026-01-06T00:00:00.000Z",
    },
    {
      conversationId: `invalid:3346`,
      kind: "direct",
      memberIds: ["3346"],
      lookupOnlyForRecipientId: "3346",
      unread: 0,
      updatedAt: "2026-01-07T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3347`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "3347"],
      omitParticipantIds: true,
      lookupOnlyForRecipientId: "3347",
      unread: 0,
      updatedAt: "2026-01-08T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:${vectors.event_sender_id}`,
      kind: "direct",
      memberIds: [vectors.event_sender_id],
      lookupOnlyForRecipientId: "3360",
      unread: 0,
      updatedAt: "2026-02-04T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3360`,
      kind: "direct",
      memberIds: ["3360"],
      lookupOnlyForRecipientId: "3360",
      unread: 0,
      updatedAt: "2026-02-03T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3352`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "3352"],
      lookupOnlyForRecipientId: "3360",
      unread: 0,
      updatedAt: "2026-02-02T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3353`,
      kind: "direct",
      memberIds: [vectors.event_sender_id, "3353"],
      lookupOnlyForRecipientId: "3360",
      unread: 0,
      updatedAt: "2026-02-01T00:00:00.000Z",
    },
    {
      conversationId: "malformed:3361",
      kind: "direct",
      memberIds: [vectors.event_sender_id],
      lookupOnlyForRecipientId: "3361",
      unread: 0,
      updatedAt: "2026-03-01T00:00:00.000Z",
    },
    {
      conversationId: `${vectors.event_sender_id}:3362`,
      kind: "direct",
      memberIds: [vectors.event_sender_id],
      lookupOnlyForRecipientId: "3362",
      unread: 0,
      updatedAt: "2026-03-02T00:00:00.000Z",
    },
  ],
  conversationLookupPageSize: 1,
  conversationLookupErrorsByRecipientId: { 5555: 429, 7778: 503 },
  conversationKeyStatusByRecipient: { 9001: 401, 9002: 403, 9003: 409, 9004: 429, 9005: 503 },
  conversationKeyTimeoutAfterAcceptFor: "9999",
  conversationKeyTimeoutBeforeAcceptOnceFor: "9111",
  liveCreateSimulationEnabled: true,
  conversationKeyEvents: { [conversationPathId]: [vectors.event_key_change_b64] },
  eventPageSize: 1,
});
let child;
let baseUrl;

function startMockServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: appRoot,
      env: { ...process.env, X_CHAT_API_MODE: "mock", X_CHAT_MOCK_FIXTURE: mockFixture, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Mock server did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        baseUrl = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!baseUrl) {
        clearTimeout(timeout);
        reject(new Error(`Mock server exited with ${code}: ${output}`));
      }
    });
  });
}

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  return {
    response,
    body: contentType.includes("application/json")
      ? await response.json()
      : new Uint8Array(await response.arrayBuffer()),
  };
}

function post(path, body, headers = {}) {
  return request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-local": "1", ...headers },
    body: JSON.stringify(body),
  });
}

test("Live direct-conversation initialization remains disabled with HTTP 501", async () => {
  // Assigned through a variable so the credential-pattern guard stays strict.
  const tokenEnvName = "X_ACCESS_TOKEN";
  const childEnv = {
    X_CHAT_API_MODE: "live",
    X_CHAT_LIVE_CREATE_ENABLED: "true",
    [tokenEnvName]: "test-only-placeholder-not-a-credential",
    PORT: "0",
  };
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[name]) childEnv[name] = process.env[name];
  }
  const liveChild = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "ignore"],
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Credential-free Live test server did not start")), 10_000);
      liveChild.stdout.on("data", (chunk) => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      liveChild.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      liveChild.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Credential-free Live test server exited with ${code}`));
      });
    });
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/conversations/initialize`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-chat-local": "1" },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => (body += chunk));
          incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    assert.equal(response.status, 501);
    assert.match(JSON.parse(response.body).error, /disabled/i);
  } finally {
    if (liveChild.exitCode === null) {
      const exited = once(liveChild, "exit");
      liveChild.kill();
      await exited;
    }
  }
});

async function chatFromMockHistory() {
  const chat = await createChat();
  chat.importKeys({
    keys: base64ToBytes(vectors.private_keys_concat_b64),
    signingKeyVersion: vectors.event_recipient_key_version,
  });
  chat.setIdentity({ userId: vectors.event_sender_id, signingKeyVersion: vectors.event_signing_key_version });
  chat.setCacheKeys(true);
  const { body: publicKeys } = await request(`/api/public-keys?user_id=${vectors.event_sender_id}`);
  const signingKeys = publicKeys.data.map((key) => ({
    userId: vectors.event_sender_id,
    publicKeyVersion: key.public_key_version,
    publicKey: key.signing_public_key,
    identityPublicKey: key.public_key,
    identityPublicKeySignature: key.identity_public_key_signature,
  }));
  chat.setSigningKeys(signingKeys);
  const { body: historyResponse } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}`,
  );
  const history = chat.decryptEvents({ events: historyResponse.meta.conversationKeyEvents });
  return { chat, signingKeys, conversationKeys: history.conversationKeys.keys };
}

async function freshChatWithSigningKeys() {
  const chat = await createChat();
  chat.importKeys({
    keys: base64ToBytes(vectors.private_keys_concat_b64),
    signingKeyVersion: vectors.event_recipient_key_version,
  });
  chat.setIdentity({ userId: vectors.event_sender_id, signingKeyVersion: vectors.event_signing_key_version });
  chat.setCacheKeys(true);
  const { body: publicKeys } = await request(`/api/public-keys?user_id=${vectors.event_sender_id}`);
  const signingKeys = publicKeys.data.map((key) => ({
    userId: vectors.event_sender_id,
    publicKeyVersion: key.public_key_version,
    publicKey: key.signing_public_key,
    identityPublicKey: key.public_key,
    identityPublicKeySignature: key.identity_public_key_signature,
  }));
  chat.setSigningKeys(signingKeys);
  return chat;
}

async function prepareDirectChange(recipientId) {
  const chat = await freshChatWithSigningKeys();
  const publicKeys = [];
  for (const userId of [vectors.event_sender_id, recipientId]) {
    const { body } = await request(`/api/public-keys?user_id=${userId}`);
    for (const key of body.data) {
      assert.equal(
        chat.verifyKeyBinding(key.public_key, key.signing_public_key, key.identity_public_key_signature),
        true,
      );
      publicKeys.push({ userId, identityPublicKey: key.public_key, publicKeyVersion: key.public_key_version });
    }
  }
  return prepareDirectConversationChange(chat, publicKeys, vectors.event_sender_id, recipientId);
}

function initializeDirect(recipientId, plan) {
  return post("/api/conversations/initialize", {
    recipient_user_id: recipientId,
    conversation_id: plan.conversationId,
    request_body: plan.requestBody,
  });
}

function mockDirectRequestBody(recipientId) {
  return {
    conversation_key_version: "123456",
    conversation_participant_keys: [
      {
        user_id: vectors.event_sender_id,
        encrypted_conversation_key: "encrypted-self",
        public_key_version: "1",
      },
      { user_id: recipientId, encrypted_conversation_key: "encrypted-peer", public_key_version: "1" },
    ],
    action_signatures: [
      {
        message_id: "message-id",
        encoded_message_event_detail: "encoded-action",
        message_event_signature: {
          signature: "signature",
          signature_version: "1",
          public_key_version: "1",
          signing_public_key: "signing-key",
        },
      },
    ],
  };
}

function sendBody(conversationId, payload) {
  return {
    conversation_id: conversationId,
    message_id: payload.messageId,
    encoded_message_create_event: payload.encodedMessageCreateEvent,
    encoded_message_event_signature: payload.encodedMessageEventSignature,
    xdk_version: payload.xdkVersion,
    event_b64: payload.eventB64,
  };
}

before(async () => startMockServer());

after(() => {
  globalThis.fetch = nativeFetch;
  process.getBuiltinModule = nativeGetBuiltinModule;
  if (child && !child.killed) child.kill();
});

const nativeFetch = globalThis.fetch;
const nativeGetBuiltinModule = process.getBuiltinModule;

before(() => {
  process.getBuiltinModule = undefined;
  globalThis.fetch = async (input, options) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, baseUrl);
    if (url.origin !== baseUrl) return new Response("External network blocked in tests", { status: 403 });
    return nativeFetch(input, options);
  };
});

test("health and metrics are redacted and count requests without paths", async () => {
  const { response, body: health } = await request("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(health).sort(), ["mode", "sdkInstalled", "status", "tokenConfigured", "uptimeSeconds"]);
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "mock");
  assert.equal(health.tokenConfigured, false);
  assert.equal(health.sdkInstalled, true);
  assert.equal(Number.isInteger(health.uptimeSeconds), true);

  const { body: metrics } = await request("/api/metrics");
  assert.deepEqual(Object.keys(metrics).sort(), ["requests", "responses", "serverErrors", "uptimeSeconds"]);
  assert.equal(Number.isInteger(metrics.requests), true);
  assert.ok(metrics.requests >= 2);
  assert.ok(metrics.responses["2xx"] >= 1);
  assert.equal(metrics.serverErrors, 0);
  assert.doesNotMatch(JSON.stringify(metrics), /conversation|token|user|api/i);
});

test("mock adapter loads keys, then sends, returns history, and preserves a real encrypted image", async () => {
  const { body: status } = await request("/api/status");
  assert.deepEqual(status, {
    mode: "mock",
    tokenConfigured: false,
    liveCreateSimulationEnabled: true,
    sdkInstalled: true,
  });
  const { body: me } = await request("/api/me");
  assert.equal(me.data.id, vectors.event_sender_id);
  const { body: keys } = await request(`/api/public-keys?user_id=${vectors.event_sender_id}`);
  assert.deepEqual(keys.data, [signingKey]);
  const { body: emptyHistory } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}`,
  );
  assert.deepEqual(emptyHistory.data, []);
  assert.deepEqual(emptyHistory.meta.conversationKeyEvents, [vectors.event_key_change_b64]);

  const { chat, signingKeys, conversationKeys } = await chatFromMockHistory();
  const link = chat.encryptMessage({ conversationId: vectors.event_conversation_id, text: "See https://example.com" });
  const { body: sentLink } = await post("/api/send", sendBody(vectors.event_conversation_id, link));
  assert.equal(sentLink.data.message_id, link.messageId);
  const { body: resentLink } = await post("/api/send", sendBody(vectors.event_conversation_id, link));
  assert.equal(resentLink.data.message_id, link.messageId);

  const { body: initialHistory } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}`,
  );
  assert.equal(initialHistory.data.length, 1);
  const historyChat = await freshChatWithSigningKeys();
  const firstPage = historyChat.decryptEvents({
    events: [...initialHistory.meta.conversationKeyEvents, ...initialHistory.data.map((event) => event.encoded_event)],
  });
  const firstMessage = firstPage.events.find((entry) => entry.event.type === "message");
  assert.equal(firstMessage?.event.verified, true);
  assert.equal(firstMessage?.event.content?.text, "See https://example.com");
  const openedLink = chat.decryptEvent({
    eventB64: initialHistory.data[0].encoded_event,
    conversationKeys,
    signingKeys,
  });
  assert.equal(openedLink.verified, true);
  assert.equal(openedLink.id, link.messageId);
  assert.equal(openedLink.content?.text, "See https://example.com");

  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
  const { body: initialized } = await post("/api/media/initialize", {
    conversation_id: vectors.event_conversation_id,
    total_bytes: encryptedFileSize(image.length),
  });
  const { session_id: sessionId, media_hash_key: mediaHashKey } = initialized.data;
  const imageMessage = chat.encryptMessage({
    conversationId: vectors.event_conversation_id,
    text: "image",
    attachments: [
      {
        attachment_type: "media",
        media_hash_key: mediaHashKey,
        width: 1,
        height: 1,
        filesize_bytes: image.length,
        filename: "one.png",
        media_type: 1,
      },
    ],
  });
  const encrypted = chat.encryptFile({ file: image, eventB64: imageMessage.eventB64, mediaHashKey });
  const midpoint = Math.ceil(encrypted.length / 2);
  const firstPart = encrypted.subarray(0, midpoint);
  const secondPart = encrypted.subarray(midpoint);
  const { body: appended } = await post("/api/media/append", {
    conversation_id: vectors.event_conversation_id,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    segment_index: 0,
    media: bytesToBase64(firstPart),
  });
  assert.equal(appended.data.status, "accepted");
  await post("/api/media/append", {
    conversation_id: vectors.event_conversation_id,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    segment_index: 1,
    media: bytesToBase64(secondPart),
  });
  const { body: finalized } = await post("/api/media/finalize", {
    conversation_id: vectors.event_conversation_id,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    num_parts: 2,
  });
  assert.equal(finalized.data.status, "finalized");
  await post("/api/send", sendBody(vectors.event_conversation_id, imageMessage));

  const { body: history } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}`,
  );
  assert.equal(history.data.length, 1);
  assert.equal(history.meta.next_token, "1");
  const { body: nextHistory } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}&pagination_token=${history.meta.next_token}`,
  );
  assert.equal(nextHistory.data.length, 1);
  assert.equal(nextHistory.meta.next_token, undefined);
  const { body: beyondEndHistory } = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}&pagination_token=999`,
  );
  assert.deepEqual(beyondEndHistory.data, []);
  assert.equal(beyondEndHistory.meta.next_token, undefined);
  const secondPage = historyChat.decryptEvents({
    events: [...nextHistory.meta.conversationKeyEvents, ...nextHistory.data.map((event) => event.encoded_event)],
  });
  const secondMessage = secondPage.events.find((entry) => entry.event.type === "message");
  assert.equal(secondMessage?.event.verified, true);
  assert.equal(secondMessage?.event.content?.text, "image");
  const { body: downloaded } = await request(
    `/api/media/download?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}&media_hash_key=${encodeURIComponent(mediaHashKey)}`,
  );
  const decrypted = chat.decryptFile({
    encrypted: downloaded,
    eventB64: imageMessage.eventB64,
    conversationKeys,
    mediaHashKey,
  });
  assert.deepEqual(decrypted, image);
});

test("mock media rejects out-of-order, incomplete, and unavailable uploads", async () => {
  const { body: initialized } = await post("/api/media/initialize", {
    conversation_id: vectors.event_conversation_id,
    total_bytes: 1,
  });
  const { session_id: sessionId, media_hash_key: mediaHashKey } = initialized.data;
  const common = {
    conversation_id: vectors.event_conversation_id,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    media: "AQ==",
  };
  const outOfOrder = await post("/api/media/append", { ...common, segment_index: 1 });
  assert.equal(outOfOrder.response.status, 400);
  assert.equal(outOfOrder.body.error, "Unexpected mock media segment");
  const malformed = await post("/api/media/append", { ...common, segment_index: 0, media: "not-base64" });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.body.error, "Invalid media");
  await post("/api/media/append", { ...common, segment_index: 0 });
  const incomplete = await post("/api/media/finalize", {
    conversation_id: vectors.event_conversation_id,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    num_parts: 2,
  });
  assert.equal(incomplete.response.status, 400);
  assert.equal(incomplete.body.error, "Incomplete mock media upload");
  const unavailable = await request(
    `/api/media/download?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}&media_hash_key=${encodeURIComponent(mediaHashKey)}`,
  );
  assert.equal(unavailable.response.status, 400);
  assert.equal(unavailable.body.error, "Unknown mock media");
});

test("username lookup is server-side, normalizes handles, rejects self, and reports verified rooms", async () => {
  const found = await request("/api/contacts/lookup?username=%40Fixture_Peer");
  assert.equal(found.response.status, 200);
  assert.equal(found.body.data.authenticated_user_id, vectors.event_sender_id);
  assert.deepEqual(found.body.data.user, {
    id: "2222",
    name: "Fixture Peer",
    username: "fixture_peer",
    profile_image_url: "https://pbs.twimg.com/profile_images/123/fixture.jpg",
    receives_your_chat: "encrypted",
  });
  assert.equal(found.body.data.conversation_lookup, "existing");
  assert.equal(found.body.data.conversations.data.length, 1);
  assert.deepEqual(found.body.data.conversations.data[0].participant_ids, [vectors.event_sender_id, "2222"]);
  assert.equal(JSON.stringify(found.body).includes("access_token"), false);

  const missing = await request("/api/contacts/lookup?username=new_fixture");
  assert.equal(missing.response.status, 200);
  assert.equal(missing.body.data.conversation_lookup, "available");
  assert.equal(missing.body.data.conversations.data.length, 0);

  const self = await request("/api/contacts/lookup?username=fixture_owner");
  assert.equal(self.response.status, 400);
  const invalid = await request("/api/contacts/lookup?username=bad.handle");
  assert.equal(invalid.response.status, 400);
  const unknown = await request("/api/contacts/lookup?username=not_a_user");
  assert.equal(unknown.response.status, 404);
  const postLookup = await post("/api/contacts/lookup", { username: "fixture_peer" });
  assert.equal(postLookup.response.status, 405);
});

test("conversation lookup paginates, preserves incomplete state, and sanitizes upstream errors", async () => {
  const paged = await request("/api/contacts/lookup?username=paged_fixture");
  assert.equal(paged.response.status, 200);
  assert.equal(paged.body.data.conversation_lookup, "ambiguous");
  assert.deepEqual(
    paged.body.data.conversations.data.map((conversation) => conversation.id),
    [`${vectors.event_sender_id}:4444`, `4444:${vectors.event_sender_id}`],
  );

  const incomplete = await request("/api/contacts/lookup?username=incomplete");
  assert.equal(incomplete.response.status, 200, JSON.stringify(incomplete.body));
  assert.equal(incomplete.body.data.user.id, "6666");
  assert.equal(incomplete.body.data.conversation_lookup, "incomplete", JSON.stringify(incomplete.body));
  assert.equal(incomplete.body.data.conversations.data.length, 0);

  const ambiguousId = await request("/api/contacts/lookup?username=ambiguous_id");
  assert.equal(ambiguousId.response.status, 200);
  assert.equal(ambiguousId.body.data.conversation_lookup, "incomplete");
  assert.equal(ambiguousId.body.data.conversations.data.length, 0);

  const failed = await request("/api/contacts/lookup?username=error_fixture");
  assert.equal(failed.response.status, 200);
  assert.equal(failed.body.data.conversation_lookup, "error");
  assert.deepEqual(failed.body.data.conversation_error, { category: "rate_limited", status: 429 });
  assert.equal(JSON.stringify(failed.body).includes("Mock conversation lookup failed"), false);

  const serverFailed = await request("/api/contacts/lookup?username=server_error");
  assert.equal(serverFailed.response.status, 200);
  assert.equal(serverFailed.body.data.conversation_lookup, "error");
  assert.deepEqual(serverFailed.body.data.conversation_error, { category: "upstream", status: 503 });
  assert.equal(JSON.stringify(serverFailed.body).includes("Mock conversation lookup failed"), false);
});

test("conversation lookup validates one- and two-participant rooms and fails closed on target conflicts", async () => {
  const oneParticipant = await request("/api/contacts/lookup?username=one_participant");
  assert.equal(oneParticipant.response.status, 200, JSON.stringify(oneParticipant.body));
  assert.equal(oneParticipant.body.data?.conversation_lookup, "existing", JSON.stringify(oneParticipant.body));
  assert.equal(oneParticipant.body.data.conversations.data.length, 1);
  assert.equal(oneParticipant.body.data.conversations.data[0].id, `${vectors.event_sender_id}:3344`);
  assert.deepEqual(oneParticipant.body.data.conversations.data[0].participant_ids, ["3344"]);

  const twoParticipants = await request("/api/contacts/lookup?username=fixture_peer");
  assert.equal(twoParticipants.body.data.conversation_lookup, "existing");
  assert.equal(twoParticipants.body.data.conversations.data.length, 1);
  assert.deepEqual(twoParticipants.body.data.conversations.data[0].participant_ids, [vectors.event_sender_id, "2222"]);

  const unrelated = await request("/api/contacts/lookup?username=unrelated_dm");
  assert.equal(unrelated.response.status, 200, JSON.stringify(unrelated.body));
  assert.equal(unrelated.body.data.conversation_lookup, "available");
  assert.deepEqual(unrelated.body.data.conversations.data, []);

  for (const username of ["bad_target", "missing_part"]) {
    const invalid = await request(`/api/contacts/lookup?username=${username}`);
    assert.equal(invalid.response.status, 200, JSON.stringify(invalid.body));
    assert.equal(invalid.body.data.conversation_lookup, "incomplete");
    assert.deepEqual(invalid.body.data.conversations.data, []);
  }

  const duplicate = await request("/api/contacts/lookup?username=paged_fixture");
  assert.equal(duplicate.body.data.conversation_lookup, "ambiguous");
  assert.equal(duplicate.body.data.conversations.data.length, 2);

  const fourRoomInbox = await request("/api/contacts/lookup?username=four_room");
  assert.equal(fourRoomInbox.response.status, 200, JSON.stringify(fourRoomInbox.body));
  assert.equal(fourRoomInbox.body.data.conversation_lookup, "existing");
  assert.deepEqual(
    fourRoomInbox.body.data.conversations.data.map((conversation) => conversation.id),
    [`${vectors.event_sender_id}:3360`],
  );

  for (const username of ["bad_self_room", "conflict_self"]) {
    const selfOnly = await request(`/api/contacts/lookup?username=${username}`);
    assert.equal(selfOnly.body.data.conversation_lookup, "incomplete");
    assert.deepEqual(selfOnly.body.data.conversations.data, []);
  }
});

test("XDK 0.7.1 prepares an unposted direct-conversation key plan and discards the raw key", async () => {
  const peer = await createChat();
  const registration = peer.generateKeypairs();
  await post("/api/mock/identity", { user_id: "3333", public_key: registration.publicKey });
  const chat = await freshChatWithSigningKeys();
  const publicKeys = [];
  for (const userId of [vectors.event_sender_id, "3333"]) {
    const { body } = await request(`/api/public-keys?user_id=${userId}`);
    for (const key of body.data) {
      assert.equal(
        chat.verifyKeyBinding(key.public_key, key.signing_public_key, key.identity_public_key_signature),
        true,
      );
      publicKeys.push({ userId, identityPublicKey: key.public_key, publicKeyVersion: key.public_key_version });
    }
  }
  const plan = prepareConversationKeyPlan(chat, publicKeys);
  assert.match(plan.conversationId, /^\d{1,19}:\d{1,19}$/);
  assert.ok(plan.conversationKeyVersion);
  assert.equal(plan.participantCount, 2);
  assert.equal(plan.signatureCount, 1);
  assert.deepEqual(Object.keys(plan).sort(), [
    "conversationId",
    "conversationKeyVersion",
    "participantCount",
    "signatureCount",
  ]);
  const { body: lookup } = await request("/api/contacts/lookup?username=new_fixture");
  assert.equal(lookup.data.conversations.data.length, 0);
});

test("Mock initializes a new direct chat from SDK keys and rejects duplicate initialization", async () => {
  const plan = await prepareDirectChange("3333");
  try {
    const { response, body } = await initializeDirect("3333", plan);
    assert.equal(response.status, 200);
    assert.equal(body.data.conversation_id, plan.conversationId);
    assert.equal(typeof body.data.sequence_id, "string");
    assert.deepEqual(Object.keys(plan.requestBody.action_signatures[0]).sort(), [
      "encoded_message_event_detail",
      "message_event_signature",
      "message_id",
    ]);
    assert.deepEqual(Object.keys(plan.requestBody.action_signatures[0].message_event_signature).sort(), [
      "public_key_version",
      "signature",
      "signature_version",
      "signing_public_key",
    ]);
    const { body: lookup } = await request("/api/contacts/lookup?username=new_fixture");
    assert.equal(lookup.data.conversation_lookup, "existing");
    assert.equal(lookup.data.conversations.data[0].id, plan.conversationId);
    assert.equal(lookup.data.conversations.data[0].key_version, plan.conversationKeyVersion);
    const { body: historyBeforeApproval } = await request(
      `/api/events?conversation_id=${encodeURIComponent(plan.conversationId)}`,
    );
    assert.deepEqual(historyBeforeApproval.data, []);

    const duplicatePlan = await prepareDirectChange("3333");
    try {
      const duplicate = await initializeDirect("3333", duplicatePlan);
      assert.equal(duplicate.response.status, 409);
    } finally {
      duplicatePlan.conversationKey.fill(0);
    }
  } finally {
    plan.conversationKey.fill(0);
  }
});

test("test-authorized Live simulation uses the server adapter and records one X-shaped fake request", async () => {
  const plan = await prepareDirectChange("3334");
  try {
    const simulated = await post("/api/mock/live-create", {
      owner_user_id: vectors.event_sender_id,
      owner_signing_key_version: vectors.event_signing_key_version,
      recipient_user_id: "3334",
      recipient_username: "@live_simulation",
      recipient_consent_confirmed: true,
      final_approval_confirmed: true,
      conversation_id: plan.conversationId,
      request_body: plan.requestBody,
    });
    assert.equal(simulated.response.status, 200);
    assert.equal(simulated.body.data.conversation_id, plan.conversationId);
    const { body: inspection } = await request("/api/mock/live-create/requests");
    assert.equal(inspection.count, 1);
    assert.equal(inspection.requests[0].path, "/2/chat/conversations/3334/keys");
    assert.deepEqual(inspection.requests[0].body, plan.requestBody);
    assert.equal(inspection.requests[0].body.conversation_key_version, plan.conversationKeyVersion);
    assert.equal(inspection.requests[0].body.action_signatures.length, 1);
    const { body: after } = await request("/api/contacts/lookup?username=live_simulation");
    assert.equal(after.data.conversation_lookup, "existing");
    assert.equal(after.data.conversations.data[0].id, plan.conversationId);
  } finally {
    plan.conversationKey.fill(0);
  }
});

test("Mock direct chat blocks closed or unknown inboxes and preserves upstream status codes", async () => {
  for (const recipientId of ["7777", "8888"]) {
    const result = await post("/api/conversations/initialize", {
      recipient_user_id: recipientId,
      conversation_id: `${vectors.event_sender_id}:${recipientId}`,
      request_body: mockDirectRequestBody(recipientId),
    });
    assert.equal(result.response.status, 403);
  }
  for (const [recipientId, status] of Object.entries({ 9001: 401, 9002: 403, 9003: 409, 9004: 429, 9005: 503 })) {
    const result = await post("/api/conversations/initialize", {
      recipient_user_id: recipientId,
      conversation_id: `${vectors.event_sender_id}:${recipientId}`,
      request_body: mockDirectRequestBody(recipientId),
    });
    assert.equal(result.response.status, status);
    assert.equal(result.body.retryable, status === 429 || status >= 500);
  }
});

test("Mock timeout after acceptance is visible in a fresh conversation lookup", async () => {
  const plan = await prepareDirectChange("9999");
  try {
    const result = await initializeDirect("9999", plan);
    assert.equal(result.response.status, 408);
    assert.equal(result.body.retryable, true);
    const { body: lookup } = await request("/api/contacts/lookup?username=timeout_peer");
    assert.equal(lookup.data.conversation_lookup, "existing");
    assert.equal(lookup.data.conversations.data[0].id, plan.conversationId);
    assert.equal(lookup.data.conversations.data[0].key_version, plan.conversationKeyVersion);
  } finally {
    plan.conversationKey.fill(0);
  }
});

test("Mock safe retry after timeout requires a fresh key plan and a complete no-room lookup", async () => {
  const firstPlan = await prepareDirectChange("9111");
  const firstKeySnapshot = firstPlan.conversationKey.slice();
  try {
    const first = await initializeDirect("9111", firstPlan);
    assert.equal(first.response.status, 408);
    assert.equal(first.body.retryable, true);
    const { body: beforeRetry } = await request("/api/contacts/lookup?username=retry_peer");
    assert.equal(beforeRetry.data.conversation_lookup, "available");
    assert.equal(beforeRetry.data.conversations.data.length, 0);
    firstPlan.conversationKey.fill(0);

    const retryPlan = await prepareDirectChange("9111");
    try {
      assert.notDeepEqual(retryPlan.conversationKey, firstKeySnapshot);
      const retry = await initializeDirect("9111", retryPlan);
      assert.equal(retry.response.status, 200);
      assert.equal(retry.body.data.conversation_id, retryPlan.conversationId);
    } finally {
      retryPlan.conversationKey.fill(0);
    }
  } finally {
    firstPlan.conversationKey.fill(0);
    firstKeySnapshot.fill(0);
  }
});

test("mock adapter creates an encrypted group with real SDK signatures before it accepts group messages", async () => {
  const chat = await freshChatWithSigningKeys();
  const memberIds = [vectors.event_sender_id, "2222"];
  const publicKeys = [];
  for (const userId of memberIds) {
    const { body } = await request(`/api/public-keys?user_id=${userId}`);
    for (const key of body.data) {
      assert.equal(
        chat.verifyKeyBinding(key.public_key, key.signing_public_key, key.identity_public_key_signature),
        true,
      );
      publicKeys.push({ userId, identityPublicKey: key.public_key, publicKeyVersion: key.public_key_version });
    }
  }
  const { body: initialized } = await post("/api/group/initialize", {});
  const conversationId = initialized.data.conversation_id;
  assert.match(conversationId, /^g-mock-/);
  const prepared = chat.prepareGroupCreate({
    publicKeys,
    conversationId,
    memberIds,
    adminIds: [vectors.event_sender_id],
    title: "Mock team",
  });
  const { body: created } = await post(
    "/api/group/create",
    groupCreateRequest(prepared, memberIds, [vectors.event_sender_id]),
  );
  assert.equal(created.data.conversation_id, conversationId);

  const payload = chat.encryptMessage({
    conversationId,
    text: "hello group",
    conversationKey: prepared.conversationKey,
    conversationKeyVersion: prepared.conversationKeyVersion,
  });
  await post("/api/send", sendBody(conversationId, payload));
  const { body: history } = await request(`/api/events?conversation_id=${encodeURIComponent(conversationId)}`);
  const opened = chat.decryptEvent({
    eventB64: history.data[0].encoded_event,
    conversationKeys: { [prepared.conversationKeyVersion]: prepared.conversationKey },
  });
  assert.equal(opened.verified, true);
  assert.equal(opened.content?.text, "hello group");
});

test("mock group member changes rotate key material and reject a stale roster", async () => {
  const chat = await freshChatWithSigningKeys();
  const third = await createChat();
  const thirdRegistration = third.generateKeypairs();
  await post("/api/mock/identity", { user_id: "3333", public_key: thirdRegistration.publicKey });
  const users = [vectors.event_sender_id, "2222"];
  const publicKeys = [];
  for (const userId of users) {
    const { body } = await request(`/api/public-keys?user_id=${userId}`);
    publicKeys.push(
      ...body.data.map((key) => ({
        userId,
        identityPublicKey: key.public_key,
        publicKeyVersion: key.public_key_version,
      })),
    );
  }
  const { body: initialized } = await post("/api/group/initialize", {});
  const conversationId = initialized.data.conversation_id;
  const created = chat.prepareGroupCreate({
    publicKeys,
    conversationId,
    memberIds: users,
    adminIds: [vectors.event_sender_id],
    title: "Roster test",
  });
  await post("/api/group/create", groupCreateRequest(created, users, [vectors.event_sender_id]));

  const { body: thirdKeys } = await request("/api/public-keys?user_id=3333");
  const added = chat.prepareGroupMembersChange({
    publicKeys: [
      ...publicKeys,
      ...thirdKeys.data.map((key) => ({
        userId: "3333",
        identityPublicKey: key.public_key,
        publicKeyVersion: key.public_key_version,
      })),
    ],
    conversationId,
    newMemberIds: ["3333"],
    currentMemberIds: users,
    currentAdminIds: [vectors.event_sender_id],
    currentPendingMemberIds: [],
    currentTitle: "Roster test",
  });
  const addedResponse = await post(
    "/api/group/members/add",
    groupMembersAddRequest(added, ["3333"], created.conversationKeyVersion),
  );
  assert.deepEqual(addedResponse.body.data.member_ids.sort(), [...users, "3333"].sort());
  const stale = await post(
    "/api/group/members/add",
    groupMembersAddRequest(added, ["3333"], created.conversationKeyVersion),
  );
  assert.equal(stale.response.status, 400);
  assert.equal(stale.body.error, "Stale or unknown mock group roster");

  const removed = chat.prepareGroupMembersRemove({
    publicKeys: [
      publicKeys[0],
      ...thirdKeys.data.map((key) => ({
        userId: "3333",
        identityPublicKey: key.public_key,
        publicKeyVersion: key.public_key_version,
      })),
    ],
    conversationId,
    userIds: ["2222"],
    title: "Roster test",
  });
  const removedResponse = await post(
    "/api/group/members/remove",
    groupMembersRemoveRequest(removed, ["2222"], added.conversationKeyVersion),
  );
  assert.deepEqual(removedResponse.body.data.member_ids.sort(), [vectors.event_sender_id, "3333"].sort());

  const currentVersion = removed.conversationKeyVersion;
  const action = (id) => ({
    message_id: id,
    encoded_message_event_detail: "encoded",
    message_event_signature: {
      signature: "sig",
      signature_version: "1",
      public_key_version: "1",
      signing_public_key: "spki",
    },
  });
  const rotation = (participantIds) => ({
    conversation_key_version: "999",
    conversation_participant_keys: participantIds.map((userId) => ({
      user_id: userId,
      encrypted_conversation_key: "wrapped",
      public_key_version: "1",
    })),
  });
  const addBody = (userIds, participantIds) => ({
    conversation_id: conversationId,
    expected_key_version: currentVersion,
    user_ids: userIds,
    ...rotation(participantIds),
    action_signatures: [action("a"), action("b")],
  });
  const removeBody = (userIds, participantIds) => ({
    conversation_id: conversationId,
    expected_key_version: currentVersion,
    user_ids: userIds,
    group_key_rotation_data: rotation(participantIds),
    action_signatures: [action("a")],
  });

  const addExisting = await post("/api/group/members/add", addBody(["3333"], [vectors.event_sender_id, "3333"]));
  assert.equal(addExisting.response.status, 400);
  assert.equal(addExisting.body.error, "Invalid group member add");
  const addWithoutKey = await post(
    "/api/group/members/add",
    addBody(["4444"], [vectors.event_sender_id, "3333", "4444"]),
  );
  assert.equal(addWithoutKey.response.status, 400);
  assert.equal(addWithoutKey.body.error, "Invalid group member add");
  const removeSelf = await post("/api/group/members/remove", removeBody([vectors.event_sender_id], ["3333"]));
  assert.equal(removeSelf.response.status, 400);
  assert.equal(removeSelf.body.error, "Invalid group member removal");
  const removeNonMember = await post("/api/group/members/remove", removeBody(["2222"], ["3333"]));
  assert.equal(removeNonMember.response.status, 400);
  assert.equal(removeNonMember.body.error, "Invalid group member removal");
  const rotationMismatch = await post("/api/group/members/add", addBody(["3334"], [vectors.event_sender_id, "3333"]));
  assert.equal(rotationMismatch.response.status, 400);
  assert.equal(rotationMismatch.body.error, "Group rotation roster mismatch");

  const { body: rosterAfter } = await request(
    `/api/group/roster?conversation_id=${encodeURIComponent(conversationId)}`,
  );
  assert.deepEqual(rosterAfter.data.memberIds.sort(), [vectors.event_sender_id, "3333"].sort());
  assert.equal(rosterAfter.data.keyVersion, currentVersion);
});

test("mock-only identity registration accepts generated public keys without receiving private key material", async () => {
  const chat = await createChat();
  const registration = chat.generateKeypairs();
  const { body } = await post("/api/mock/identity", {
    user_id: "3333",
    public_key: registration.publicKey,
  });
  assert.deepEqual(body.data, { user_id: "3333", public_key_version: "1", username: "new_fixture" });
  const { body: keys } = await request("/api/public-keys?user_id=3333");
  assert.equal(
    chat.verifyKeyBinding(
      keys.data[0].public_key,
      keys.data[0].signing_public_key,
      keys.data[0].identity_public_key_signature,
    ),
    true,
  );
  assert.equal("private_key" in keys.data[0], false);
});

test("generated Mock aliases resolve exactly and pass the full new-chat preflight", async () => {
  const userIds = ["7654321098765432101", "7654321098765432102"];
  const registrations = [];
  for (const userId of userIds) {
    const identity = await createChat();
    const registration = identity.generateKeypairs();
    const result = await post("/api/mock/identity", { user_id: userId, public_key: registration.publicKey });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.data.username, mockUsernameAlias(userId));
    registrations.push({ userId, identity, alias: result.body.data.username });
  }
  assert.notEqual(registrations[0].alias, registrations[1].alias);

  for (const { userId, identity, alias } of registrations) {
    const { body: lookup } = await request(`/api/contacts/lookup?username=${encodeURIComponent(alias)}`);
    assert.equal(lookup.data.authenticated_user_id, vectors.event_sender_id);
    assert.equal(lookup.data.user.id, userId);
    assert.equal(lookup.data.user.username, alias);
    assert.equal(lookup.data.user.receives_your_chat, "encrypted");
    assert.equal(lookup.data.conversation_lookup, "available");
    assert.deepEqual(lookup.data.conversations.data, []);

    const { body: ownerKeys } = await request(`/api/public-keys?user_id=${vectors.event_sender_id}`);
    const { body: recipientKeys } = await request(`/api/public-keys?user_id=${userId}`);
    assert.ok(ownerKeys.data.length > 0);
    assert.equal(recipientKeys.data.length, 1);
    for (const key of [...ownerKeys.data, ...recipientKeys.data]) {
      assert.equal(
        identity.verifyKeyBinding(key.public_key, key.signing_public_key, key.identity_public_key_signature),
        true,
      );
    }
    const existing = resolveExistingDirectConversation(
      lookup.data.conversations.data,
      [],
      vectors.event_sender_id,
      userId,
      lookup.data.conversation_lookup,
    );
    assert.equal(
      canConfirmDirectChat(
        {
          identityVerified: lookup.data.authenticated_user_id === vectors.event_sender_id,
          conversationLookup: lookup.data.conversation_lookup,
          existing,
          permission: permissionForEncryptedChat(lookup.data.user.receives_your_chat),
          keyStatus: "verified",
        },
        "mock",
        true,
        true,
      ),
      true,
    );
  }
});

test("Mock identity alias collisions fail without replacing the existing user or publishing keys", async () => {
  const userId = "7654321098765432103";
  const identity = await createChat();
  const registration = identity.generateKeypairs();
  const alias = mockUsernameAlias(userId);
  const result = await post("/api/mock/identity", { user_id: userId, public_key: registration.publicKey });
  assert.equal(result.response.status, 409);

  const { body: lookup } = await request(`/api/contacts/lookup?username=${encodeURIComponent(alias)}`);
  assert.equal(lookup.data.user.id, "4567");
  const { body: keys } = await request(`/api/public-keys?user_id=${userId}`);
  assert.deepEqual(keys.data, []);
});

test("mock conversations expose unread state and delivery queue simulates offline, duplicate, and out-of-order reconnect", async () => {
  const { body: conversations } = await request("/api/conversations");
  assert.ok(conversations.data.length > 0);
  const firstConversation = conversations.data.find((conversation) => conversation.type === "direct");
  assert.ok(firstConversation);
  assert.equal(typeof firstConversation.id, "string");
  assert.equal(firstConversation.type, "direct");
  assert.equal(firstConversation.participant_ids.includes(vectors.event_sender_id), true);
  const read = await post("/api/conversations/read", { conversation_id: firstConversation.id });
  assert.equal(read.body.data.status, "read");
  const { body: afterRead } = await request("/api/conversations");
  assert.equal(afterRead.data.find((entry) => entry.id === firstConversation.id).unread, false);

  const enabledOffline = await post("/api/mock/network", { offline: true, order: "normal", duplicate: false });
  assert.equal(enabledOffline.body.data.offline, true);
  const offline = await request("/api/me");
  assert.equal(offline.response.status, 503);
  assert.equal(offline.body.retryable, true);
  await post("/api/mock/network", { offline: false, order: "reverse", duplicate: true });
  const { body: deliveries } = await request("/api/mock/deliveries?after=0");
  assert.ok(deliveries.data.length >= 2);
  assert.equal(deliveries.data.length % 2, 0);
  assert.equal(deliveries.data[0].delivery_id, deliveries.data[1].delivery_id);
  assert.equal(deliveries.meta.next_cursor, String(deliveries.data.length / 2));
  await post("/api/mock/network", { offline: false, order: "normal", duplicate: false });
});

test("mock adapter enforces local request, validation, body-size, and route errors", async () => {
  const noHeader = await request("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(noHeader.response.status, 403);
  assert.equal(noHeader.body.error, "Local app request required");
  assert.equal(noHeader.body.retryable, false);
  const wrongContentType = await request("/api/send", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-chat-local": "1" },
    body: "{}",
  });
  assert.equal(wrongContentType.response.status, 403);
  assert.equal(wrongContentType.body.error, "Local app request required");

  const invalidConversation = await request("/api/events?conversation_id=not%20an%20id");
  assert.equal(invalidConversation.response.status, 400);
  assert.equal(invalidConversation.body.error, "Invalid conversation_id");
  const oversizedCursor = await request(
    `/api/events?conversation_id=${encodeURIComponent(vectors.event_conversation_id)}&pagination_token=${"x".repeat(2049)}`,
  );
  assert.equal(oversizedCursor.response.status, 400);
  assert.equal(oversizedCursor.body.error, "Invalid pagination_token");

  const missingRequiredInputs = [
    request("/api/public-keys"),
    request("/api/events"),
    post("/api/media/initialize", {}),
    post("/api/media/append", {}),
    post("/api/media/finalize", {}),
    request("/api/media/download"),
  ];
  for (const pending of missingRequiredInputs) {
    const result = await pending;
    assert.equal(result.response.status, 400);
    assert.match(result.body.error, /^Invalid /);
  }

  const wrongOrigin = await post("/api/send", {}, { origin: "http://localhost:8787" });
  assert.equal(wrongOrigin.response.status, 403);
  assert.equal(wrongOrigin.body.error, "Local app request required");

  const missingPayload = await post("/api/send", {});
  assert.equal(missingPayload.response.status, 400);
  assert.equal(missingPayload.body.error, "Invalid conversation_id");

  const invalidSize = await post("/api/media/initialize", {
    conversation_id: vectors.event_conversation_id,
    total_bytes: 0,
  });
  assert.equal(invalidSize.response.status, 400);
  assert.equal(invalidSize.body.error, "Invalid total_bytes");
  const invalidSegment = await post("/api/media/append", {
    conversation_id: vectors.event_conversation_id,
    session_id: "invalid-session",
    media_hash_key: "invalid-media",
    segment_index: -1,
    media: "AQ==",
  });
  assert.equal(invalidSegment.response.status, 400);
  assert.equal(invalidSegment.body.error, "Invalid segment_index");
  const oversizedSegment = await post("/api/media/append", {
    conversation_id: vectors.event_conversation_id,
    session_id: "invalid-session",
    media_hash_key: "invalid-media",
    segment_index: 1000,
    media: "AQ==",
  });
  assert.equal(oversizedSegment.response.status, 400);
  assert.equal(oversizedSegment.body.error, "Invalid segment_index");

  const malformedJson = await request("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-local": "1" },
    body: "{",
  });
  assert.equal(malformedJson.response.status, 400);
  assert.equal(typeof malformedJson.body.error, "string");

  const tooLarge = await request("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json", "x-chat-local": "1" },
    body: "x".repeat(5 * 1024 * 1024 + 1),
  });
  assert.equal(tooLarge.response.status, 413);
  assert.equal(tooLarge.body.error, "Request body too large");

  const unknown = await request("/api/unknown");
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.error, "Unknown API route");
  const wrongMethod = await post("/api/status", {});
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "GET");
  assert.equal(wrongMethod.body.error, "Method not allowed");

  const publicTraversal = await request("/%2e%2e/server.mjs");
  assert.equal(publicTraversal.response.status, 404);
  const sdkTraversal = await request("/sdk/%2e%2e/server.mjs");
  assert.equal(sdkTraversal.response.status, 404);

  const index = await request("/");
  assert.equal(index.response.status, 200);
  assert.equal(index.response.headers.get("cache-control"), "no-store");
  assert.match(index.response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(index.response.headers.get("content-security-policy"), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(index.response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(index.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(index.response.headers.get("x-frame-options"), "DENY");
  const html = new TextDecoder().decode(index.body);
  const modulePath = html.match(/<script[^>]+src="([^"]+\.js)"/)?.[1];
  assert.ok(modulePath);
  const module = await request(modulePath);
  assert.equal(module.response.status, 200);
  assert.match(module.response.headers.get("content-type"), /^text\/javascript/);
  const status = await request("/api/status");
  assert.equal(
    status.response.headers.get("content-security-policy"),
    index.response.headers.get("content-security-policy"),
  );
});
