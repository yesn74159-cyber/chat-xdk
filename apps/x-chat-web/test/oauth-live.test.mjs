import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const clientId = "placeholder-oauth-client-id";
const clientSecret = "placeholder-oauth-client-secret";
const refreshToken = "placeholder-refresh-token";

function baseEnv(extra) {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function startIdp({ expiresIn = 7200 } = {}) {
  const state = {
    challenge: "",
    redirectUri: "",
    tokenCalls: [],
    apiCalls: [],
    accessTokens: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/token") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const call = { form: Object.fromEntries(form), authorization: req.headers.authorization || "" };
      state.tokenCalls.push(call);
      const validBasic =
        call.authorization === `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
      let valid = validBasic && form.get("client_id") === clientId;
      if (form.get("grant_type") === "authorization_code") {
        const expected = createHash("sha256")
          .update(form.get("code_verifier") || "")
          .digest("base64url");
        valid &&=
          expected === state.challenge &&
          form.get("redirect_uri") === state.redirectUri &&
          form.get("code") === "test-authorization-code";
      } else if (form.get("grant_type") === "refresh_token") {
        valid &&= form.get("refresh_token") === refreshToken;
      } else {
        valid = false;
      }
      if (!valid) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const accessToken = `oauth-access-placeholder-${state.accessTokens.length + 1}`;
      state.accessTokens.push(accessToken);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          token_type: "bearer",
          expires_in: expiresIn,
          access_token: accessToken,
          refresh_token: refreshToken,
          scope: "dm.read dm.write tweet.read users.read media.write offline.access",
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/2/users/me") {
      state.apiCalls.push({ authorization: req.headers.authorization || "" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: { id: "1234567890123456789", username: "placeholder_owner", name: "Placeholder Owner" },
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  const idpPort = await listen(server);
  return {
    state,
    port: idpPort,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

function startApp(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.mjs"], {
      cwd: appRoot,
      env: baseEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => reject(new Error(`OAuth test server did not start: ${output}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}` });
      }
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`OAuth test server exited (${code}): ${output}`));
    });
  });
}

function liveEnv(idpPort) {
  return {
    X_CHAT_API_MODE: "live",
    PORT: "0",
    X_OAUTH_CLIENT_ID: clientId,
    X_OAUTH_CLIENT_SECRET: clientSecret,
    X_OAUTH_AUTHORIZE_URL: `http://127.0.0.1:${idpPort}/authorize`,
    X_OAUTH_TOKEN_URL: `http://127.0.0.1:${idpPort}/token`,
    X_OAUTH_SCOPES: "dm.read dm.write tweet.read users.read media.write offline.access",
    X_API_BASE_URL: `http://127.0.0.1:${idpPort}`,
  };
}

async function signIn(idp, app) {
  const login = await fetch(`${app.baseUrl}/api/auth/login`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const location = new URL(login.headers.get("location"));
  idp.state.challenge = location.searchParams.get("code_challenge");
  idp.state.redirectUri = location.searchParams.get("redirect_uri");
  const state = location.searchParams.get("state");
  const callback = await fetch(
    `${app.baseUrl}/api/auth/callback?code=${encodeURIComponent("test-authorization-code")}&state=${encodeURIComponent(state)}`,
  );
  return { login, location, state, callback };
}

test("live OAuth login uses PKCE, single-use state, and never exposes tokens", async () => {
  const idp = await startIdp();
  const app = await startApp(liveEnv(idp.port));
  try {
    const initialStatus = await fetch(`${app.baseUrl}/api/auth/status`).then((response) => response.json());
    assert.equal(initialStatus.mode, "live");
    assert.equal(initialStatus.enabled, true);
    assert.equal(initialStatus.configured, true);
    assert.equal(initialStatus.authenticated, false);
    assert.equal(initialStatus.expiresAt, null);
    assert.deepEqual(initialStatus.scopes, [
      "dm.read",
      "dm.write",
      "tweet.read",
      "users.read",
      "media.write",
      "offline.access",
    ]);

    const login = await fetch(`${app.baseUrl}/api/auth/login`, { redirect: "manual" });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get("cache-control"), "no-store");
    const location = new URL(login.headers.get("location"));
    assert.equal(location.pathname, "/authorize");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.equal(location.searchParams.get("client_id"), clientId);
    assert.equal(
      location.searchParams.get("redirect_uri"),
      `${app.baseUrl}/api/auth/callback`,
      "the default redirect must be the bound loopback callback",
    );
    assert.equal(
      location.searchParams.get("scope"),
      "dm.read dm.write tweet.read users.read media.write offline.access",
    );
    assert.match(location.searchParams.get("state"), /^[A-Za-z0-9_-]{16,}$/);
    assert.match(location.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    idp.state.challenge = location.searchParams.get("code_challenge");
    idp.state.redirectUri = location.searchParams.get("redirect_uri");
    const state = location.searchParams.get("state");

    const wrongState = await fetch(`${app.baseUrl}/api/auth/callback?code=test-authorization-code&state=unknown`);
    assert.equal(wrongState.status, 400);
    assert.equal(idp.state.tokenCalls.length, 0, "an unknown state must not reach the token endpoint");

    const callback = await fetch(
      `${app.baseUrl}/api/auth/callback?code=test-authorization-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(callback.status, 200);
    assert.match(callback.headers.get("content-type"), /^text\/html/);
    const callbackBody = await callback.text();
    assert.match(callbackBody, /เชื่อมต่อบัญชี X สำเร็จ/);

    assert.equal(idp.state.tokenCalls.length, 1);
    const exchange = idp.state.tokenCalls[0];
    assert.equal(exchange.form.grant_type, "authorization_code");
    assert.equal(exchange.form.code, "test-authorization-code");
    assert.equal(exchange.form.redirect_uri, `${app.baseUrl}/api/auth/callback`);
    assert.ok((exchange.form.code_verifier || "").length >= 43);
    assert.equal(exchange.authorization, `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);

    const replay = await fetch(
      `${app.baseUrl}/api/auth/callback?code=test-authorization-code&state=${encodeURIComponent(state)}`,
    );
    assert.equal(replay.status, 400, "the authorization state must be single-use");
    assert.equal(idp.state.tokenCalls.length, 1);

    const authedStatusResponse = await fetch(`${app.baseUrl}/api/auth/status`);
    const authedStatusText = await authedStatusResponse.text();
    const authedStatus = JSON.parse(authedStatusText);
    assert.equal(authedStatus.authenticated, true);
    assert.equal(authedStatus.hasRefreshToken, true);
    assert.equal(Number.isInteger(authedStatus.expiresAt), true);
    assert.doesNotMatch(authedStatusText, /oauth-access-placeholder/);
    assert.doesNotMatch(callbackBody, /oauth-access-placeholder/);

    const me = await fetch(`${app.baseUrl}/api/me`);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).data.username, "placeholder_owner");
    assert.equal(idp.state.apiCalls.length, 1);
    assert.equal(idp.state.apiCalls[0].authorization, `Bearer ${idp.state.accessTokens[0]}`);

    const appStatus = await fetch(`${app.baseUrl}/api/status`).then((response) => response.json());
    assert.equal(appStatus.tokenConfigured, true);
    assert.equal(appStatus.auth.authenticated, true);
    assert.doesNotMatch(JSON.stringify(appStatus), /oauth-access-placeholder/);
  } finally {
    app.child.kill();
    await idp.stop();
  }
});

test("an expired OAuth access token is refreshed before the upstream request", async () => {
  const idp = await startIdp({ expiresIn: 0 });
  const app = await startApp(liveEnv(idp.port));
  try {
    const { callback } = await signIn(idp, app);
    assert.equal(callback.status, 200);
    assert.equal(idp.state.accessTokens.length, 1);

    const me = await fetch(`${app.baseUrl}/api/me`);
    assert.equal(me.status, 200);
    assert.equal(idp.state.tokenCalls.length, 2);
    assert.equal(idp.state.tokenCalls[1].form.grant_type, "refresh_token");
    assert.equal(idp.state.tokenCalls[1].form.refresh_token, refreshToken);
    assert.equal(idp.state.apiCalls.at(-1).authorization, `Bearer ${idp.state.accessTokens[1]}`);

    const statusText = await fetch(`${app.baseUrl}/api/auth/status`).then((response) => response.text());
    assert.doesNotMatch(statusText, /oauth-access-placeholder/);
  } finally {
    app.child.kill();
    await idp.stop();
  }
});

test("auth routes are disabled in mock mode and unconfigured live mode", async () => {
  const mock = await startApp({ X_CHAT_API_MODE: "mock", PORT: "0" });
  try {
    const status = await fetch(`${mock.baseUrl}/api/auth/status`).then((response) => response.json());
    assert.equal(status.enabled, false);
    assert.equal(status.authenticated, false);
    assert.equal((await fetch(`${mock.baseUrl}/api/auth/login`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${mock.baseUrl}/api/auth/status`, { method: "POST" })).status, 405);
  } finally {
    mock.child.kill();
  }

  const unconfigured = await startApp({ X_CHAT_API_MODE: "live", PORT: "0" });
  try {
    assert.equal((await fetch(`${unconfigured.baseUrl}/api/auth/login`, { redirect: "manual" })).status, 503);
    const status = await fetch(`${unconfigured.baseUrl}/api/auth/status`).then((response) => response.json());
    assert.equal(status.configured, false);
    assert.equal(status.enabled, false);
  } finally {
    unconfigured.child.kill();
  }
});
