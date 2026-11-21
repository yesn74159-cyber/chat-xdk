import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectEventMetadata } from "../public/event-metadata.mjs";

const fixtures = new URL("../../../tests/fixtures/", import.meta.url);
const vectors = JSON.parse(await readFile(new URL("sdk_vectors.json", fixtures), "utf8"));
const legacy = JSON.parse(await readFile(new URL("compat_v0_5_0.json", fixtures), "utf8"));
const signingKeys = [
  {
    userId: vectors.event_sender_id,
    publicKeyVersion: vectors.event_signing_key_version,
  },
];

const TYPE = {
  STOP: 0,
  BOOL: 2,
  BYTE: 3,
  DOUBLE: 4,
  I16: 6,
  I32: 8,
  I64: 10,
  STRING: 11,
  STRUCT: 12,
  MAP: 13,
  SET: 14,
  LIST: 15,
};

function readI32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getInt32(0, false);
}

function readI16(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getInt16(0, false);
}

function skipValue(bytes, offset, type) {
  switch (type) {
    case TYPE.BOOL:
    case TYPE.BYTE:
      return offset + 1;
    case TYPE.I16:
      return offset + 2;
    case TYPE.I32:
      return offset + 4;
    case TYPE.I64:
    case TYPE.DOUBLE:
      return offset + 8;
    case TYPE.STRING: {
      const length = readI32(bytes, offset);
      return offset + 4 + length;
    }
    case TYPE.STRUCT:
      return readFields(bytes, offset).end;
    case TYPE.MAP: {
      const keyType = bytes[offset];
      const valueType = bytes[offset + 1];
      const count = readI32(bytes, offset + 2);
      let next = offset + 6;
      for (let index = 0; index < count; index += 1) {
        next = skipValue(bytes, next, keyType);
        next = skipValue(bytes, next, valueType);
      }
      return next;
    }
    case TYPE.SET:
    case TYPE.LIST: {
      const elementType = bytes[offset];
      const count = readI32(bytes, offset + 1);
      let next = offset + 5;
      for (let index = 0; index < count; index += 1) next = skipValue(bytes, next, elementType);
      return next;
    }
    default:
      throw new Error("Unsupported fixture field type");
  }
}

function readFields(bytes, offset = 0) {
  const fields = [];
  let next = offset;
  while (bytes[next] !== TYPE.STOP) {
    const start = next;
    const type = bytes[next++];
    const id = readI16(bytes, next);
    next += 2;
    const valueOffset = next;
    next = skipValue(bytes, next, type);
    fields.push({ id, type, start, valueOffset, end: next });
  }
  return { fields, end: next + 1 };
}

function removeSignatureField(eventB64, nestedFieldId = null) {
  const bytes = Buffer.from(eventB64, "base64");
  const outerFields = readFields(bytes).fields;
  const signatureField = outerFields.find((field) => field.id === 9);
  assert.ok(signatureField);
  if (nestedFieldId === null) {
    return Buffer.concat([bytes.subarray(0, signatureField.start), bytes.subarray(signatureField.end)]).toString(
      "base64",
    );
  }
  const nested = readFields(bytes, signatureField.valueOffset).fields;
  const field = nested.find((entry) => entry.id === nestedFieldId);
  assert.ok(field);
  return Buffer.concat([bytes.subarray(0, field.start), bytes.subarray(field.end)]).toString("base64");
}

function removeTopLevelField(eventB64, fieldId) {
  const bytes = Buffer.from(eventB64, "base64");
  const field = readFields(bytes).fields.find((entry) => entry.id === fieldId);
  assert.ok(field);
  return Buffer.concat([bytes.subarray(0, field.start), bytes.subarray(field.end)]).toString("base64");
}

function metadata(encodedEvent, keys = signingKeys) {
  return inspectEventMetadata({ sender_id: vectors.event_sender_id, encoded_event: encodedEvent }, keys);
}

test("inspects an SDK-generated signed message and matches its key version", () => {
  assert.deepEqual(metadata(vectors.event_message_b64), {
    EMBEDDED_SIGNATURE_PRESENT: true,
    EMBEDDED_KEY_VERSION_PRESENT: true,
    SENDER_MATCH: true,
    SIGNING_KEY_VERSION_MATCH: true,
    EVENT_TYPE: "message_create",
    KEYCHANGE_PRESENT: false,
    PARSER_STATUS: "ok",
  });
});

test("matches historical signing keys rather than assuming the newest record", () => {
  const keys = [{ userId: vectors.event_sender_id, publicKeyVersion: "999999999999999999" }, ...signingKeys];
  assert.equal(metadata(vectors.event_message_b64, keys).SIGNING_KEY_VERSION_MATCH, true);
});

test("distinguishes a missing signature from a missing signature version", () => {
  const missingSignature = metadata(removeSignatureField(vectors.event_message_b64));
  assert.equal(missingSignature.EMBEDDED_SIGNATURE_PRESENT, false);
  assert.equal(missingSignature.EMBEDDED_KEY_VERSION_PRESENT, false);
  assert.equal(missingSignature.SIGNING_KEY_VERSION_MATCH, null);

  const missingVersion = metadata(removeSignatureField(vectors.event_message_b64, 2));
  assert.equal(missingVersion.EMBEDDED_SIGNATURE_PRESENT, true);
  assert.equal(missingVersion.EMBEDDED_KEY_VERSION_PRESENT, false);
  assert.equal(missingVersion.SIGNING_KEY_VERSION_MATCH, null);
});

test("reports sender and key-version mismatches without exposing their values", () => {
  const result = metadata(vectors.event_message_b64, [
    { userId: "different-sender", publicKeyVersion: vectors.event_signing_key_version },
  ]);
  assert.equal(result.SENDER_MATCH, false);
  assert.equal(result.SIGNING_KEY_VERSION_MATCH, false);
});

test("does not claim a sender or key-version mismatch when the event sender is absent", () => {
  const result = metadata(removeTopLevelField(vectors.event_message_b64, 3));
  assert.equal(result.SENDER_MATCH, null);
  assert.equal(result.SIGNING_KEY_VERSION_MATCH, null);
});

test("identifies an SDK-generated KeyChange event", () => {
  const result = metadata(vectors.event_key_change_b64);
  assert.equal(result.EVENT_TYPE, "conversation_key_change");
  assert.equal(result.KEYCHANGE_PRESENT, true);
  assert.equal(result.PARSER_STATUS, "ok");
});

test("returns only redacted status for malformed or oversized input", () => {
  assert.deepEqual(inspectEventMetadata("A"), {
    EMBEDDED_SIGNATURE_PRESENT: null,
    EMBEDDED_KEY_VERSION_PRESENT: null,
    SENDER_MATCH: null,
    SIGNING_KEY_VERSION_MATCH: null,
    EVENT_TYPE: "unknown",
    KEYCHANGE_PRESENT: null,
    PARSER_STATUS: "malformed",
  });
  assert.equal(inspectEventMetadata("A".repeat(2_000_000)).PARSER_STATUS, "malformed");

  const negativeStringLength = Buffer.from([TYPE.STRING, 0, 3, 255, 255, 255, 255, TYPE.STOP]).toString("base64");
  assert.equal(inspectEventMetadata(negativeStringLength).PARSER_STATUS, "malformed");

  const oversizedList = Buffer.from([TYPE.LIST, 0, 12, TYPE.BYTE, 0, 0, 39, 17, TYPE.STOP]).toString("base64");
  assert.equal(inspectEventMetadata(oversizedList).PARSER_STATUS, "malformed");
});

test("parses the SDK's legacy 0.5 event fixture", () => {
  const result = inspectEventMetadata(legacy.target_event_b64, [
    { userId: legacy.sender_id, publicKeyVersion: legacy.key_version },
  ]);
  assert.equal(result.PARSER_STATUS, "ok");
  assert.equal(result.EVENT_TYPE, "message_create");
});
