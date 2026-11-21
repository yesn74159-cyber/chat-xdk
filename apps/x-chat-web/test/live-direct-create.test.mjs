import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { createChat } from "@xdevplatform/chat-xdk";
import { prepareDirectConversationChange } from "../public/conversation-key-plan.mjs";
import { createLiveDirectCreateAdapter } from "../lib/live-direct-create.mjs";
import { createLiveCreatePermit, liveCreateTargetFromEnv } from "../lib/live-create-permit.mjs";

const TEST_TARGET = Object.freeze({
  ownerUsername: "owner-test",
  ownerUserId: "1001",
  recipientUsername: "peer",
  recipientUserId: "2002",
  conversationId: "1001:2002",
});

async function createHarness(options = {}) {
  const ownerChat = await createChat();
  const ownerRegistration = ownerChat.generateKeypairs().publicKey;
  const recipientChat = await createChat();
  const recipientRegistration = recipientChat.generateKeypairs().publicKey;
  const ownerUserId = options.ownerUserId || "1001";
  const recipientUserId = options.recipientUserId || "2002";
  const recipientUsername = (options.recipientUsername || "peer").replace(/^@/, "").toLowerCase();
  ownerChat.setIdentity({ userId: ownerUserId, signingKeyVersion: "1" });
  ownerChat.setSigningKeys([
    {
      userId: ownerUserId,
      publicKeyVersion: "1",
      publicKey: ownerRegistration.signingPublicKey,
      identityPublicKey: ownerRegistration.publicKey,
      identityPublicKeySignature: ownerRegistration.identityPublicKeySignature,
    },
    {
      userId: recipientUserId,
      publicKeyVersion: "1",
      publicKey: recipientRegistration.signingPublicKey,
      identityPublicKey: recipientRegistration.publicKey,
      identityPublicKeySignature: recipientRegistration.identityPublicKeySignature,
    },
  ]);
  const plan = prepareDirectConversationChange(
    ownerChat,
    [
      { userId: ownerUserId, publicKeyVersion: "1", identityPublicKey: ownerRegistration.publicKey },
      { userId: recipientUserId, publicKeyVersion: "1", identityPublicKey: recipientRegistration.publicKey },
    ],
    ownerUserId,
    recipientUserId,
  );
  const verifyChat = await createChat();
  const records = {
    [ownerUserId]: [
      {
        public_key_version: "1",
        public_key: ownerRegistration.publicKey,
        signing_public_key: ownerRegistration.signingPublicKey,
        identity_public_key_signature: ownerRegistration.identityPublicKeySignature,
      },
    ],
    [recipientUserId]: [
      {
        public_key_version: "1",
        public_key: recipientRegistration.publicKey,
        signing_public_key: recipientRegistration.signingPublicKey,
        identity_public_key_signature: recipientRegistration.identityPublicKeySignature,
      },
    ],
  };
  const fake = {
    requests: [],
    records,
    accountId: ownerUserId,
    recipientPermission: "encrypted",
    recipientUsername,
    lookup: "available",
    postStatus: 200,
    postBehavior: "normal",
  };
  if (options.invalidRecipientBinding) {
    records[recipientUserId][0].identity_public_key_signature = "invalid";
  }
  if (options.ownerId) fake.accountId = options.ownerId;
  if (options.permission) fake.recipientPermission = options.permission;
  if (options.lookup) fake.lookup = options.lookup;
  if (options.postStatus) fake.postStatus = options.postStatus;
  if (options.postBehavior) fake.postBehavior = options.postBehavior;

  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/2/users/me") {
      fake.requests.push({ method: req.method, path: url.pathname });
      return sendJson(res, 200, { data: { id: fake.accountId } });
    }
    if (req.method === "GET" && url.pathname === `/2/users/by/username/${fake.recipientUsername}`) {
      fake.requests.push({ method: req.method, path: url.pathname });
      return sendJson(res, 200, {
        data: {
          id: recipientUserId,
          username: fake.recipientUsername,
          receives_your_chat: fake.recipientPermission,
        },
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/2/users/") && url.pathname.endsWith("/public_keys")) {
      const userId = url.pathname.split("/")[3];
      fake.requests.push({ method: req.method, path: url.pathname });
      return sendJson(res, 200, { data: records[userId] || [] });
    }
    if (req.method === "GET" && url.pathname === "/2/chat/conversations") {
      fake.requests.push({ method: req.method, path: url.pathname, query: url.search });
      const data = fake.lookup === "existing" ? [{ id: plan.conversationId, type: "direct" }] : [];
      return sendJson(res, 200, { data, meta: { has_more: false } });
    }
    if (req.method === "POST" && url.pathname === `/2/chat/conversations/${recipientUserId}/keys`) {
      let rawBody = "";
      for await (const chunk of req) rawBody += chunk;
      const body = JSON.parse(rawBody);
      fake.requests.push({ method: req.method, path: url.pathname, body });
      if (fake.postBehavior === "timeout-after") {
        fake.lookup = "existing";
        res.destroy();
        return;
      }
      if (fake.postStatus !== 200) {
        return sendJson(res, fake.postStatus, { error: "simulated upstream status" });
      }
      fake.lookup = "existing";
      return sendJson(res, 200, {
        data: { conversation_id: plan.conversationId, sequence_id: "seq-test-1" },
      });
    }
    return sendJson(res, 404, { error: "unknown fake X API path" });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Fake X API did not bind a TCP port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function fakeJson(path, method = "GET", body) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("fake X API error"), { status: response.status });
    return payload;
  }

  function makeAdapter(permit = options.permit) {
    return createLiveDirectCreateAdapter({
      isAuthorized: permit ? (input) => permit.isAuthorized(input) : () => options.authorized === true,
      claimAuthorization: permit ? (input) => permit.claim(input) : undefined,
      getAuthenticatedUser: () => fakeJson("/2/users/me").then((response) => response.data),
      lookupRecipient: (username) =>
        fakeJson(`/2/users/by/username/${encodeURIComponent(username)}`).then((response) => response.data),
      lookupDirectConversations: async () => {
        const response = await fakeJson("/2/chat/conversations?max_results=100");
        return { lookup: fake.lookup, conversations: { data: response.data } };
      },
      getPublicKeys: (userId) => fakeJson(`/2/users/${userId}/public_keys`),
      verifyKeyBinding: (identityKey, signingKey, signature) =>
        verifyChat.verifyKeyBinding(identityKey, signingKey, signature),
      post: async (path, body) => {
        if (fake.postBehavior === "timeout-before") {
          throw Object.assign(new Error("simulated timeout"), { status: 408 });
        }
        return fakeJson(path, "POST", body);
      },
    });
  }
  const input = {
    owner_user_id: ownerUserId,
    owner_signing_key_version: "1",
    recipient_user_id: recipientUserId,
    recipient_username: `@${recipientUsername}`,
    recipient_consent_confirmed: true,
    final_approval_confirmed: true,
    conversation_id: options.conversationId || plan.conversationId,
    request_body: plan.requestBody,
  };

  return {
    adapter: makeAdapter(),
    recreateAdapter: () => makeAdapter(options.permitOnRestart?.() || options.permit),
    fake,
    input,
    plan,
    ownerChat,
    upstream,
    close: async () => {
      plan.conversationKey.fill(0);
      ownerChat.lock();
      await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorStatus(error) {
  return error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
}

function errorIsRetryable(error) {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}

async function withHarness(options, run) {
  const harness = await createHarness(options);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

test("closed adapter returns 501 before contacting the fake X API", async () => {
  await withHarness({}, async ({ adapter, input, fake }) => {
    await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === 501);
    assert.deepEqual(fake.requests, []);
  });
});

test("authorized harness sends exactly one signed request to the official recipient path", async () => {
  await withHarness({ authorized: true }, async ({ adapter, input, fake, plan }) => {
    assert.equal(plan.conversationId, "1001:2002");
    const result = await adapter.initialize(input);
    const posts = fake.requests.filter((request) => request.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].path, "/2/chat/conversations/2002/keys");
    assert.deepEqual(posts[0].body, plan.requestBody);
    assert.equal(posts[0].body.conversation_key_version, plan.conversationKeyVersion);
    assert.deepEqual(posts[0].body.conversation_participant_keys.map((key) => key.user_id).sort(), ["1001", "2002"]);
    assert.equal(posts[0].body.action_signatures.length, 1);
    assert.equal(result.data.conversation_id, plan.conversationId);
    assert.equal(result.data.sequence_id, "seq-test-1");
  });
});

test("Live adapter rejects a reversed canonical ID before contacting the fake X API", async () => {
  await withHarness({ authorized: true }, async ({ adapter, input, fake, plan }) => {
    await assert.rejects(
      adapter.initialize({ ...input, conversation_id: "2002:1001" }),
      (error) => errorStatus(error) === 400,
    );
    assert.equal(fake.requests.length, 0);
    assert.equal(plan.conversationId, "1001:2002");
  });
});

test("one-shot permit allows only its exact target once and stays consumed across adapter recreation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-permit-"));
  const permitPath = join(directory, "live-create-permit.json");
  const consumedPath = join(directory, "live-create-consumed");
  const permit = createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET });
  await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
  try {
    await withHarness(
      {
        ownerUserId: TEST_TARGET.ownerUserId,
        recipientUserId: TEST_TARGET.recipientUserId,
        recipientUsername: TEST_TARGET.recipientUsername,
        conversationId: TEST_TARGET.conversationId,
        permit,
        permitOnRestart: () => createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET }),
      },
      async ({ adapter, recreateAdapter, input, fake, plan }) => {
        assert.equal(input.conversation_id, TEST_TARGET.conversationId, input.conversation_id);
        assert.equal(plan.conversationId, input.conversation_id);
        const unauthorizedInputs = [
          { ...input, owner_user_id: "9999" },
          { ...input, recipient_user_id: "2003" },
          { ...input, recipient_username: "@other" },
          { ...input, conversation_id: "2002:1001" },
        ];
        for (const unauthorized of unauthorizedInputs) {
          await assert.rejects(adapter.initialize(unauthorized), (error) => errorStatus(error) === 501);
        }
        assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
        assert.equal(await permit.isEnabled(), true);

        const result = await adapter.initialize(input);
        assert.equal(result.data.conversation_id, TEST_TARGET.conversationId);
        assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
        assert.equal(
          fake.requests.find((request) => request.method === "POST").path,
          `/2/chat/conversations/${TEST_TARGET.recipientUserId}/keys`,
        );
        assert.equal(await permit.isEnabled(), false);

        await assert.rejects(recreateAdapter().initialize(input), (error) => errorStatus(error) === 501);
        assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
        assert.deepEqual(fake.requests.find((request) => request.method === "POST").body, plan.requestBody);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-shot claim is atomic across independently locked adapters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-race-"));
  const permitPath = join(directory, "live-create-permit.json");
  const consumedPath = join(directory, "live-create-consumed");
  const permit = createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET });
  await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
  try {
    await withHarness(
      {
        ownerUserId: TEST_TARGET.ownerUserId,
        recipientUserId: TEST_TARGET.recipientUserId,
        recipientUsername: TEST_TARGET.recipientUsername,
        conversationId: TEST_TARGET.conversationId,
        permit,
      },
      async ({ adapter, recreateAdapter, input, fake }) => {
        const outcomes = await Promise.allSettled([adapter.initialize(input), recreateAdapter().initialize(input)]);
        assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        assert.ok(rejected && [409, 501].includes(errorStatus(rejected.reason)));
        assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeout and HTTP 429 consume the permit and cannot POST again after adapter recreation", async () => {
  for (const scenario of [
    { postBehavior: "timeout-before", status: 408, postCount: 0 },
    { postStatus: 429, status: 429, postCount: 1 },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-uncertain-"));
    const permitPath = join(directory, "live-create-permit.json");
    const consumedPath = join(directory, "live-create-consumed");
    const permit = createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET });
    await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
    try {
      await withHarness(
        {
          ...scenario,
          ownerUserId: TEST_TARGET.ownerUserId,
          recipientUserId: TEST_TARGET.recipientUserId,
          recipientUsername: TEST_TARGET.recipientUsername,
          conversationId: TEST_TARGET.conversationId,
          permit,
          permitOnRestart: () => createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET }),
        },
        async ({ adapter, recreateAdapter, input, fake }) => {
          await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === scenario.status);
          assert.equal(fake.requests.filter((request) => request.method === "POST").length, scenario.postCount);
          await assert.rejects(recreateAdapter().initialize(input), (error) => errorStatus(error) === 501);
          assert.equal(fake.requests.filter((request) => request.method === "POST").length, scenario.postCount);
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("one-shot permit rejects expired and longer-than-ten-minute authorizations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-expiry-"));
  const permitPath = join(directory, "live-create-permit.json");
  const consumedPath = join(directory, "live-create-consumed");
  let currentTime = Date.now();
  const permit = createLiveCreatePermit({ permitPath, consumedPath, now: () => currentTime, target: TEST_TARGET });
  try {
    await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(currentTime + 11 * 60 * 1000).toISOString() }));
    assert.equal(await permit.isEnabled(), false);
    await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(currentTime + 5 * 60 * 1000).toISOString() }));
    assert.equal(await permit.isEnabled(), true);
    currentTime += 5 * 60 * 1000;
    assert.equal(await permit.isEnabled(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one-shot permit is disabled when absent or already durably claimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-state-"));
  const permitPath = join(directory, "live-create-permit.json");
  const consumedPath = join(directory, "live-create-consumed");
  const permit = createLiveCreatePermit({ permitPath, consumedPath, target: TEST_TARGET });
  try {
    assert.equal(await permit.isEnabled(), false);
    await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
    assert.equal(await permit.isEnabled(), true);
    await writeFile(consumedPath, "consumed\n");
    assert.equal(await permit.isEnabled(), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("server-side OAuth identity mismatch blocks the fake upstream write", async () => {
  await withHarness({ authorized: true, ownerId: "9999" }, async ({ adapter, input, fake }) => {
    await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === 403);
    assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
  });
});

test("missing recipient encryption permission blocks the fake upstream write", async () => {
  await withHarness({ authorized: true, permission: "none" }, async ({ adapter, input, fake }) => {
    await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === 403);
    assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
  });
});

test("Live Create target is parsed only from a complete, distinct environment", () => {
  assert.equal(liveCreateTargetFromEnv({}), null);
  const base = {
    X_CHAT_LIVE_OWNER_USER_ID: "1001",
    X_CHAT_LIVE_OWNER_USERNAME: "owner",
    X_CHAT_LIVE_RECIPIENT_USER_ID: "2002",
    X_CHAT_LIVE_RECIPIENT_USERNAME: "peer",
  };
  assert.equal(liveCreateTargetFromEnv(base)?.conversationId, "1001:2002");
  assert.equal(liveCreateTargetFromEnv({ ...base, X_CHAT_LIVE_RECIPIENT_USER_ID: "1001" }), null);
  assert.equal(liveCreateTargetFromEnv({ ...base, X_CHAT_LIVE_OWNER_USER_ID: "1001x" }), null);
  assert.equal(liveCreateTargetFromEnv({ ...base, X_CHAT_LIVE_OWNER_USERNAME: "bad name" }), null);
  assert.equal(liveCreateTargetFromEnv({ ...base, X_CHAT_LIVE_RECIPIENT_USERNAME: undefined }), null);
});

test("a permit without a configured target rejects even a valid-looking request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "x-chat-live-create-unset-"));
  const permitPath = join(directory, "live-create-permit.json");
  const consumedPath = join(directory, "live-create-consumed");
  const permit = createLiveCreatePermit({ permitPath, consumedPath, target: null });
  await writeFile(permitPath, JSON.stringify({ expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString() }));
  try {
    assert.equal(permit.isTargetConfigured(), false);
    const request = {
      owner_user_id: "1001",
      recipient_user_id: "2002",
      recipient_username: "@peer",
      conversation_id: "1001:2002",
    };
    assert.equal(await permit.isAuthorized(request), false);
    await assert.rejects(permit.claim(request), (error) => errorStatus(error) === 501);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid public-key binding blocks the fake upstream write", async () => {
  await withHarness({ authorized: true, invalidRecipientBinding: true }, async ({ adapter, input, fake }) => {
    await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === 403);
    assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
  });
});

test("existing, ambiguous, and incomplete room results fail closed", async () => {
  for (const lookup of ["existing", "ambiguous", "incomplete"]) {
    await withHarness({ authorized: true, lookup }, async ({ adapter, input, fake }) => {
      await assert.rejects(adapter.initialize(input), (error) => [409, 503].includes(errorStatus(error)));
      assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
    });
  }
});

test("concurrent server requests claim once before asynchronous identity checks", async () => {
  await withHarness({ authorized: true }, async ({ input, fake, plan, upstream }) => {
    const requestsBefore = fake.requests.length;
    let releaseIdentity = () => {};
    let identityCalls = 0;
    const adapter = createLiveDirectCreateAdapter({
      isAuthorized: () => true,
      getAuthenticatedUser: () => {
        identityCalls += 1;
        if (identityCalls > 1) return Promise.resolve({ id: "1001" });
        return new Promise((resolve) => {
          releaseIdentity = () => resolve({ id: "1001" });
        });
      },
      lookupRecipient: async () => ({ id: "2002", username: "peer", receives_your_chat: "encrypted" }),
      lookupDirectConversations: async () => ({ lookup: "available", conversations: { data: [] } }),
      getPublicKeys: async (userId) => ({
        data: fake.records?.[userId] || [],
      }),
      verifyKeyBinding: () => true,
      post: async () => ({ data: { conversation_id: plan.conversationId } }),
    });
    const first = adapter.initialize(input);
    const duplicate = await adapter.initialize(input).then(
      () => null,
      (error) => error,
    );
    assert.equal(duplicate.status, 409);
    assert.equal(fake.requests.length, requestsBefore);
    releaseIdentity();
    await first;
    assert.equal(identityCalls, 2);
    assert.equal(fake.requests.filter((request) => request.method === "POST").length, 0);
    assert.ok(upstream.listening);
  });
});

test("X HTTP errors and unknown network outcomes are not retried", async () => {
  for (const status of [401, 403, 408, 409, 429, 503]) {
    await withHarness({ authorized: true, postStatus: status }, async ({ adapter, input, fake }) => {
      await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === status);
      const retry = await adapter.initialize(input).then(
        () => null,
        (error) => error,
      );
      assert.equal(retry.status, 409);
      assert.equal(fake.requests.filter((request) => request.method === "POST").length, 1);
    });
  }
});

test("timeout before acceptance and timeout after fake acceptance both lock without retry", async () => {
  for (const postBehavior of ["timeout-before", "timeout-after"]) {
    await withHarness({ authorized: true, postBehavior }, async ({ adapter, input, fake }) => {
      await assert.rejects(
        adapter.initialize(input),
        (error) => [408, 502].includes(errorStatus(error)) && errorIsRetryable(error),
      );
      assert.equal(
        fake.requests.filter((request) => request.method === "POST").length,
        postBehavior === "timeout-after" ? 1 : 0,
      );
      assert.equal(fake.lookup, postBehavior === "timeout-after" ? "existing" : "available");
      await assert.rejects(adapter.initialize(input), (error) => errorStatus(error) === 409);
      assert.equal(
        fake.requests.filter((request) => request.method === "POST").length,
        postBehavior === "timeout-after" ? 1 : 0,
      );
    });
  }
});
