import assert from "node:assert/strict";
import test from "node:test";
import { createChat } from "@xdevplatform/chat-xdk";
import { realmTokensFromConfig, unlockExistingIdentity } from "../public/pin-unlock.mjs";

const matchingRecord = {
  public_key_version: "41",
  public_key: "identity-key",
  signing_public_key: "signing-key",
  identity_public_key_signature: "binding-signature",
};

function chatStub(overrides = {}) {
  const calls = { unlock: 0, lock: 0, identity: null, cache: false };
  const chat = {
    async unlock() {
      calls.unlock += 1;
    },
    isUnlocked: () => true,
    getPublicKeys: () => ({ identity: "identity-key", signing: "signing-key" }),
    sign: () => new Uint8Array(64),
    verify: (key, signature, challenge) => key === "signing-key" && signature.length === 64 && challenge.length === 32,
    matchesRegisteredKey: (key) => key === "identity-key",
    verifyKeyBinding: (_identity, _signing, signature) => signature === "binding-signature",
    setIdentity: (identity) => {
      calls.identity = identity;
    },
    setCacheKeys: (enabled) => {
      calls.cache = enabled;
    },
    lock: () => {
      calls.lock += 1;
    },
    ...overrides,
  };
  return { chat, calls };
}

function pin() {
  return new TextEncoder().encode("2580");
}

async function createOfflineSdkChat() {
  const originalFetch = globalThis.fetch;
  const originalGetBuiltinModule = process.getBuiltinModule;
  process.getBuiltinModule = undefined;
  globalThis.fetch = async () => {
    throw new Error("Network disabled in SDK regression test");
  };
  try {
    return await createChat();
  } finally {
    globalThis.fetch = originalFetch;
    process.getBuiltinModule = originalGetBuiltinModule;
  }
}

function sdkChatHarness(sdkChat) {
  return {
    async unlock() {},
    isUnlocked: () => sdkChat.isUnlocked(),
    getPublicKeys: () => sdkChat.getPublicKeys(),
    sign: (data) => sdkChat.sign(data),
    verify: (publicKey, signature, data) => sdkChat.verify(publicKey, signature, data),
    matchesRegisteredKey: (publicKey) => sdkChat.matchesRegisteredKey(publicKey),
    verifyKeyBinding: (identity, signing, signature) => sdkChat.verifyKeyBinding(identity, signing, signature),
    setIdentity() {},
    setCacheKeys() {},
    lock() {},
  };
}

function diagnosticsFrom(error) {
  const json = error.message.match(/\(redacted diagnostics: (.*)\)$/)?.[1];
  assert.ok(json);
  return JSON.parse(json);
}

test("maps realm auth tokens in memory without persisting or logging them", () => {
  const tokens = realmTokensFromConfig(
    JSON.stringify({ token_map: [{ key: "REALM-A", value: { token: "token-a" } }] }),
  );
  assert.equal(tokens.get("realm-a"), "token-a");
  assert.throws(() => realmTokensFromConfig("not-json"), /configuration is invalid/);
  assert.throws(() => realmTokensFromConfig(JSON.stringify({ token_map: {} })), /token map is missing/);
});

test("unlocks exactly once and sets identity only from the unique matching key record", async () => {
  const { chat, calls } = chatStub();
  const pinBytes = pin();
  const version = await unlockExistingIdentity({
    chat,
    pinBytes,
    account: { id: "12345" },
    records: [
      { ...matchingRecord },
      { ...matchingRecord, public_key_version: "42", signing_public_key: "other-signing" },
    ],
  });
  assert.equal(version, "41");
  assert.equal(calls.unlock, 1);
  assert.equal(calls.lock, 0);
  assert.deepEqual(calls.identity, { userId: "12345", signingKeyVersion: "41" });
  assert.equal(calls.cache, true);
  assert.deepEqual([...pinBytes], [0, 0, 0, 0]);
});

test("locks and zeroizes after PIN failure without retrying", async () => {
  const { chat, calls } = chatStub({
    async unlock() {
      calls.unlock += 1;
      throw new Error("invalid PIN");
    },
  });
  const pinBytes = pin();
  await assert.rejects(
    unlockExistingIdentity({ chat, pinBytes, account: { id: "12345" }, records: [matchingRecord] }),
    /invalid PIN/,
  );
  assert.equal(calls.unlock, 1);
  assert.equal(calls.lock, 1);
  assert.equal(calls.identity, null);
  assert.deepEqual([...pinBytes], [0, 0, 0, 0]);
});

test("rejects zero or multiple matching records without choosing a key version", async () => {
  for (const records of [
    [{ ...matchingRecord, signing_public_key: "different" }],
    [matchingRecord, { ...matchingRecord, public_key_version: "42" }],
  ]) {
    const { chat, calls } = chatStub();
    const pinBytes = pin();
    await assert.rejects(
      unlockExistingIdentity({ chat, pinBytes, account: { id: "12345" }, records }),
      /exactly one verified public-key record/,
    );
    assert.equal(calls.identity, null);
    assert.equal(calls.lock, 1);
    assert.deepEqual([...pinBytes], [0, 0, 0, 0]);
  }
});

test("reports redacted per-record checks, duplicate records, versions, and Base64 shapes", async () => {
  const checked = { registered: 0, binding: 0 };
  const { chat, calls } = chatStub({
    getPublicKeys: () => ({ identity: "AA==", signing: "AQID" }),
    verify: (signing) => signing === "AQID",
    matchesRegisteredKey: (identity) => {
      checked.registered += 1;
      return identity === "AA==";
    },
    verifyKeyBinding: (_identity, _signing, signature) => {
      checked.binding += 1;
      return signature === "BAUG";
    },
  });
  const first = {
    public_key_version: "41",
    public_key: "AA==",
    signing_public_key: "AQID",
    identity_public_key_signature: "BAUG",
  };
  const records = [
    first,
    { ...first, public_key_version: "42" },
    { ...first, public_key_version: "42" },
    { ...first, public_key_version: "43", signing_public_key: "AQIE" },
  ];
  const pinBytes = pin();
  const failure = await unlockExistingIdentity({
    chat,
    pinBytes,
    account: { id: "12345" },
    records,
  }).then(
    () => null,
    (error) => error,
  );

  assert.ok(failure instanceof Error);
  const json = failure.message.match(/\(redacted diagnostics: (.*)\)$/)?.[1];
  assert.ok(json);
  const diagnostics = JSON.parse(json);
  assert.equal(diagnostics.recordCount, 4);
  assert.equal(diagnostics.duplicateRecordCount, 1);
  assert.equal(diagnostics.distinctVersionCount, 3);
  assert.equal(diagnostics.duplicateVersionCount, 1);
  assert.equal(diagnostics.recoveredSigning.type, "string");
  assert.equal(diagnostics.recoveredSigning.standardBase64Shape, true);
  assert.equal(diagnostics.records[0].signingVersionDecimal, true);
  assert.equal(diagnostics.records[0].publicKeyFormats.identityStandardBase64Shape, true);
  assert.equal(diagnostics.records[0].publicKeyFormats.signingStandardBase64Shape, true);
  assert.equal(diagnostics.records[0].publicKeyFormats.signatureStandardBase64Shape, true);
  assert.equal(diagnostics.records[0].signingMatchesRecovered, true);
  assert.equal(diagnostics.records[0].matchesRegisteredKey, true);
  assert.equal(diagnostics.records[0].verifyKeyBinding, true);
  assert.equal(diagnostics.records[3].signingMatchesRecovered, false);
  assert.equal(diagnostics.records[3].matchesRegisteredKey, true);
  assert.equal(diagnostics.records[3].verifyKeyBinding, true);
  assert.equal(checked.registered, records.length);
  assert.equal(checked.binding, records.length);
  assert.equal(calls.lock, 1);
  assert.deepEqual([...pinBytes], [0, 0, 0, 0]);
  for (const keyMaterial of ["AA==", "AQID", "AQIE", "BAUG"]) {
    assert.equal(failure.message.includes(keyMaterial), false);
  }
});

test("SDK 0.7.1 proves recovered SEC1 and registered SPKI signing keys equivalent offline", async () => {
  const sdkChat = await createOfflineSdkChat();
  const otherChat = await createOfflineSdkChat();
  try {
    const registration = sdkChat.generateKeypairs().publicKey;
    const recovered = sdkChat.getPublicKeys();
    const recoveredSigningBytes = Buffer.from(recovered.signing, "base64");
    const signingRecord = {
      public_key_version: "71",
      public_key: registration.publicKey,
      signing_public_key: registration.signingPublicKey,
      identity_public_key_signature: registration.identityPublicKeySignature,
    };
    const registeredSigningBytes = Buffer.from(signingRecord.signing_public_key, "base64");
    const harness = sdkChatHarness(sdkChat);
    const acceptedVersion = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [signingRecord],
    });

    assert.equal(recovered.signing !== signingRecord.signing_public_key, true);
    assert.equal(recoveredSigningBytes.length, 65);
    assert.equal(recoveredSigningBytes[0], 0x04);
    assert.equal(registeredSigningBytes.length, 91);
    assert.equal(registeredSigningBytes[0], 0x30);
    assert.equal(acceptedVersion, "71");

    const otherRegistration = otherChat.generateKeypairs().publicKey;
    const wrongIdentityFailure = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [{ ...signingRecord, public_key: otherRegistration.publicKey }],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(wrongIdentityFailure instanceof Error);
    assert.equal(diagnosticsFrom(wrongIdentityFailure).records[0].matchesRegisteredKey, false);

    const otherSigning = otherRegistration.signingPublicKey;
    const differentKeyFailure = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [{ ...signingRecord, signing_public_key: otherSigning }],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(differentKeyFailure instanceof Error);
    assert.equal(diagnosticsFrom(differentKeyFailure).records[0].signingMatchesRecovered, false);

    const tamperedSignature = Buffer.from(signingRecord.identity_public_key_signature, "base64");
    tamperedSignature[0] ^= 0x80;
    const invalidSignatureFailure = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [
        {
          ...signingRecord,
          identity_public_key_signature: tamperedSignature.toString("base64"),
        },
      ],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(invalidSignatureFailure instanceof Error);
    assert.equal(diagnosticsFrom(invalidSignatureFailure).records[0].verifyKeyBinding, false);

    const duplicateFailure = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [signingRecord, { ...signingRecord, public_key_version: "72" }],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(duplicateFailure instanceof Error);
    assert.equal(
      diagnosticsFrom(duplicateFailure).records.filter((record) => record.signingMatchesRecovered).length,
      2,
    );

    const invalidEncodingFailure = await unlockExistingIdentity({
      chat: harness,
      pinBytes: pin(),
      account: { id: "12345" },
      records: [{ ...signingRecord, signing_public_key: "not base64!!" }],
    }).then(
      () => null,
      (error) => error,
    );
    assert.ok(invalidEncodingFailure instanceof Error);
    assert.equal(diagnosticsFrom(invalidEncodingFailure).records[0].signingMatchesRecovered, false);
  } finally {
    sdkChat.lock();
    otherChat.lock();
  }
});

test("rejects malformed PIN bytes before calling unlock", async () => {
  const { chat, calls } = chatStub();
  const pinBytes = new TextEncoder().encode("12345");
  await assert.rejects(
    unlockExistingIdentity({ chat, pinBytes, account: { id: "12345" }, records: [matchingRecord] }),
    /exactly four digits/,
  );
  assert.equal(calls.unlock, 0);
  assert.equal(calls.lock, 1);
  assert.deepEqual([...pinBytes], [0, 0, 0, 0, 0]);
});
