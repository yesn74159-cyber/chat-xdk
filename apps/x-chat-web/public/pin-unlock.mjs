export function realmTokensFromConfig(configJson) {
  let config;
  try {
    config = JSON.parse(configJson);
  } catch {
    throw new Error("Juicebox configuration is invalid");
  }
  if (!Array.isArray(config?.token_map)) throw new Error("Juicebox realm token map is missing");
  const tokens = new Map();
  for (const entry of config.token_map) {
    const realmId = typeof entry?.key === "string" ? entry.key.toLowerCase() : "";
    const token = entry?.value?.token;
    if (!realmId || tokens.has(realmId) || typeof token !== "string" || !token) {
      throw new Error("Juicebox realm token map is invalid");
    }
    tokens.set(realmId, token);
  }
  return tokens;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function base64Shape(value, urlSafe = false) {
  if (typeof value !== "string" || !value) return false;
  const alphabet = urlSafe ? "[A-Za-z0-9_-]" : "[A-Za-z0-9+/]";
  return new RegExp(`^(?:${alphabet}{4})*(?:${alphabet}{2}==|${alphabet}{3}=|${alphabet}{2,3})?$`).test(value);
}

function sdkCheck(check) {
  try {
    return check() === true;
  } catch (error) {
    if (error?.kind === "invalidInput") return false;
    throw error;
  }
}

function unlockDiagnostics(recovered, records, evaluations) {
  const versions = records
    .map((record) => record.public_key_version ?? record.publicKeyVersion)
    .filter((version) => typeof version === "string" && version.length > 0);
  const versionCounts = new Map();
  for (const version of versions) versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);

  const recordKeys = records.map((record) =>
    JSON.stringify([
      record.public_key_version ?? record.publicKeyVersion,
      record.public_key ?? record.publicKey,
      record.signing_public_key ?? record.signingPublicKey,
      record.identity_public_key_signature ?? record.identityPublicKeySignature,
    ]),
  );
  const uniqueRecordCount = new Set(recordKeys).size;

  return {
    recordCount: records.length,
    duplicateRecordCount: records.length - uniqueRecordCount,
    distinctVersionCount: versionCounts.size,
    duplicateVersionCount: [...versionCounts.values()].reduce((total, count) => total + count - 1, 0),
    recoveredSigning: {
      type: valueType(recovered?.signing),
      standardBase64Shape: base64Shape(recovered?.signing),
      urlSafeBase64Shape: base64Shape(recovered?.signing, true),
    },
    records: evaluations.map(
      ({ version, identity, signing, signature, signingMatchesRecovered, registeredKeyMatches, keyBindingValid }) => ({
        fieldTypes: {
          version: valueType(version),
          identity: valueType(identity),
          signing: valueType(signing),
          signature: valueType(signature),
        },
        signingVersionDecimal: typeof version === "string" && /^\d+$/.test(version),
        publicKeyFormats: {
          identityStandardBase64Shape: base64Shape(identity),
          identityUrlSafeBase64Shape: base64Shape(identity, true),
          signingStandardBase64Shape: base64Shape(signing),
          signingUrlSafeBase64Shape: base64Shape(signing, true),
          signatureStandardBase64Shape: base64Shape(signature),
          signatureUrlSafeBase64Shape: base64Shape(signature, true),
        },
        signingMatchesRecovered,
        matchesRegisteredKey: registeredKeyMatches,
        verifyKeyBinding: keyBindingValid,
      }),
    ),
  };
}

export async function unlockExistingIdentity({ chat, pinBytes, account, records }) {
  try {
    if (
      !(pinBytes instanceof Uint8Array) ||
      pinBytes.length !== 4 ||
      pinBytes.some((digit) => digit < 48 || digit > 57)
    ) {
      throw new Error("Passcode must be exactly four digits");
    }
    const userId = String(account?.id ?? "");
    if (!/^\d{1,19}$/.test(userId) || !Array.isArray(records) || !records.length) {
      throw new Error("Authenticated account or public-key records are invalid");
    }

    await chat.unlock(pinBytes);
    if (!chat.isUnlocked()) throw new Error("Juicebox did not restore an unlocked identity");
    const recovered = chat.getPublicKeys();
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    let recoveredSignature;
    let evaluations;
    try {
      recoveredSignature = chat.sign(challenge);
      evaluations = records.map((record) => {
        const version = record?.public_key_version ?? record?.publicKeyVersion;
        const identity = record?.public_key ?? record?.publicKey;
        const signing = record?.signing_public_key ?? record?.signingPublicKey;
        const signature = record?.identity_public_key_signature ?? record?.identityPublicKeySignature;
        const fieldsValid = [version, identity, signing, signature].every(
          (value) => typeof value === "string" && value,
        );
        const registeredKeyMatches =
          typeof identity === "string" && identity ? sdkCheck(() => chat.matchesRegisteredKey(identity)) : false;
        const keyBindingValid = [identity, signing, signature].every((value) => typeof value === "string" && value)
          ? sdkCheck(() => chat.verifyKeyBinding(identity, signing, signature))
          : false;
        const signingMatchesRecovered =
          typeof signing === "string" && signing
            ? sdkCheck(() => chat.verify(signing, recoveredSignature, challenge))
            : false;
        return {
          record,
          version,
          identity,
          signing,
          signature,
          fieldsValid,
          signingMatchesRecovered,
          registeredKeyMatches,
          keyBindingValid,
        };
      });
    } finally {
      challenge.fill(0);
      recoveredSignature?.fill(0);
    }
    const matches = evaluations.filter(
      (entry) =>
        entry.fieldsValid && entry.signingMatchesRecovered && entry.registeredKeyMatches && entry.keyBindingValid,
    );
    if (matches.length !== 1) {
      const diagnostic = unlockDiagnostics(recovered, records, evaluations);
      throw new Error(
        `Recovered key does not match exactly one verified public-key record (redacted diagnostics: ${JSON.stringify(diagnostic)})`,
      );
    }

    const record = matches[0].record;
    const signingKeyVersion = String(record.public_key_version ?? record.publicKeyVersion);
    chat.setIdentity({ userId, signingKeyVersion });
    chat.setCacheKeys(true);
    return signingKeyVersion;
  } catch (error) {
    chat.lock();
    throw error;
  } finally {
    pinBytes?.fill(0);
  }
}
