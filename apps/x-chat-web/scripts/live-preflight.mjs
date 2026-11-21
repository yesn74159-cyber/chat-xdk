/**
 * Read-only live-mode readiness check.
 * Prints check names and statuses only; never prints credential values.
 */
const REQUIRED_SCOPES = ["dm.read", "dm.write", "tweet.read", "users.read"];
const RECOMMENDED_SCOPES = ["media.write", "offline.access"];
const TARGET_VARS = [
  "X_CHAT_LIVE_OWNER_USER_ID",
  "X_CHAT_LIVE_OWNER_USERNAME",
  "X_CHAT_LIVE_RECIPIENT_USER_ID",
  "X_CHAT_LIVE_RECIPIENT_USERNAME",
];

const env = process.env;
/** @type {Array<{ level: "PASS" | "WARN" | "FAIL", name: string, detail: string }>} */
const results = [];

function record(level, name, detail) {
  results.push({ level, name, detail });
}

function isLoopbackRedirect(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "::1");
  } catch {
    return false;
  }
}

const mode = env.X_CHAT_API_MODE || "live";
if (mode === "mock") {
  record("WARN", "mode", "X_CHAT_API_MODE=mock; live checks are not exercised");
} else if (mode === "live") {
  record("PASS", "mode", "X_CHAT_API_MODE=live");
} else {
  record("FAIL", "mode", "X_CHAT_API_MODE must be live or mock");
}

const hasStaticToken = Boolean(env.X_ACCESS_TOKEN);
const hasOAuthClient = Boolean(env.X_OAUTH_CLIENT_ID);
if (hasStaticToken && hasOAuthClient) {
  record("WARN", "credential", "both X_ACCESS_TOKEN and OAuth client are set; the static token takes precedence");
} else if (hasStaticToken) {
  record("PASS", "credential", "X_ACCESS_TOKEN is set in the process environment");
} else if (hasOAuthClient) {
  record("PASS", "credential", "OAuth client id is set; sign in at /api/auth/login after starting the server");
} else if (mode === "mock") {
  record("WARN", "credential", "no live credential is set; mock mode does not need one");
} else {
  record("FAIL", "credential", "set X_ACCESS_TOKEN or X_OAUTH_CLIENT_ID in the process environment");
}

const redirectUri = env.X_OAUTH_REDIRECT_URI || "";
if (!redirectUri) {
  record("PASS", "redirect_uri", "default loopback callback http://127.0.0.1:<PORT>/api/auth/callback");
} else if (isLoopbackRedirect(redirectUri)) {
  record("PASS", "redirect_uri", "callback is a loopback HTTP URL");
} else {
  record("FAIL", "redirect_uri", "X_OAUTH_REDIRECT_URI must be a loopback (127.0.0.1/localhost) HTTP URL");
}

const scopes = (env.X_OAUTH_SCOPES || "").trim().split(/\s+/).filter(Boolean);
if (!hasOAuthClient) {
  record("WARN", "scopes", "not checked because no OAuth client id is set");
} else {
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  const recommendedMissing = RECOMMENDED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) {
    record("FAIL", "scopes", `missing required scopes: ${missing.join(", ")}`);
  } else {
    record("PASS", "scopes", `required scopes present: ${REQUIRED_SCOPES.join(", ")}`);
  }
  if (recommendedMissing.length) {
    record("WARN", "scopes_optional", `missing recommended scopes: ${recommendedMissing.join(", ")}`);
  }
}

const targetValues = TARGET_VARS.map((name) => env[name] || "");
const targetSet = targetValues.filter(Boolean).length;
if (targetSet === 0) {
  record("WARN", "live_create_target", "not configured (optional until a Live Create run is approved)");
} else if (targetSet !== TARGET_VARS.length) {
  record("WARN", "live_create_target", "partially configured; all four X_CHAT_LIVE_* values are required");
} else if (
  !/^\d{1,19}$/.test(targetValues[0]) ||
  !/^\d{1,19}$/.test(targetValues[2]) ||
  targetValues[0] === targetValues[2]
) {
  record("FAIL", "live_create_target", "owner/recipient user ids must be distinct numeric X ids");
} else {
  record("PASS", "live_create_target", "owner and recipient are set with distinct numeric ids");
}

const port = env.PORT || "8787";
if (/^\d+$/.test(port)) {
  record("PASS", "port", "PORT is a numeric port");
} else {
  record("FAIL", "port", "PORT must be numeric");
}

for (const result of results) {
  console.log(`${result.level.padEnd(4)}  ${result.name.padEnd(18)} ${result.detail}`);
}
const failures = results.filter((result) => result.level === "FAIL").length;
const warnings = results.filter((result) => result.level === "WARN").length;
console.log(
  `live-preflight: ${failures ? "FAIL" : "PASS"} (${results.length} checks, ${warnings} warning${warnings === 1 ? "" : "s"}, ${failures} failure${failures === 1 ? "" : "s"})`,
);
process.exit(failures ? 1 : 0);
