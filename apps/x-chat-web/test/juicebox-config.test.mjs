import assert from "node:assert/strict";
import test from "node:test";
import { juiceboxConfiguration } from "../lib/juicebox-config.mjs";

const config = {
  key_store_token_map_json: JSON.stringify({
    realms: [
      { id: "realm-a", address: "https://realm-a.example.test/v1" },
      { id: "realm-b", address: "https://realm-b.example.test" },
    ],
    register_threshold: 2,
    recover_threshold: 2,
    pin_hashing_mode: "Standard2019",
  }),
  token_map: [
    { key: "realm-a", value: { token: "realm-token-a" } },
    { key: "realm-b", value: { token: "realm-token-b" } },
  ],
};

function record(juiceboxConfig = config, version = "7") {
  return {
    public_key_version: version,
    public_key: `identity-${version}`,
    signing_public_key: `signing-${version}`,
    identity_public_key_signature: `signature-${version}`,
    juicebox_config: juiceboxConfig,
  };
}

test("extracts exact HTTPS origins from the X API Juicebox config without choosing a key version", () => {
  const result = juiceboxConfiguration([record(config, "7"), record(config, "8")]);
  assert.deepEqual(result.origins, ["https://realm-a.example.test", "https://realm-b.example.test"]);
  assert.equal(JSON.parse(result.configJson).key_store_token_map_json, config.key_store_token_map_json);
  assert.deepEqual(
    result.records.map((entry) => entry.public_key_version),
    ["7", "8"],
  );
  assert.equal(JSON.stringify(result.records).includes("realm-token"), false);
});

test("rejects non-HTTPS realm addresses and URL credentials", () => {
  const insecure = {
    ...config,
    key_store_token_map_json: JSON.stringify({
      realms: [
        { id: "realm-a", address: "http://realm-a.example.test" },
        { id: "realm-b", address: "https://realm-b.example.test" },
      ],
    }),
  };
  assert.throws(() => juiceboxConfiguration([record(insecure)]), /must use HTTPS/);
  const credentialed = {
    ...config,
    key_store_token_map_json: JSON.stringify({
      realms: [
        { id: "realm-a", address: "https://user:pass@realm-a.example.test" },
        { id: "realm-b", address: "https://realm-b.example.test" },
      ],
    }),
  };
  assert.throws(() => juiceboxConfiguration([record(credentialed)]), /must use HTTPS/);
});

test("rejects missing or mismatched realm tokens and ambiguous per-record configs", () => {
  assert.throws(() => juiceboxConfiguration([]), /No public-key records/);
  assert.throws(() => juiceboxConfiguration([record({ ...config, token_map: [] })]), /does not match/);
  const otherConfig = {
    ...config,
    token_map: [
      { key: "realm-a", value: { token: "other-token-a" } },
      { key: "realm-b", value: { token: "other-token-b" } },
    ],
  };
  assert.throws(() => juiceboxConfiguration([record(), record(otherConfig, "8")]), /different Juicebox configurations/);
});
