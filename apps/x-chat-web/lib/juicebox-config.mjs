function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseConfig(record) {
  const config = record?.juicebox_config ?? record?.juiceboxConfig;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Juicebox config is missing from a public-key record");
  }
  if (typeof config.key_store_token_map_json !== "string") {
    throw new Error("Juicebox key-store config is missing");
  }

  let keyStoreConfig;
  try {
    keyStoreConfig = JSON.parse(config.key_store_token_map_json);
  } catch {
    throw new Error("Juicebox key-store config is invalid");
  }
  const realms = keyStoreConfig?.realms;
  if (!Array.isArray(realms) || !realms.length) throw new Error("Juicebox realms are missing");

  const realmIds = new Set();
  const origins = new Set();
  for (const realm of realms) {
    if (!realm || typeof realm.id !== "string" || !realm.id || realmIds.has(realm.id.toLowerCase())) {
      throw new Error("Juicebox realm IDs are invalid");
    }
    realmIds.add(realm.id.toLowerCase());
    let address;
    try {
      address = new URL(realm.address);
    } catch {
      throw new Error("Juicebox realm address is invalid");
    }
    if (address.protocol !== "https:" || address.username || address.password) {
      throw new Error("Juicebox realms must use HTTPS without URL credentials");
    }
    origins.add(address.origin);
  }

  const tokenMap = config.token_map;
  if (!Array.isArray(tokenMap)) throw new Error("Juicebox realm token map is missing");
  const tokenIds = new Set();
  for (const entry of tokenMap) {
    const id = typeof entry?.key === "string" ? entry.key.toLowerCase() : "";
    if (!id || tokenIds.has(id) || typeof entry?.value?.token !== "string" || !entry.value.token) {
      throw new Error("Juicebox realm token map is invalid");
    }
    tokenIds.add(id);
  }
  if (tokenIds.size !== realmIds.size || [...realmIds].some((id) => !tokenIds.has(id))) {
    throw new Error("Juicebox realm token map does not match the realm configuration");
  }

  return { config, canonical: canonicalJson(config), origins: [...origins].sort() };
}

export function juiceboxConfiguration(records) {
  if (!Array.isArray(records) || !records.length) throw new Error("No public-key records are available");
  const parsed = records.map((record) => {
    for (const field of ["public_key_version", "public_key", "signing_public_key", "identity_public_key_signature"]) {
      const camelField = field.replaceAll(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (typeof (record?.[field] ?? record?.[camelField]) !== "string") {
        throw new Error("A public-key record is incomplete");
      }
    }
    return parseConfig(record);
  });
  const first = parsed[0];
  if (parsed.some((entry) => entry.canonical !== first.canonical)) {
    throw new Error("Public-key records contain different Juicebox configurations");
  }
  return {
    configJson: JSON.stringify(first.config),
    origins: first.origins,
    records: records.map((record) => ({
      public_key_version: String(record.public_key_version ?? record.publicKeyVersion),
      public_key: record.public_key ?? record.publicKey,
      signing_public_key: record.signing_public_key ?? record.signingPublicKey,
      identity_public_key_signature: record.identity_public_key_signature ?? record.identityPublicKeySignature,
    })),
  };
}
