const CACHE_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ITERATIONS = 310_000;
const FORBIDDEN_FIELD = /(?:^|_)(?:plaintext|private|token|passphrase|pin|key_blob)(?:$|_)/i;

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function base64ToBytes(value) {
  if (typeof value !== "string" || !value) throw new Error("Invalid encrypted cache");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function cryptoApi() {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is unavailable");
  return globalThis.crypto;
}

function assertPersistable(value, key = "") {
  if (FORBIDDEN_FIELD.test(key)) throw new Error(`Refusing to persist sensitive field: ${key}`);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const item of value) assertPersistable(item);
    return;
  }
  if (!value || typeof value !== "object" || value instanceof Uint8Array) throw new Error("Invalid cache value");
  for (const [childKey, childValue] of Object.entries(value)) assertPersistable(childValue, childKey);
}

async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("Passphrase must be at least 12 characters");
  }
  const crypto = cryptoApi();
  const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt a metadata/ciphertext-only cache document. The passphrase is never retained. */
export async function encryptCacheDocument(document, passphrase) {
  assertPersistable(document);
  const crypto = cryptoApi();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: CACHE_VERSION, document }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    version: CACHE_VERSION,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptCacheDocument(envelope, passphrase) {
  if (!envelope || envelope.version !== CACHE_VERSION) throw new Error("Unsupported encrypted cache version");
  const crypto = cryptoApi();
  try {
    const key = await deriveKey(passphrase, base64ToBytes(envelope.salt));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
      key,
      base64ToBytes(envelope.ciphertext),
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext));
    if (parsed?.version !== CACHE_VERSION || !parsed.document || typeof parsed.document !== "object") {
      throw new Error("Invalid encrypted cache");
    }
    assertPersistable(parsed.document);
    return parsed.document;
  } catch (error) {
    if (error.message?.startsWith("Invalid") || error.message?.startsWith("Unsupported")) throw error;
    throw new Error("Unable to unlock encrypted cache");
  }
}

/** Accept only the ciphertext envelope shape produced by encryptCacheDocument. */
export function validateCacheEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid encrypted cache");
  if (value.version !== CACHE_VERSION) throw new Error("Unsupported encrypted cache version");
  for (const field of ["salt", "iv", "ciphertext"]) {
    if (typeof value[field] !== "string" || !value[field]) throw new Error("Invalid encrypted cache");
  }
  return value;
}

export function cacheDocument({ conversations = [], events = {}, deliveryIds = [], audits = [] } = {}) {
  return {
    conversations,
    events,
    deliveryIds: [...new Set(deliveryIds)].slice(-1000),
    audits: audits.slice(-500),
  };
}

/** Small IndexedDB adapter; callers hold the unlocked document only in memory. */
export function createCacheStore(databaseName = "x-chat-local-cache-v1") {
  const db = new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("cache");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Unable to open local cache"));
  });
  async function transaction(mode, action) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const request = action(database.transaction("cache", mode).objectStore("cache"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Unable to access local cache"));
    });
  }
  return {
    load: () => transaction("readonly", (store) => store.get("current")),
    save: (value) => transaction("readwrite", (store) => store.put(value, "current")),
    clear: () => transaction("readwrite", (store) => store.clear()),
  };
}
