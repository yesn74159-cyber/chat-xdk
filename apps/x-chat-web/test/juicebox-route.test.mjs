import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";

const appRoot = new URL("../", import.meta.url);
const accountId = "12345";
const juiceboxConfig = {
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
    { key: "realm-a", value: { token: "mock-token-a" } },
    { key: "realm-b", value: { token: "mock-token-b" } },
  ],
};
const fixture = JSON.stringify({
  user: { id: accountId, username: "local_test_account", name: "Local Test" },
  publicKeys: {
    [accountId]: [
      {
        public_key_version: "7",
        public_key: "identity-7",
        signing_public_key: "signing-7",
        identity_public_key_signature: "signature-7",
        juicebox_config: juiceboxConfig,
      },
      {
        public_key_version: "8",
        public_key: "identity-8",
        signing_public_key: "signing-8",
        identity_public_key_signature: "signature-8",
        juicebox_config: juiceboxConfig,
      },
    ],
  },
});

let child;
let baseUrl;

function startMockServer() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: appRoot,
      env: { ...process.env, X_CHAT_API_MODE: "mock", X_CHAT_MOCK_FIXTURE: fixture, PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`Mock server did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        baseUrl = `http://127.0.0.1:${match[1]}`;
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!baseUrl) {
        clearTimeout(timeout);
        reject(new Error(`Mock server exited with ${code}: ${output}`));
      }
    });
  });
}

before(startMockServer);
after(() => child?.kill("SIGTERM"));

test("Juicebox config derives from the authenticated account and adds exact CSP origins", async () => {
  const response = await fetch(`${baseUrl}/api/juicebox/config?user_id=99999`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.account.id, accountId);
  assert.equal(body.data.account.username, "local_test_account");
  assert.deepEqual(
    body.data.records.map((record) => record.public_key_version),
    ["7", "8"],
  );
  assert.deepEqual(body.data.origins, ["https://realm-a.example.test", "https://realm-b.example.test"]);
  assert.equal(body.data.policyChanged, true);
  assert.match(
    response.headers.get("content-security-policy"),
    /connect-src 'self' https:\/\/api\.x\.com https:\/\/realm-a\.example\.test https:\/\/realm-b\.example\.test/,
  );
  assert.doesNotMatch(response.headers.get("content-security-policy"), /\*|https:\s*;/);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const second = await fetch(`${baseUrl}/api/juicebox/config`);
  const secondBody = await second.json();
  assert.equal(secondBody.data.policyChanged, false);
});
