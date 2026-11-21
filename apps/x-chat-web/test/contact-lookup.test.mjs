import assert from "node:assert/strict";
import test from "node:test";
import {
  canConfirmDirectChat,
  claimDirectChatAttempt,
  createLookupEpoch,
  isCurrentOAuthIdentity,
  matchesDirectChatRecipient,
  findExistingDirectConversation,
  normalizeUsername,
  permissionForEncryptedChat,
  requiresExplicitDirectLookup,
  resolveExistingDirectConversation,
  zeroizePreparedDirectChat,
} from "../public/contact-lookup.mjs";
import { mapConversationResponse } from "../public/conversation-list.mjs";
import { lookupContactsWithLimit, parseContactUsernames } from "../public/multi-contact-lookup.mjs";
import {
  isCanonicalDirectConversationId,
  prepareConversationKeyPlan,
  prepareDirectConversationChange,
  validateDirectConversationInitialization,
} from "../public/conversation-key-plan.mjs";
import { canonicalDirectConversationId } from "../public/direct-conversation-id.mjs";
import { runLiveCreateReadinessPreview } from "../public/live-create-preview.mjs";
import {
  createLiveCreatePreparation,
  exactRecipientAndCanonicalId,
  reconciliationResult,
  zeroizeLiveCreateKeys,
} from "../public/live-create-preparation.mjs";

const previewRecipient = { id: "2", username: "peer" };
const previewKeys = { encryption: [{}], signing: [{}] };
const previewLookup = {
  authenticated_user_id: "1",
  user: { id: "2", username: "peer", receives_your_chat: "encrypted" },
  conversations: { data: [], includes: { users: [] } },
  conversation_lookup: "available",
};

function previewHarness(overrides = {}) {
  const calls = [];
  const options = {
    expectedUserId: "1",
    unlockedUserId: "1",
    recipient: previewRecipient,
    getOAuthIdentity: async () => {
      calls.push("oauth");
      return { id: "1" };
    },
    lookupRecipient: async () => {
      calls.push("lookup");
      return previewLookup;
    },
    getOwnKeys: async () => {
      calls.push("own-keys");
      return previewKeys;
    },
    getRecipientKeys: async () => {
      calls.push("recipient-keys");
      return previewKeys;
    },
    post: () => calls.push("post"),
    initializeConversation: () => calls.push("initialize"),
    sendMessage: () => calls.push("send"),
    verifyOwnKeyBinding: () => true,
    getLocalState: () => ({ consentChecked: true }),
    ...overrides,
  };
  return { calls, run: () => runLiveCreateReadinessPreview(options) };
}

function previewCheck(preview, id) {
  return preview.checks.find((check) => check.id === id);
}

test("Live Create preparation is hard-disabled and never invokes an initiate function", async () => {
  let mutationCalls = 0;
  const rawKeys = [new Uint8Array([1, 2])];
  const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: false });
  const result = await preparation.prepare({
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    rawKeys,
    initiateLivePost: () => {
      mutationCalls += 1;
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(result.httpStatus, 501);
  assert.equal(mutationCalls, 0);
  assert.deepEqual([...rawKeys[0]], [0, 0]);
});

test("Live Create preparation requires recipient consent and separate final approval", async () => {
  const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
  for (const approvals of [
    { recipientConsentConfirmed: false, finalApprovalConfirmed: true },
    { recipientConsentConfirmed: true, finalApprovalConfirmed: false },
  ]) {
    const rawKeys = [new Uint8Array([1, 2])];
    const result = await preparation.prepare({ ...approvals, rawKeys });
    assert.equal(result.status, "blocked");
    assert.deepEqual([...rawKeys[0]], [0, 0]);
  }
});

test("Live Create preparation validates exact recipient and canonical conversation IDs", async () => {
  assert.equal(exactRecipientAndCanonicalId("1", "2", "1:2"), true);
  assert.equal(exactRecipientAndCanonicalId("1", "2", "2:1"), false);
  assert.equal(exactRecipientAndCanonicalId("1", "2", "1-2"), false);
  assert.equal(exactRecipientAndCanonicalId("1", "1", "1:1"), false);
  assert.equal(exactRecipientAndCanonicalId("1", "3", "1:2"), false);
});

test("Live Create preparation blocks duplicate submission and reconciliation outcomes without retry", async () => {
  const options = {
    expectedUserId: "1",
    recipientUserId: "2",
    conversationId: "1:2",
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    revalidateImmediately: async ({ expectedUserId, recipientUserId, conversationId }) => ({
      status: "ready",
      oauthUserId: expectedUserId,
      recipientUserId,
      conversationId,
    }),
  };
  let mutationCalls = 0;
  let revalidationCalls = 0;
  const revalidateImmediately = options.revalidateImmediately;
  options.revalidateImmediately = async (...args) => {
    revalidationCalls += 1;
    return revalidateImmediately(...args);
  };
  const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
  const first = await preparation.prepare({
    ...options,
    initiateLivePost: async () => {
      mutationCalls += 1;
      throw Object.assign(new Error("outcome unknown"), { status: 408 });
    },
  });
  assert.equal(first.status, "reconcile");
  assert.equal(first.requiresReconciliation, true);
  assert.equal(first.automaticRetry, false);
  const duplicateKeys = [new Uint8Array([1])];
  const duplicate = await preparation.prepare({
    ...options,
    rawKeys: duplicateKeys,
    initiateLivePost: () => (mutationCalls += 1),
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(mutationCalls, 1);
  assert.equal(revalidationCalls, 1);
  assert.deepEqual([...duplicateKeys[0]], [0]);

  for (const status of [408, 409, 429, 503, 0]) {
    const result = reconciliationResult(status);
    assert.equal(result.requiresReconciliation, true);
    assert.equal(result.automaticRetry, false);
  }
});

test("Live Create preparation zeroizes raw keys after error and blocks failed revalidation", async () => {
  const rawKeys = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
  const result = await preparation.prepare({
    expectedUserId: "1",
    recipientUserId: "2",
    conversationId: "1:2",
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    rawKeys,
    revalidateImmediately: async () => ({ status: "blocked" }),
    initiateLivePost: () => assert.fail("POST must not run after blocked revalidation"),
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual([...rawKeys[0]], [0, 0, 0]);
  assert.deepEqual([...rawKeys[1]], [0, 0]);
  zeroizeLiveCreateKeys(rawKeys);
});

test("Live Create preparation claims concurrent attempts before revalidation", async () => {
  let releaseRevalidation = () => {};
  let revalidationCalls = 0;
  let mutationCalls = 0;
  const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
  const options = {
    expectedUserId: "1",
    recipientUserId: "2",
    conversationId: "1:2",
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    revalidateImmediately: () => {
      revalidationCalls += 1;
      return new Promise((resolve) => {
        releaseRevalidation = () =>
          resolve({
            status: "ready",
            oauthUserId: "1",
            recipientUserId: "2",
            conversationId: "1:2",
          });
      });
    },
    initiateLivePost: async () => {
      mutationCalls += 1;
      return { status: 201, conversationId: "1:2" };
    },
  };
  const firstKeys = [new Uint8Array([1])];
  const secondKeys = [new Uint8Array([2])];
  const firstPromise = preparation.prepare({ ...options, rawKeys: firstKeys });
  const second = await preparation.prepare({ ...options, rawKeys: secondKeys });
  assert.equal(second.status, "duplicate");
  assert.deepEqual([...secondKeys[0]], [0]);
  assert.equal(revalidationCalls, 1);
  assert.equal(mutationCalls, 0);

  releaseRevalidation();
  const first = await firstPromise;
  assert.equal(first.status, "submitted");
  assert.deepEqual([...firstKeys[0]], [1]);
  assert.equal(revalidationCalls, 1);
  assert.equal(mutationCalls, 1);
});

test("Live Create preparation binds ready revalidation to OAuth user, recipient, and conversation", async () => {
  for (const binding of [
    { oauthUserId: "9", recipientUserId: "2", conversationId: "1:2" },
    { oauthUserId: "1", recipientUserId: "3", conversationId: "1:2" },
    { oauthUserId: "1", recipientUserId: "2", conversationId: "1:3" },
  ]) {
    let mutationCalls = 0;
    const rawKeys = [new Uint8Array([1])];
    const result = await createLiveCreatePreparation({ liveCreateGateEnabled: true }).prepare({
      expectedUserId: "1",
      recipientUserId: "2",
      conversationId: "1:2",
      recipientConsentConfirmed: true,
      finalApprovalConfirmed: true,
      rawKeys,
      revalidateImmediately: async () => ({ status: "ready", ...binding }),
      initiateLivePost: () => {
        mutationCalls += 1;
        return { status: 201, conversationId: "1:2" };
      },
    });
    assert.equal(result.status, "blocked");
    assert.equal(mutationCalls, 0);
    assert.deepEqual([...rawKeys[0]], [0]);
  }
});

test("Live Create preparation zeroizes keys for invalid recipients and thrown revalidation", async () => {
  const invalidKeys = [new Uint8Array([1])];
  const invalidRecipient = await createLiveCreatePreparation({ liveCreateGateEnabled: true }).prepare({
    expectedUserId: "1",
    recipientUserId: "3",
    conversationId: "1:2",
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    rawKeys: invalidKeys,
  });
  assert.equal(invalidRecipient.status, "blocked");
  assert.deepEqual([...invalidKeys[0]], [0]);

  const thrownKeys = [new Uint8Array([2])];
  const thrown = await createLiveCreatePreparation({ liveCreateGateEnabled: true }).prepare({
    expectedUserId: "1",
    recipientUserId: "2",
    conversationId: "1:2",
    recipientConsentConfirmed: true,
    finalApprovalConfirmed: true,
    rawKeys: thrownKeys,
    revalidateImmediately: async () => {
      throw Object.assign(new Error("unknown"), { status: 503 });
    },
    initiateLivePost: () => assert.fail("POST must not run after revalidation failure"),
  });
  assert.equal(thrown.status, "reconcile");
  assert.equal(thrown.automaticRetry, false);
  assert.deepEqual([...thrownKeys[0]], [0]);
});

test("Live Create preparation zeroizes keys after unsuccessful and uncertain POST outcomes without retry", async () => {
  for (const response of [
    { status: 400 },
    undefined,
    { status: 408 },
    { status: 409 },
    { status: 429 },
    { status: 503 },
  ]) {
    let mutationCalls = 0;
    const rawKeys = [new Uint8Array([1])];
    const preparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
    const options = {
      expectedUserId: "1",
      recipientUserId: "2",
      conversationId: "1:2",
      recipientConsentConfirmed: true,
      finalApprovalConfirmed: true,
      rawKeys,
      revalidateImmediately: async () => ({
        status: "ready",
        oauthUserId: "1",
        recipientUserId: "2",
        conversationId: "1:2",
      }),
      initiateLivePost: async () => {
        mutationCalls += 1;
        return response;
      },
    };
    const result = await preparation.prepare(options);
    assert.equal(mutationCalls, 1);
    assert.equal(result.status, response?.status === 400 ? "failed" : "reconcile");
    assert.equal(result.automaticRetry, false);
    assert.deepEqual([...rawKeys[0]], [0]);

    const retryKeys = [new Uint8Array([2])];
    const retry = await preparation.prepare({ ...options, rawKeys: retryKeys });
    assert.equal(retry.status, "duplicate");
    assert.equal(mutationCalls, 1);
    assert.deepEqual([...retryKeys[0]], [0]);
  }
});

test("Live readiness preview is ready only when every read-only gate passes", async () => {
  const harness = previewHarness();
  const preview = await harness.run();
  assert.equal(preview.status, "ready");
  assert.equal(
    preview.checks.every((check) => check.passed),
    true,
  );
  assert.deepEqual(harness.calls, ["oauth", "lookup", "own-keys", "recipient-keys"]);
  assert.equal(
    harness.calls.some((call) => call === "post" || call === "initialize" || call === "send"),
    false,
  );
});

test("Live readiness preview requires explicit consent and blocks pending work or a blocked retry", async () => {
  for (const localState of [
    { consentChecked: false },
    { consentChecked: true, pendingSend: true },
    { consentChecked: true, draft: true },
    { consentChecked: true, retryBlocked: true },
  ]) {
    const preview = await previewHarness({ getLocalState: () => localState }).run();
    assert.equal(preview.status, "blocked");
    assert.equal(previewCheck(preview, "consent").passed, localState.consentChecked === true);
    assert.equal(previewCheck(preview, "localState").passed, Object.keys(localState).length === 1);
  }
});

test("Live readiness preview stops on a wrong OAuth identity", async () => {
  const harness = previewHarness({
    getOAuthIdentity: async () => {
      harness.calls.push("oauth");
      return { id: "9" };
    },
  });
  const preview = await harness.run();
  assert.equal(preview.status, "blocked");
  assert.match(previewCheck(preview, "oauth").reason, /ไม่ตรง/);
  assert.deepEqual(harness.calls, ["oauth"]);
});

test("Live readiness preview rejects a recipient username or user ID mismatch", async () => {
  for (const user of [
    { id: "3", username: "peer", receives_your_chat: "encrypted" },
    { id: "2", username: "different", receives_your_chat: "encrypted" },
  ]) {
    const harness = previewHarness({ lookupRecipient: async () => ({ ...previewLookup, user }) });
    const preview = await harness.run();
    assert.equal(preview.status, "blocked");
    assert.equal(previewCheck(preview, "recipient").passed, false);
    assert.equal(harness.calls.includes("own-keys"), false);
  }
});

test("Live readiness preview accepts only encrypted permission", async () => {
  for (const permission of ["none", "unknown", "unencrypted"]) {
    const harness = previewHarness({
      lookupRecipient: async () => ({
        ...previewLookup,
        user: { ...previewLookup.user, receives_your_chat: permission === "unknown" ? null : permission },
      }),
    });
    const preview = await harness.run();
    assert.equal(preview.status, "blocked");
    assert.equal(previewCheck(preview, "permission").passed, false);
  }
});

test("Live readiness preview blocks missing or invalid public key bindings", async () => {
  const missing = await previewHarness({ getOwnKeys: async () => ({ encryption: [], signing: [] }) }).run();
  assert.equal(missing.status, "blocked");
  assert.equal(previewCheck(missing, "keys").passed, false);

  const invalidOwn = await previewHarness({ verifyOwnKeyBinding: () => false }).run();
  assert.equal(invalidOwn.status, "blocked");
  assert.equal(previewCheck(invalidOwn, "keys").passed, false);

  const invalidRecipient = await previewHarness({
    getRecipientKeys: async () => {
      throw new Error("invalid binding");
    },
  }).run();
  assert.equal(invalidRecipient.status, "blocked");
  assert.equal(previewCheck(invalidRecipient, "keys").passed, false);
});

test("Live readiness preview blocks existing, ambiguous, incomplete, and failed room lookups", async () => {
  const room = mapConversationResponse({ data: [{ id: "1:2", type: "direct", participant_ids: ["1", "2"] }] }, "1")[0];
  for (const data of [
    { ...previewLookup, conversations: { data: [room], includes: { users: [] } } },
    {
      ...previewLookup,
      conversations: {
        data: [
          room,
          ...mapConversationResponse({ data: [{ id: "2:1", type: "direct", participant_ids: ["1", "2"] }] }, "1"),
        ],
        includes: { users: [] },
      },
    },
    { ...previewLookup, conversation_lookup: "incomplete" },
    { ...previewLookup, conversation_lookup: "error" },
    { ...previewLookup, conversations: { data: "malformed" } },
    {
      ...previewLookup,
      conversations: {
        data: [{ id: "1:2", type: "direct", participant_ids: ["not-an-id"] }],
        includes: { users: [] },
      },
    },
  ]) {
    const preview = await previewHarness({ lookupRecipient: async () => data }).run();
    assert.equal(preview.status, "blocked");
    assert.equal(previewCheck(preview, "existing").passed, false);
    if (data.conversation_lookup !== "available") assert.equal(previewCheck(preview, "lookup").passed, false);
  }
});

test("Live readiness preview detects one-participant existing rooms in colon and hyphen forms", async () => {
  for (const roomId of ["1:2", "2-1"]) {
    const room = { id: roomId, type: "direct", participant_ids: ["2"] };
    for (const conversationLookup of ["available", "existing"]) {
      const preview = await previewHarness({
        lookupRecipient: async () => ({
          ...previewLookup,
          conversations: { data: [room], includes: { users: [] } },
          conversation_lookup: conversationLookup,
        }),
      }).run();
      assert.equal(preview.status, "blocked");
      assert.equal(previewCheck(preview, "lookup").passed, true);
      assert.equal(previewCheck(preview, "existing").passed, false);
      assert.match(previewCheck(preview, "existing").reason, /พบห้อง 1:1 เดิม/);
    }
  }
});

test("Live readiness preview handles HTTP errors without retrying or continuing network reads", async () => {
  for (const status of [429, 503]) {
    const harness = previewHarness({
      lookupRecipient: async () => {
        harness.calls.push("lookup");
        throw Object.assign(new Error("upstream failure"), { status });
      },
    });
    const preview = await harness.run();
    assert.equal(preview.status, "blocked");
    assert.equal(previewCheck(preview, "lookup").passed, false);
    assert.match(previewCheck(preview, "lookup").reason, new RegExp(`HTTP ${status}`));
    if (status === 429) assert.match(previewCheck(preview, "lookup").reason, /ไม่มีการลองซ้ำ/);
    assert.deepEqual(harness.calls, ["oauth", "lookup"]);
  }
});

test("username lookup normalizes a single optional @ and validates X handle rules", () => {
  assert.equal(normalizeUsername("  @Alice_1 "), "alice_1");
  assert.throws(() => normalizeUsername("@@alice"), /Username/);
  assert.throws(() => normalizeUsername("alice.name"), /Username/);
  assert.throws(() => normalizeUsername("a".repeat(16)), /Username/);
  assert.throws(() => normalizeUsername(null), /Username/);
});

test("multi-contact input splits, normalizes, deduplicates, and caps unique usernames at ten", () => {
  assert.deepEqual(parseContactUsernames(" @Alice, BOB\n alice   Carol_1 "), ["alice", "bob", "carol_1"]);
  assert.deepEqual(parseContactUsernames("SingleUser"), ["singleuser"]);
  assert.throws(() => parseContactUsernames("valid invalid.name"), /Username/);
  assert.throws(() => parseContactUsernames(""), /Username/);
  assert.throws(() => parseContactUsernames(Array.from({ length: 11 }, (_, index) => `user${index}`).join("\n")), /10/);
});

test("multi-contact lookups run at most two at once and isolate per-user errors", async () => {
  let active = 0;
  let peak = 0;
  const results = await lookupContactsWithLimit(["one", "two", "three", "four"], async (username) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    if (username === "two") throw Object.assign(new Error("not found"), { status: 404 });
    return { user: { username } };
  });
  assert.equal(peak, 2);
  assert.deepEqual(
    results.map((result) => result.username),
    ["one", "two", "three", "four"],
  );
  assert.equal(results[1].error.status, 404);
  assert.equal(results[2].contact.user.username, "three");
});

test("multi-contact lookup stops scheduling after HTTP 429 and never retries", async () => {
  const calls = [];
  const results = await lookupContactsWithLimit(["one", "two", "three", "four"], async (username) => {
    calls.push(username);
    if (username === "one") {
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw Object.assign(new Error("rate limited"), { status: 429 });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls), new Set(["one", "two"]));
  assert.deepEqual(
    results.slice(2).map((result) => result.error.status),
    [429, 429],
  );
  assert.equal(results[0].error.status, 429);
});

test("permission preflight distinguishes encrypted, unencrypted, none, and unknown", () => {
  assert.equal(permissionForEncryptedChat("unencrypted"), "unencrypted");
  assert.equal(permissionForEncryptedChat("none"), "none");
  assert.equal(permissionForEncryptedChat(undefined), "unknown");
});

test("direct-chat confirmation fails closed unless every identity, permission, key, and lookup gate passes", () => {
  const contact = {
    identityVerified: true,
    conversationLookup: "available",
    existing: { status: "not_found" },
    permission: "encrypted",
    keyStatus: "verified",
  };
  assert.equal(canConfirmDirectChat(contact, "mock", true, true), true);
  assert.equal(canConfirmDirectChat(contact, "mock", true, false), false);
  for (const change of [
    { identityVerified: false },
    { conversationLookup: "incomplete" },
    { existing: { status: "found" } },
    { permission: "none" },
    { permission: "unknown" },
    { permission: "unencrypted" },
    { keyStatus: "locked" },
    { keyStatus: "pending" },
    { keyStatus: "error" },
    { retryBlocked: true },
  ]) {
    assert.equal(canConfirmDirectChat({ ...contact, ...change }, "mock", true), false);
  }
  assert.equal(canConfirmDirectChat(contact, "live", true, true), false);
  assert.equal(canConfirmDirectChat(contact, "mock", false), false);
  assert.equal(canConfirmDirectChat(contact, "mock", true), false);
});

test("direct-chat creation fails closed when OAuth identity changes", () => {
  assert.equal(isCurrentOAuthIdentity("1", "1", "1"), true);
  assert.equal(isCurrentOAuthIdentity("1", "2", "1"), false);
  assert.equal(isCurrentOAuthIdentity("1", "1", "2"), false);
  assert.equal(isCurrentOAuthIdentity("1", "invalid", "1"), false);
});

test("fresh direct-chat lookup must match the exact recipient ID and normalized username", () => {
  const expected = { id: "2", username: "Peer_1" };
  assert.equal(matchesDirectChatRecipient(expected, { id: "2", username: "peer_1" }), true);
  assert.equal(matchesDirectChatRecipient(expected, { id: "3", username: "peer_1" }), false);
  assert.equal(matchesDirectChatRecipient(expected, { id: "2", username: "other_peer" }), false);
  assert.equal(matchesDirectChatRecipient(expected, { id: "2", username: "bad.handle" }), false);
});

test("direct-chat retry requires explicit lookup after uncertain outcomes and never auto-retries 429", () => {
  for (const status of [0, 408, 409, 429, 500, 503]) assert.equal(requiresExplicitDirectLookup(status), true);
  for (const status of [200, 400, 401, 403, 404]) assert.equal(requiresExplicitDirectLookup(status), false);
  const oldLookup = {
    identityVerified: true,
    conversationLookup: "available",
    existing: { status: "not_found" },
    permission: "encrypted",
    keyStatus: "verified",
    retryBlocked: true,
  };
  assert.equal(canConfirmDirectChat(oldLookup, "mock", true, true), false);
  const freshLookup = { ...oldLookup, retryBlocked: false };
  assert.equal(canConfirmDirectChat(freshLookup, "mock", true, true), true);
});

test("direct-chat attempt claim blocks a second click while the first attempt is pending", () => {
  const state = { startingDirectChat: false };
  assert.equal(claimDirectChatAttempt(state), true);
  assert.equal(claimDirectChatAttempt(state), false);
  assert.equal(state.startingDirectChat, true);
});

test("failed direct-chat preparation zeroizes its raw conversation key", () => {
  const key = new Uint8Array(32).fill(17);
  assert.throws(() => {
    try {
      throw new Error("mock timeout");
    } catch (error) {
      zeroizePreparedDirectChat({ conversationKey: key });
      throw error;
    }
  }, /mock timeout/);
  assert.deepEqual(key, new Uint8Array(32));
});

test("existing-room preflight opens only a single verified direct room for the exact recipient", () => {
  const conversations = mapConversationResponse(
    {
      data: [
        { id: "1:2", type: "direct", participant_ids: ["1", "2"] },
        { id: "1:3", type: "direct", participant_ids: ["1", "3"] },
        { id: "group-1", type: "group", participant_ids: ["1", "2"] },
        { id: "unverified", type: "direct", participant_ids: ["2"] },
        { id: "1:2", type: "direct", participant_ids: ["2"] },
        { id: "1:9", type: "direct", participant_ids: ["1", "2"] },
      ],
    },
    "1",
  );
  assert.equal(findExistingDirectConversation(conversations, "1", "2").status, "found");
  assert.equal(
    findExistingDirectConversation([{ id: "1:2", type: "direct", participant_ids: ["2"] }], "1", "2").status,
    "found",
  );
  assert.equal(
    findExistingDirectConversation([{ id: "2-1", type: "direct", participant_ids: ["2"] }], "1", "2").status,
    "found",
  );
  assert.equal(
    findExistingDirectConversation([{ id: "1:9", type: "direct", participant_ids: ["1", "2"] }], "1", "2").status,
    "not_found",
  );
  assert.equal(findExistingDirectConversation(conversations, "1", "3").status, "found");
  assert.equal(findExistingDirectConversation(conversations, "1", "4").status, "not_found");

  const ambiguous = mapConversationResponse(
    {
      data: [
        { id: "1:2", type: "direct", participant_ids: ["1", "2"] },
        { id: "2:1", type: "direct", participant_ids: ["1", "2"] },
      ],
    },
    "1",
  );
  assert.equal(findExistingDirectConversation(ambiguous, "1", "2").status, "ambiguous");
});

test("lookup epochs mark superseded searches stale", () => {
  const epoch = createLookupEpoch();
  const oldRequest = epoch.begin();
  const currentRequest = epoch.begin();
  assert.equal(epoch.isCurrent(oldRequest), false);
  assert.equal(epoch.isCurrent(currentRequest), true);
  epoch.invalidate();
  assert.equal(epoch.isCurrent(currentRequest), false);
});

test("existing-room resolution requires a complete unique API result or a verified inbox match", () => {
  const candidate = { id: "1:2", type: "direct", participant_ids: ["1", "2"] };
  assert.equal(resolveExistingDirectConversation([candidate], [], "1", "2", "existing").status, "found");
  assert.equal(resolveExistingDirectConversation([candidate], [], "1", "2", "incomplete").status, "not_found");
  assert.equal(resolveExistingDirectConversation([], [candidate], "1", "2", "error").status, "found");
  assert.equal(
    resolveExistingDirectConversation(
      [candidate, { id: "2:1", type: "direct", participant_ids: ["1", "2"] }],
      [],
      "1",
      "2",
      "existing",
    ).status,
    "ambiguous",
  );
});

test("local key plan exposes only metadata and zeroizes the raw conversation key", () => {
  let rawKey;
  const chat = {
    prepareConversationKeyChange() {
      rawKey = new Uint8Array(32).fill(7);
      return {
        conversationId: "1:2",
        conversationKey: rawKey,
        conversationKeyVersion: "123",
        conversationParticipantKeys: [{}, {}],
        actionSignatures: [{}],
      };
    },
  };
  const plan = prepareConversationKeyPlan(chat, [{}, {}]);
  assert.deepEqual(rawKey, new Uint8Array(32));
  assert.deepEqual(plan, {
    conversationId: "1:2",
    conversationKeyVersion: "123",
    participantCount: 2,
    signatureCount: 1,
  });
  assert.equal("conversationKey" in plan, false);
});

test("direct conversation request uses SDK fields and verifies canonical participants", () => {
  const rawKey = new Uint8Array(32).fill(9);
  const prepared = {
    conversationId: "1:2",
    conversationKey: rawKey,
    conversationKeyVersion: "123",
    conversationParticipantKeys: [
      { userId: "1", encryptedConversationKey: "encrypted-self", publicKeyVersion: "11" },
      { userId: "2", encryptedConversationKey: "encrypted-peer", publicKeyVersion: "22" },
    ],
    actionSignatures: [
      {
        messageId: "message-id",
        encodedMessageEventDetail: "encoded-action",
        messageEventSignature: {
          signature: "signed-action",
          signatureVersion: "1",
          publicKeyVersion: "11",
          signingPublicKey: "signing-key",
        },
      },
    ],
  };
  let receivedParams;
  const plan = prepareDirectConversationChange(
    {
      prepareConversationKeyChange(params) {
        receivedParams = params;
        return prepared;
      },
    },
    [
      { userId: "1", identityPublicKey: "self", publicKeyVersion: "11" },
      { userId: "2", identityPublicKey: "peer", publicKeyVersion: "22" },
    ],
    "1",
    "2",
  );

  assert.deepEqual(Object.keys(receivedParams), ["publicKeys"]);
  assert.equal(isCanonicalDirectConversationId("1:2", "1", "2"), true);
  assert.equal(isCanonicalDirectConversationId("2:1", "1", "2"), false);
  assert.equal(isCanonicalDirectConversationId("1:3", "1", "2"), false);
  assert.equal(plan.conversationId, "1:2");
  assert.equal(plan.conversationKey, rawKey);
  assert.deepEqual(plan.requestBody, {
    conversation_key_version: "123",
    conversation_participant_keys: [
      { user_id: "1", encrypted_conversation_key: "encrypted-self", public_key_version: "11" },
      { user_id: "2", encrypted_conversation_key: "encrypted-peer", public_key_version: "22" },
    ],
    action_signatures: [
      {
        message_id: "message-id",
        encoded_message_event_detail: "encoded-action",
        message_event_signature: {
          signature: "signed-action",
          signature_version: "1",
          public_key_version: "11",
          signing_public_key: "signing-key",
        },
      },
    ],
  });
  assert.equal(
    rawKey.some((byte) => byte !== 0),
    true,
  );
  rawKey.fill(0);
});

test("canonical conversation IDs use numeric sorting for either owner order", () => {
  assert.equal(
    canonicalDirectConversationId("1000000000000000000", "999999999999999999"),
    "999999999999999999:1000000000000000000",
  );
  assert.equal(canonicalDirectConversationId("1001", "2002"), "1001:2002");
  assert.equal(canonicalDirectConversationId("2002", "1001"), "1001:2002");
  assert.equal(
    isCanonicalDirectConversationId(
      "1000000000000000000:999999999999999999",
      "1000000000000000000",
      "999999999999999999",
    ),
    false,
  );
});

test("direct conversation request zeroizes an SDK key when its canonical ID is wrong", () => {
  const rawKey = new Uint8Array(32).fill(9);
  assert.throws(
    () =>
      prepareDirectConversationChange(
        {
          prepareConversationKeyChange() {
            return {
              conversationId: "1:3",
              conversationKey: rawKey,
              conversationKeyVersion: "123",
              conversationParticipantKeys: [],
              actionSignatures: [],
            };
          },
        },
        [
          { userId: "1", identityPublicKey: "self", publicKeyVersion: "11" },
          { userId: "2", identityPublicKey: "peer", publicKeyVersion: "22" },
        ],
        "1",
        "2",
      ),
    /canonical conversation ID/,
  );
  assert.deepEqual(rawKey, new Uint8Array(32));
});

test("direct initialization accepts only a valid canonical acknowledgement envelope", () => {
  const response = {
    data: { conversation_id: "1:2", sequence_id: "1" },
  };
  assert.equal(validateDirectConversationInitialization(response, "1:2", "1", "2"), response.data);
  assert.throws(
    () => validateDirectConversationInitialization({ data: { conversation_id: "2:1" } }, "2:1", "1", "2"),
    /canonical conversation ID/,
  );
  assert.throws(
    () =>
      validateDirectConversationInitialization({ data: { conversation_id: "1:2", sequence_id: 1 } }, "1:2", "1", "2"),
    /canonical conversation ID/,
  );
  assert.throws(
    () => validateDirectConversationInitialization({ data: { conversation_id: "1:2" }, errors: [{}] }, "1:2", "1", "2"),
    /ข้อผิดพลาด/,
  );
  assert.throws(
    () => validateDirectConversationInitialization({ data: "2:1" }, "2:1", "1", "2"),
    /canonical conversation ID/,
  );
});
