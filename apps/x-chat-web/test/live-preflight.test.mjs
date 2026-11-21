import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const placeholderToken = "test-only-placeholder-not-a-credential";

function runPreflight(extra) {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const result = spawnSync(process.execPath, ["scripts/live-preflight.mjs"], {
    cwd: appRoot,
    env: { ...env, ...extra },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("a fully configured live environment passes without echoing secrets", () => {
  const { status, output } = runPreflight({
    X_CHAT_API_MODE: "live",
    X_ACCESS_TOKEN: placeholderToken,
    X_CHAT_LIVE_OWNER_USER_ID: "1111111111111111111",
    X_CHAT_LIVE_OWNER_USERNAME: "owner_placeholder",
    X_CHAT_LIVE_RECIPIENT_USER_ID: "2222222222222222222",
    X_CHAT_LIVE_RECIPIENT_USERNAME: "recipient_placeholder",
    PORT: "8787",
  });
  assert.equal(status, 0);
  assert.match(output, /live-preflight: PASS/);
  assert.doesNotMatch(output, /FAIL/);
  assert.doesNotMatch(output, new RegExp(placeholderToken));
  assert.doesNotMatch(output, /owner_placeholder|recipient_placeholder/);
});

test("an OAuth-only environment with loopback redirect and scopes passes", () => {
  const { status, output } = runPreflight({
    X_CHAT_API_MODE: "live",
    X_OAUTH_CLIENT_ID: "placeholder-client-id",
    X_OAUTH_REDIRECT_URI: "http://127.0.0.1:8787/api/auth/callback",
    X_OAUTH_SCOPES: "dm.read dm.write tweet.read users.read media.write offline.access",
    PORT: "8787",
  });
  assert.equal(status, 0);
  assert.match(output, /PASS\s+scopes/);
  assert.match(output, /live-preflight: PASS \(6 checks, 1 warning, 0 failures\)/);
});

test("missing credentials and non-loopback redirects fail", () => {
  const missing = runPreflight({ X_CHAT_API_MODE: "live" });
  assert.equal(missing.status, 1);
  assert.match(missing.output, /FAIL\s+credential/);

  const remoteRedirect = runPreflight({
    X_CHAT_API_MODE: "live",
    X_OAUTH_CLIENT_ID: "placeholder-client-id",
    X_OAUTH_REDIRECT_URI: "https://example.com/callback",
    X_OAUTH_SCOPES: "dm.read dm.write tweet.read users.read",
  });
  assert.equal(remoteRedirect.status, 1);
  assert.match(remoteRedirect.output, /FAIL\s+redirect_uri/);

  const missingScope = runPreflight({
    X_CHAT_API_MODE: "live",
    X_OAUTH_CLIENT_ID: "placeholder-client-id",
    X_OAUTH_SCOPES: "dm.read users.read",
  });
  assert.equal(missingScope.status, 1);
  assert.match(missingScope.output, /FAIL\s+scopes.*dm\.write, tweet\.read/);
});

test("mock mode runs the checks as warnings without failing", () => {
  const { status, output } = runPreflight({ X_CHAT_API_MODE: "mock" });
  assert.equal(status, 0);
  assert.match(output, /WARN\s+mode/);
  assert.match(output, /live-preflight: PASS/);
});
