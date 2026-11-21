import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  cacheDocument,
  createCacheStore,
  decryptCacheDocument,
  encryptCacheDocument,
  validateCacheEnvelope,
} from "../public/cache-vault.mjs";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

test("encrypted cache round-trips ciphertext metadata but rejects sensitive fields and wrong passphrases", async () => {
  const document = cacheDocument({
    conversations: [{ id: "g-mock-1", unread: 2 }],
    events: { "g-mock-1": ["signed-ciphertext-event"] },
    deliveryIds: ["delivery-1", "delivery-1"],
  });
  const envelope = await encryptCacheDocument(document, "correct horse battery staple");
  assert.equal("signed-ciphertext-event" in envelope, false);
  assert.deepEqual(await decryptCacheDocument(envelope, "correct horse battery staple"), document);
  await assert.rejects(() => decryptCacheDocument(envelope, "different passphrase"), /Unable to unlock/);
  await assert.rejects(
    () => encryptCacheDocument({ private_key: "never" }, "correct horse battery staple"),
    /Refusing to persist sensitive field/,
  );
});

test("tampered or malformed cache envelopes fail closed instead of yielding a document", async () => {
  const passphrase = "correct horse battery staple";
  const envelope = await encryptCacheDocument(cacheDocument({ conversations: [{ id: "g-mock-1" }] }), passphrase);

  const bytes = Buffer.from(envelope.ciphertext, "base64");
  bytes[0] ^= 0xff;
  const tampered = { ...envelope, ciphertext: bytes.toString("base64") };
  await assert.rejects(() => decryptCacheDocument(tampered, passphrase), /Unable to unlock/);

  await assert.rejects(() => decryptCacheDocument({ ...envelope, version: 2 }, passphrase), /Unsupported/);
  await assert.rejects(() => decryptCacheDocument({ ...envelope, salt: "" }, passphrase), /Invalid encrypted cache/);
  await assert.rejects(() => decryptCacheDocument({ ...envelope, ciphertext: "%%%" }, passphrase), /Unable to unlock/);
});

test("imported envelopes are validated before touching the existing cache", () => {
  const envelope = { version: 1, salt: "c2FsdA==", iv: "aXY=", ciphertext: "Y3Q=" };
  assert.equal(validateCacheEnvelope(envelope), envelope);
  for (const bad of [null, {}, [], { ...envelope, version: 2 }, { ...envelope, salt: "" }]) {
    assert.throws(() => validateCacheEnvelope(bad), /Invalid encrypted cache|Unsupported/);
  }
});

function installFakeIndexedDb() {
  const data = new Map();
  const request = (result) => {
    const req = {};
    queueMicrotask(() => {
      req.result = result;
      req.onsuccess?.();
    });
    return req;
  };
  const objectStore = {
    get: (key) => request(data.get(key)),
    put: (value, key) => {
      data.set(key, value);
      return request(undefined);
    },
    clear: () => {
      data.clear();
      return request(undefined);
    },
  };
  const database = { createObjectStore() {}, transaction: () => ({ objectStore: () => objectStore }) };
  return {
    indexedDB: {
      open: () => {
        const req = {};
        queueMicrotask(() => {
          req.result = database;
          req.onupgradeneeded?.();
          req.onsuccess?.();
        });
        return req;
      },
    },
  };
}

test("cache store export/import/delete keeps the latest document and clears only on request", async () => {
  const fake = installFakeIndexedDb();
  Reflect.set(globalThis, "indexedDB", fake.indexedDB);
  const passphrase = "correct horse battery staple";
  try {
    const store = createCacheStore("cache-store-test");
    const first = cacheDocument({
      conversations: [{ id: "direct-1", unread: 1 }],
      events: { "direct-1": ["signed-ciphertext"] },
      deliveryIds: ["delivery-1", "delivery-1"],
      audits: [{ action: "send" }],
    });
    const exported = await encryptCacheDocument(first, passphrase);
    await store.save(exported);
    assert.deepEqual(validateCacheEnvelope(await store.load()), exported);
    assert.deepEqual(await decryptCacheDocument(await store.load(), passphrase), first);

    const imported = cacheDocument({ conversations: [{ id: "group-2" }], events: { "group-2": ["other"] } });
    await store.save(await encryptCacheDocument(imported, passphrase));
    assert.deepEqual(await decryptCacheDocument(await store.load(), passphrase), imported);

    await store.clear();
    assert.equal(await store.load(), undefined);
  } finally {
    Reflect.deleteProperty(globalThis, "indexedDB");
  }
});
