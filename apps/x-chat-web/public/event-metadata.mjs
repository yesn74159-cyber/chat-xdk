const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_STRING_BYTES = MAX_EVENT_BYTES;
const MAX_COLLECTION_SIZE = 10_000;
const MAX_TOTAL_ELEMENTS = 100_000;
const MAX_STRUCT_FIELDS = 10_000;
const MAX_NESTING_DEPTH = 32;

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

const EVENT_TYPES = new Map([
  [1, "message_create"],
  [3, "conversation_key_change"],
  [4, "group_change"],
  [5, "message_failure"],
  [6, "message_typing"],
  [7, "message_delete"],
  [8, "conversation_delete"],
  [9, "conversation_metadata_change"],
  [10, "grok_search_response"],
  [12, "mark_conversation_read"],
  [13, "mark_conversation_unread"],
  [14, "member_account_delete"],
  [15, "grok_message"],
  [16, "grok_response"],
  [17, "pin_message"],
  [18, "unpin_message"],
  [19, "pmk_bundle_update"],
]);

class EventReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.totalElements = 0;
    this.totalFields = 0;
  }

  require(size) {
    if (!Number.isSafeInteger(size) || size < 0 || this.offset + size > this.bytes.length) {
      throw new Error("truncated");
    }
  }

  readByte() {
    this.require(1);
    return this.bytes[this.offset++];
  }

  readI16() {
    this.require(2);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 2).getInt16(0, false);
    this.offset += 2;
    return value;
  }

  readI32() {
    this.require(4);
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getInt32(0, false);
    this.offset += 4;
    return value;
  }

  readString() {
    const length = this.readI32();
    if (length < 0 || length > MAX_STRING_BYTES) throw new Error("invalid string length");
    this.require(length);
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      this.bytes.subarray(this.offset, this.offset + length),
    );
    this.offset += length;
    return value;
  }

  readFields(onField, depth = 0) {
    if (depth > MAX_NESTING_DEPTH) throw new Error("nesting limit");
    let fieldCount = 0;
    while (true) {
      const type = this.readByte();
      if (type === TYPE.STOP) return fieldCount;
      if (++fieldCount > MAX_STRUCT_FIELDS || ++this.totalFields > MAX_TOTAL_ELEMENTS) {
        throw new Error("field limit");
      }
      const id = this.readI16();
      if (onField(id, type, depth) !== true) this.skipValue(type, depth + 1);
    }
  }

  readCollectionSize() {
    const size = this.readI32();
    if (size < 0 || size > MAX_COLLECTION_SIZE) throw new Error("collection limit");
    this.totalElements += size;
    if (this.totalElements > MAX_TOTAL_ELEMENTS) throw new Error("cumulative collection limit");
    return size;
  }

  skipValue(type, depth) {
    if (depth > MAX_NESTING_DEPTH) throw new Error("nesting limit");
    switch (type) {
      case TYPE.BOOL:
      case TYPE.BYTE:
        this.require(1);
        this.offset += 1;
        return;
      case TYPE.I16:
        this.require(2);
        this.offset += 2;
        return;
      case TYPE.I32:
        this.require(4);
        this.offset += 4;
        return;
      case TYPE.I64:
      case TYPE.DOUBLE:
        this.require(8);
        this.offset += 8;
        return;
      case TYPE.STRING: {
        const length = this.readI32();
        if (length < 0 || length > MAX_STRING_BYTES) throw new Error("invalid string length");
        this.require(length);
        this.offset += length;
        return;
      }
      case TYPE.STRUCT:
        this.readFields((_id, fieldType) => {
          this.skipValue(fieldType, depth + 1);
          return true;
        }, depth);
        return;
      case TYPE.MAP: {
        const keyType = this.readByte();
        const valueType = this.readByte();
        const size = this.readCollectionSize();
        for (let index = 0; index < size; index += 1) {
          this.skipValue(keyType, depth + 1);
          this.skipValue(valueType, depth + 1);
        }
        return;
      }
      case TYPE.SET:
      case TYPE.LIST: {
        const elementType = this.readByte();
        const size = this.readCollectionSize();
        for (let index = 0; index < size; index += 1) this.skipValue(elementType, depth + 1);
        return;
      }
      default:
        throw new Error("unknown thrift type");
    }
  }

  readExpectedString(type) {
    if (type !== TYPE.STRING) throw new Error("unexpected thrift type");
    return this.readString();
  }

  readSignature(depth) {
    let signature = "";
    let publicKeyVersion = "";
    this.readFields((id, type, fieldDepth) => {
      if (id === 1 || id === 2) {
        const value = this.readExpectedString(type);
        if (id === 1) signature = value;
        else publicKeyVersion = value;
        return true;
      }
      this.skipValue(type, fieldDepth + 1);
      return true;
    }, depth);
    return { signature, publicKeyVersion };
  }

  readEventType(depth) {
    let eventType = "unknown";
    let variantCount = 0;
    this.readFields((id, type, fieldDepth) => {
      variantCount += 1;
      if (variantCount > 1 || type !== TYPE.STRUCT) throw new Error("invalid event union");
      eventType = EVENT_TYPES.get(id) ?? "unknown";
      this.skipValue(type, fieldDepth + 1);
      return true;
    }, depth);
    if (variantCount !== 1) throw new Error("invalid event union");
    return eventType;
  }

  readEvent() {
    let senderId = "";
    let signature = { signature: "", publicKeyVersion: "" };
    let eventType = "unknown";
    this.readFields((id, type, depth) => {
      if (id === 3) {
        senderId = this.readExpectedString(type);
        return true;
      }
      if (id === 7) {
        if (type !== TYPE.STRUCT) throw new Error("unexpected event detail type");
        eventType = this.readEventType(depth + 1);
        return true;
      }
      if (id === 9) {
        if (type !== TYPE.STRUCT) throw new Error("unexpected signature type");
        signature = this.readSignature(depth + 1);
        return true;
      }
      this.skipValue(type, depth + 1);
      return true;
    });
    if (this.offset !== this.bytes.length) throw new Error("trailing bytes");
    return { senderId, signature, eventType };
  }
}

function decodeEvent(event) {
  const encoded = typeof event === "string" ? event : (event?.encodedEvent ?? event?.encoded_event);
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil((MAX_EVENT_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(encoded)
  ) {
    throw new Error("invalid event base64");
  }
  const binary = atob(encoded);
  if (binary.length > MAX_EVENT_BYTES) throw new Error("event size limit");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function unknownMetadata() {
  return {
    EMBEDDED_SIGNATURE_PRESENT: null,
    EMBEDDED_KEY_VERSION_PRESENT: null,
    SENDER_MATCH: null,
    SIGNING_KEY_VERSION_MATCH: null,
    EVENT_TYPE: "unknown",
    KEYCHANGE_PRESENT: null,
    PARSER_STATUS: "malformed",
  };
}

// SENDER_MATCH checks whether supplied records include the embedded sender.
export function inspectEventMetadata(event, signingKeys = null) {
  try {
    const parsed = new EventReader(decodeEvent(event)).readEvent();
    const signaturePresent = parsed.signature.signature.length > 0;
    const keyVersionPresent = parsed.signature.publicKeyVersion.length > 0;
    const ownerKeys =
      parsed.senderId.length > 0 && Array.isArray(signingKeys)
        ? signingKeys.filter((key) => key?.userId === parsed.senderId)
        : null;

    return {
      EMBEDDED_SIGNATURE_PRESENT: signaturePresent,
      EMBEDDED_KEY_VERSION_PRESENT: keyVersionPresent,
      SENDER_MATCH: ownerKeys === null ? null : ownerKeys.length > 0,
      SIGNING_KEY_VERSION_MATCH:
        !signaturePresent || !keyVersionPresent || ownerKeys === null
          ? null
          : ownerKeys.some((key) => key.publicKeyVersion === parsed.signature.publicKeyVersion),
      EVENT_TYPE: parsed.eventType,
      KEYCHANGE_PRESENT: parsed.eventType === "conversation_key_change",
      PARSER_STATUS: "ok",
    };
  } catch {
    return unknownMetadata();
  }
}
