import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const placeholderToken = "test-only-placeholder-not-a-credential";

function runStartLive(extra) {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const result = spawnSync(process.execPath, ["scripts/start-live.mjs"], {
    cwd: appRoot,
    env: { ...env, X_CHAT_START_LIVE_DRY_RUN: "1", ...extra },
    encoding: "utf8",
    timeout: 10_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("start:live uses an environment token without echoing it", () => {
  const { status, output } = runStartLive({ X_ACCESS_TOKEN: placeholderToken });
  assert.equal(status, 0);
  assert.match(output, /X_ACCESS_TOKEN from the environment/);
  assert.doesNotMatch(output, new RegExp(placeholderToken));
});

test("start:live starts in OAuth mode when only a client id is configured", () => {
  const { status, output } = runStartLive({ X_OAUTH_CLIENT_ID: "placeholder-client-id" });
  assert.equal(status, 0);
  assert.match(output, /OAuth mode/);
  assert.match(output, /\/api\/auth\/login/);
});

test("start:live asks for a missing credential with a clear message", () => {
  const { status, output } = runStartLive({});
  assert.equal(status, 2);
  assert.match(output, /X_ACCESS_TOKEN หรือ X_OAUTH_CLIENT_ID/);
});
