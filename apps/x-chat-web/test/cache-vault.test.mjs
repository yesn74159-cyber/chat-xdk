import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { cacheDocument, decryptCacheDocument, encryptCacheDocument } from "../public/cache-vault.mjs";

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
