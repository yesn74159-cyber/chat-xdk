import assert from "node:assert/strict";
import test from "node:test";
import { signingKeyRecords } from "../public/signing-key-records.mjs";

test("snake_case and camelCase public-key records normalise identically", () => {
  const snake = signingKeyRecords("42", {
    data: [
      {
        public_key_version: "3",
        signing_public_key: "spki",
        public_key: "identity",
        identity_public_key_signature: "sig",
      },
    ],
  });
  const camel = signingKeyRecords("42", {
    data: [
      {
        publicKeyVersion: "3",
        signingPublicKey: "spki",
        publicKey: "identity",
        identityPublicKeySignature: "sig",
      },
    ],
  });
  assert.deepEqual(snake, camel);
  assert.deepEqual(snake[0], {
    userId: "42",
    publicKeyVersion: "3",
    publicKey: "spki",
    identityPublicKey: "identity",
    identityPublicKeySignature: "sig",
  });
});

test("an empty or missing record list stays empty so the caller can show a missing-key notice", () => {
  assert.deepEqual(signingKeyRecords("42", { data: [] }), []);
  assert.deepEqual(signingKeyRecords("42", {}), []);
  assert.deepEqual(signingKeyRecords("42", undefined), []);
  assert.deepEqual(signingKeyRecords("42", { data: [null, "bad", []] }), []);
});

test("a single record object is treated as a one-record list", () => {
  const records = signingKeyRecords("42", {
    data: { public_key_version: "1", signing_public_key: "s", public_key: "i", identity_public_key_signature: "x" },
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].publicKeyVersion, "1");
});
