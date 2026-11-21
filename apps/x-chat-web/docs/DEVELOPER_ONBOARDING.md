# Developer onboarding

## Prerequisites

- Node.js 20 or newer.
- Run `npm ci`, `npm run scan:secrets`, `npm run check`, and `npm test` from
  `apps/x-chat-web` before changing the adapter or UI.
- Do not copy a real token, private-key blob, PIN, ciphertext, or plaintext
  into source files, Git history, fixtures, issue trackers, or chat.

## Mock workflow

Run the adapter without credentials or external traffic:

```powershell
$env:X_CHAT_API_MODE = "mock"
npm start
```

The mock server has only in-memory test data. It does not prove a live send,
receive, authorization scope, or X API contract beyond the tested adapter
shape.

## Live workflow

Only use a consented test conversation after completing
[`LIVE_PREFLIGHT.md`](LIVE_PREFLIGHT.md). In the same PowerShell window that
will start the server, provide the user token interactively:

```powershell
$env:X_ACCESS_TOKEN = Read-Host "X access token"
npm start
```

This intentionally leaves the token only in that process environment. Do not
create a `.env` file, use `setx`, or add the token to a command line. Close the
terminal to remove the environment value. `/api/status` reports only whether a
token exists, not the token or its validity.

The single-use Live Create target is also environment-only. Set all four of
`X_CHAT_LIVE_OWNER_USER_ID`, `X_CHAT_LIVE_OWNER_USERNAME`,
`X_CHAT_LIVE_RECIPIENT_USER_ID`, and `X_CHAT_LIVE_RECIPIENT_USERNAME` in the
same server process; any missing or malformed value keeps Live Create closed.
Account identifiers must never be committed to source or fixtures.

## Before a change is shared

1. Run the local quality gates above.
2. Check `git diff --check` and review every changed file for secrets.
3. Confirm no generated private-key material has entered `test/` or `docs/`.
4. Do not claim `LIVE_PASS` until the two-account acceptance checklist has
   redacted evidence.
