// Normalises /public_keys payloads into the shape the SDK expects. An empty
// record list means the key is unavailable (for example an old group
// creator/admin whose key was never published); callers must surface that
// instead of silently dropping the signer.

function field(record, snake, camel) {
  return record?.[snake] ?? record?.[camel] ?? "";
}

export function signingKeyRecords(userId, response) {
  const data = response?.data ?? response;
  const values = Array.isArray(data) ? data : data ? [data] : [];
  return values
    .filter(
      (record) =>
        record &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        ["public_key", "public_key_version", "publicKey", "publicKeyVersion"].some((key) => key in record),
    )
    .map((record) => ({
      userId,
      publicKeyVersion: String(field(record, "public_key_version", "publicKeyVersion")),
      publicKey: field(record, "signing_public_key", "signingPublicKey"),
      identityPublicKey: field(record, "public_key", "publicKey"),
      identityPublicKeySignature: field(record, "identity_public_key_signature", "identityPublicKeySignature"),
    }));
}
