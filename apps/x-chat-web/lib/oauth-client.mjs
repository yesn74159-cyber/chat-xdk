import { createHash, randomBytes } from "node:crypto";
import { readXJson, UpstreamError } from "./upstream.mjs";

export const DEFAULT_OAUTH_SCOPES = ["dm.read", "dm.write", "tweet.read", "users.read", "media.write"];
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 30 * 1000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Server-side OAuth 2.0 authorization-code client with PKCE (S256).
 * Tokens are held in memory only and are never returned to the browser.
 * @param {{
 *   clientId?: string,
 *   clientSecret?: string,
 *   authorizeUrl?: string,
 *   tokenUrl?: string,
 *   redirectUri?: string,
 *   scopes?: string[],
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 * }} [options]
 */
export function createOAuthClient({
  clientId = "",
  clientSecret = "",
  authorizeUrl = "https://x.com/i/oauth2/authorize",
  tokenUrl = "https://api.x.com/2/oauth2/token",
  redirectUri = "",
  scopes = DEFAULT_OAUTH_SCOPES,
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  /** @type {Map<string, { verifier: string, expiresAt: number }>} */
  const pending = new Map();
  /** @type {{ accessToken: string, refreshToken: string | null, expiresAt: number, scopes: string[] } | null} */
  let token = null;

  function configured() {
    return Boolean(clientId && redirectUri);
  }

  function hasToken() {
    return Boolean(token?.accessToken);
  }

  function prunePending() {
    for (const [state, entry] of pending) {
      if (entry.expiresAt <= now()) pending.delete(state);
    }
  }

  function status() {
    return {
      configured: configured(),
      authenticated: hasToken(),
      expiresAt: token ? Math.floor(token.expiresAt / 1000) : null,
      hasRefreshToken: Boolean(token?.refreshToken),
      scopes: token ? token.scopes : scopes,
    };
  }

  function authorizationUrl() {
    if (!configured()) throw new UpstreamError("OAuth client is not configured", { status: 503 });
    prunePending();
    const state = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    pending.set(state, { verifier, expiresAt: now() + OAUTH_STATE_TTL_MS });
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.href;
  }

  /** @param {Record<string, string>} params */
  async function postToken(params) {
    /** @type {Record<string, string>} */
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }
    const response = await fetchImpl(new URL(tokenUrl), {
      method: "POST",
      headers,
      redirect: "error",
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new UpstreamError(`OAuth token endpoint returned HTTP ${response.status}`, {
        status: 502,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    let data;
    try {
      data = await readXJson(response);
    } catch {
      throw new UpstreamError("OAuth token endpoint returned an invalid response", { status: 502 });
    }
    return data;
  }

  function storeToken(/** @type {any} */ data) {
    if (!data || typeof data.access_token !== "string" || !data.access_token) {
      throw new UpstreamError("OAuth token endpoint returned an invalid token", { status: 502 });
    }
    const expiresInSeconds = Number(data.expires_in);
    token = {
      accessToken: data.access_token,
      refreshToken:
        typeof data.refresh_token === "string" && data.refresh_token
          ? data.refresh_token
          : (token?.refreshToken ?? null),
      expiresAt: Number.isFinite(expiresInSeconds) ? now() + expiresInSeconds * 1000 : now() + 2 * 60 * 60 * 1000,
      scopes:
        typeof data.scope === "string" && data.scope.trim()
          ? data.scope.trim().split(/\s+/)
          : (token?.scopes ?? scopes),
    };
  }

  /**
   * Validates the callback and exchanges the authorization code for tokens.
   * @param {{ code?: string | null, state?: string | null }} input
   */
  async function completeAuthorization({ code, state }) {
    if (!configured()) throw new UpstreamError("OAuth client is not configured", { status: 503 });
    const entry = state ? pending.get(state) : undefined;
    if (!entry || entry.expiresAt <= now()) {
      if (state) pending.delete(state);
      throw new UpstreamError("OAuth state is missing, expired, or unknown", { status: 400 });
    }
    pending.delete(state);
    if (!code) throw new UpstreamError("OAuth authorization code is missing", { status: 400 });
    storeToken(
      await postToken({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: entry.verifier,
        client_id: clientId,
      }),
    );
    return status();
  }

  /** Returns a usable access token, refreshing it shortly before expiry. */
  async function accessToken() {
    if (!token) return null;
    if (token.refreshToken && token.expiresAt - REFRESH_SKEW_MS <= now()) {
      try {
        storeToken(
          await postToken({
            grant_type: "refresh_token",
            refresh_token: token.refreshToken,
            client_id: clientId,
          }),
        );
      } catch (error) {
        if (error instanceof UpstreamError && error.message === "OAuth token endpoint returned HTTP 400") {
          token = null;
          throw new UpstreamError("OAuth sign-in expired; sign in again", { status: 503 });
        }
        throw error;
      }
    }
    return token.accessToken;
  }

  return {
    configured,
    hasToken,
    status,
    authorizationUrl,
    completeAuthorization,
    accessToken,
    /** Applies the bound loopback callback URL when the operator did not set one. */
    withDefaultRedirect(/** @type {string} */ uri) {
      if (!redirectUri) redirectUri = uri;
    },
  };
}
