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
import { createMockStore } from "./lib/mock-store.mjs";
import { lookupDirectConversations } from "./lib/direct-conversation-lookup.mjs";
import {
  base64,
  directConversationKeysPayload,
  groupCreatePayload,
  groupMemberMutationPayload,
  identifier,
  mediaSegmentIndex,
  mockIdentityPayload,
  mockNetworkPayload,
  paginationToken,
  positiveInteger,
  required,
  userId,
} from "./lib/api-validation.mjs";

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
  "/api/health": ["GET"],
  "/api/metrics": ["GET"],
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
const { mock, mockFixture, mockJson } = createMockStore(
  mode === "mock" && process.env.X_CHAT_MOCK_FIXTURE ? JSON.parse(process.env.X_CHAT_MOCK_FIXTURE) : {},
);
const liveCreatePermit = createLiveCreatePermit();
const startedAt = Date.now();
const metrics = { requests: 0, responses: new Map(), serverErrors: 0 };

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    ...headers,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body.error && body.retryable === undefined ? { ...body, retryable: false } : body));
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
    lookupDirectConversations: (ownerUserId, recipientUserId) =>
      lookupDirectConversations(adapterJson, ownerUserId, recipientUserId),
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
  if (path === "/api/health" && req.method === "GET") {
    const sdkInstalled = await stat(sdkDir).then(
      () => true,
      () => false,
    );
    return json(res, 200, {
      status: sdkInstalled ? "ok" : "degraded",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      mode,
      tokenConfigured: Boolean(token),
      sdkInstalled,
    });
  }
  if (path === "/api/metrics" && req.method === "GET") {
    return json(res, 200, {
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      requests: metrics.requests,
      responses: Object.fromEntries([...metrics.responses].sort()),
      serverErrors: metrics.serverErrors,
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
    } = await lookupDirectConversations(adapterJson, authenticatedUserId, String(recipient.id));
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
  metrics.requests += 1;
  res.on("finish", () => {
    const bucket = `${Math.floor(res.statusCode / 100)}xx`;
    metrics.responses.set(bucket, (metrics.responses.get(bucket) || 0) + 1);
    if (res.statusCode >= 500) metrics.serverErrors += 1;
  });
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    return await serve(res, staticDir, file);
  } catch (error) {
    json(res, error?.status || 400, { error: error.message, retryable: error?.retryable === true });
  }
});

server.on("error", (error) => {
  if ("code" in error && error.code === "EADDRINUSE") {
    console.error(
      `X Chat local inbox: 127.0.0.1:${port} is already in use. ` +
        "Stop the other instance or set PORT to a free port.",
    );
    process.exit(1);
  }
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  port = boundPort;
  console.log(`X Chat local inbox: http://127.0.0.1:${boundPort}`);
});
