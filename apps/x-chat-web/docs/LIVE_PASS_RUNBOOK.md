# LIVE_PASS runbook — local inbox

This runbook prepares a consented A/B `LIVE_PASS` for the local app. The code
side is testable without credentials (Mock and fake-IdP tests); the steps marked
**owner** below need the X Developer app and the two test accounts, so only their
owners can complete them. Running this runbook does not authorize sending a
message by itself — each live case still follows
[`LIVE_PREFLIGHT.md`](LIVE_PREFLIGHT.md).

## Part A — owner tasks (cannot be done from this repository)

1. **X Developer app**: create or confirm the app, enable OAuth 2.0
   user-context authorization, and record the Client ID (and Client Secret if
   the app is a confidential client).
2. **Redirect URI**: register exactly
   `http://127.0.0.1:8787/api/auth/callback` (or your chosen `PORT`). The
   callback is loopback only; do not register a public host.
3. **Scopes**: confirm the app is approved for `dm.read`, `dm.write`,
   `tweet.read`, `users.read`, plus `media.write` for image cases and
   `offline.access` if token refresh is wanted.
4. **Test accounts A and B**: two accounts whose owners consent to the planned
   messages/images, able to receive DMs from each other, with the numeric user
   IDs recorded separately from this repository.
5. **Environment**: export values only into the local process environment. In
   PowerShell, avoid leaving the token in the transcript:

   ```powershell
   $secure = Read-Host -AsSecureString
   $env:X_ACCESS_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
     [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
   Remove-Variable secure
   ```

   Never use `.env`, `setx`, source files, issue trackers, or chat for tokens,
   PINs, private keys, or key blobs.

## Part B — server-side OAuth sign-in (recommended)

Static `X_ACCESS_TOKEN` still works, but the OAuth flow keeps the token in the
server process and never sends it to browser JavaScript.

| Variable                                     | Purpose                                       | Default                                                                    |
| -------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| `X_OAUTH_CLIENT_ID`                          | OAuth 2.0 client id                           | unset (OAuth disabled)                                                     |
| `X_OAUTH_CLIENT_SECRET`                      | Client secret for confidential clients        | unset (public client with PKCE)                                            |
| `X_OAUTH_REDIRECT_URI`                       | Callback URL                                  | `http://127.0.0.1:<PORT>/api/auth/callback`                                |
| `X_OAUTH_SCOPES`                             | Space-separated scopes                        | `dm.read dm.write tweet.read users.read`                                   |
| `X_OAUTH_AUTHORIZE_URL`, `X_OAUTH_TOKEN_URL` | Provider endpoints (tests/rehearsal only)     | X defaults                                                                 |
| `X_APP_BEARER_TOKEN`                         | App-only Bearer Token for the activity stream | unset (real-time disabled; X forbids OAuth 2.0 user context on the stream) |
| `X_API_BASE_URL`                             | X API base URL (tests only)                   | `https://api.x.com`                                                        |

1. Start the server with the OAuth variables set: `npm start`.
2. Open `http://127.0.0.1:8787/api/auth/login` in the browser and sign in as
   account **A**. The server stores the authorization request (state + PKCE
   verifier) for ten minutes and sends only the S256 challenge to X.
3. After consent, X redirects to the loopback callback. The server exchanges
   the code, holds the access/refresh token in memory, and shows a short
   confirmation page. Tokens never appear in the page, `/api/status`,
   `/api/auth/status`, logs, or any file.
4. Check the result:

   ```powershell
   Invoke-RestMethod http://127.0.0.1:8787/api/auth/status
   ```

   `authenticated: true` with an `expiresAt` timestamp means the server has a
   usable token. The response contains no token values.

5. If `offline.access` was granted, the server refreshes shortly before expiry.
   A `400` from the token endpoint means the sign-in expired or was revoked —
   open `/api/auth/login` again.

The token lives only in server memory: restarting the server requires a new
sign-in. Mock mode returns `404` for the login and callback routes.

Static-token alternative: `npm run start:live` builds the app and, when no
credential is configured, asks for the access token with terminal echo
disabled. The value goes straight into the server process environment; it is
not written to disk, logs, or shell history. Pressing Enter without a token
exits with a message instead of starting an unauthenticated server.

## Part C — readiness check

```powershell
npm run preflight:live
```

The command reads the current process environment and prints one line per
check (`PASS`/`WARN`/`FAIL`) without printing any value. It fails when:

- neither `X_ACCESS_TOKEN` nor `X_OAUTH_CLIENT_ID` is set (in live mode),
- `X_OAUTH_REDIRECT_URI` is not a loopback HTTP URL,
- required scopes are missing, or
- owner/recipient IDs are malformed or equal.

Warnings cover mock mode, missing recommended scopes (`media.write`,
`offline.access`), an incomplete optional Live Create target, and both
credential sources being set (the static token takes precedence).

## Part D — acceptance sequence

Run the cases in [`LIVE_PREFLIGHT.md`](LIVE_PREFLIGHT.md) section 4 in order:
text, URL, PNG, JPEG/multi-part, controlled retry, then the consented group.
Stop on an unexpected recipient, key version, signature result, scope error, or
ambiguous send; reconcile history before any resend.

## Part E — redacted evidence template

Keep one row per case; never record tokens, PINs, keys, handles, or plaintext.

| Field           | Example                                        |
| --------------- | ---------------------------------------------- |
| Date/time (UTC) | 2026-11-21T12:34Z                              |
| Case            | text / url / png / jpeg / retry / group        |
| Accounts        | A-alias → B-alias                              |
| Conversation ID | `…1234-…5678` (last 4 digits only)             |
| Signed message  | `msg_…` (last 4 characters only)               |
| Key version     | e.g. 3                                         |
| X HTTP outcome  | 200 / 429 / timeout (no response body)         |
| Verify outcome  | verified / signature invalid / key missing     |
| Media bytes     | equal / not equal / n-a                        |
| Cleanup         | token revoked, media deleted, marker unchanged |

A successful HTTP response alone is not `LIVE_PASS`. Record the verification
and decryption outcome for every case.

## Part F — cleanup

- Stop the server (the OAuth token is discarded with the process) and clear the
  exported environment variables from the session.
- Revoke the app's access in the X account settings if the app is not reused.
- Delete downloaded test media according to the agreed retention policy.
- Never delete `live-create-consumed` to retry a Live Create; a consumed permit
  stays consumed.
