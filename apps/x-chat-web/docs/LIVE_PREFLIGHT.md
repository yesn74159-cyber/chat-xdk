# Live preflight — X Chat Local Inbox

Run this checklist only after the mock/offline gates pass. It prepares a
consented A/B test and does not authorize sending a live message by itself.

## Single-use Live Create permit

The one approved Live Create target is supplied by the operator, never by
source: the server reads `X_CHAT_LIVE_OWNER_USER_ID`,
`X_CHAT_LIVE_OWNER_USERNAME`, `X_CHAT_LIVE_RECIPIENT_USER_ID`, and
`X_CHAT_LIVE_RECIPIENT_USERNAME` from its own process environment and derives
the canonical conversation ID by numeric sort. If any value is missing or
malformed, `/api/status` reports `liveCreateTargetConfigured: false` and every
Live Create request returns HTTP 501.

Even with a configured target, the server is disabled unless the operator
creates a local permit file. The file expires within ten minutes, and the
server atomically records its use before the upstream POST.

**Keep Live Create disabled.** This change fixes local canonical-ID handling
only; fresh authorization for this corrected exact owner, recipient, username,
and conversation ID is required before any future permit activation. Do not
reuse prior authorization or create/activate a permit as part of this fix. The
SDK-generated request body and signatures must be forwarded unchanged.

Only after separate fresh authorization has been granted for the corrected
exact target, an operator may create a five-minute permit from the same Windows
user account that runs the server:

```powershell
$permitDir = Join-Path $env:LOCALAPPDATA 'X Chat'
New-Item -ItemType Directory -Force $permitDir | Out-Null
$expiresAt = [DateTime]::UtcNow.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
$permit = @{ expiresAt = $expiresAt } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $permitDir 'live-create-permit.json'), $permit)
```

Confirm `/api/status` reports `liveCreateOneShotAvailable: true`, then run the
fresh Live GET preflight and verify the owner, recipient, encrypted permission,
available lookup, and zero existing rooms. In the UI, confirm recipient
consent and the separate final approval, then submit only the exact target
above once. Do not retry if the outcome is uncertain.

Before the upstream POST, the server creates
`%LOCALAPPDATA%\X Chat\live-create-consumed` using an exclusive atomic create
and flushes it to disk. That durable marker disables the permit immediately and
survives server restarts; `/api/status` then reports
`liveCreateOneShotAvailable: false`. Expiration also disables an unused
permit. A timeout, HTTP 429, or other uncertain result remains reconciliation
only, and the marker must not be deleted to retry this approval. The permit
file contains only its expiry time; it must never contain tokens, PINs, keys,
or message content.

## 1. X Developer app and identities

- Confirm the X Developer app is approved for X Chat and uses OAuth 2.0
  user-context authorization.
- Confirm the exact enabled scopes include `dm.read`, `dm.write`, `tweet.read`,
  and `users.read`; include `media.write` for image tests.
- Identify two test accounts, **A** and **B**, whose owners explicitly consent
  to receiving the planned test messages and images.
- Record aliases only in test evidence. Do not put access tokens, account
  handles, private-key blobs, PINs or plaintext messages in source control,
  issue trackers or chat.

## 2. Local setup

See [`LIVE_PASS_RUNBOOK.md`](LIVE_PASS_RUNBOOK.md) for the owner tasks, the
OAuth sign-in flow, the redacted evidence template, and cleanup.

- Use Node.js 20 or newer and run `npm ci`, `npm run check`, and `npm test`.
- Run `npm run preflight:live`; it prints only check names and statuses, never
  credential values.
- Prefer server-side OAuth: set `X_OAUTH_CLIENT_ID` /
  `X_OAUTH_CLIENT_SECRET`, start the server, open
  `http://127.0.0.1:8787/api/auth/login`, and confirm
  `/api/auth/status` reports `authenticated: true`. The access and refresh
  tokens stay in server memory and are never returned to browser JavaScript.
- Alternatively set `X_ACCESS_TOKEN` only in the local process environment
  (the static token takes precedence when both are set). Never commit it, put
  it in `.env`, or paste it into a terminal transcript.
- Start `npm start`, open `http://127.0.0.1:8787`, and confirm `/api/status`
  shows `tokenConfigured: true`. This confirms only local configuration, not
  token validity or scopes.
- Select **ตรวจสอบบัญชี X** and verify the displayed account is the intended
  account. The server derives the user ID from authenticated `/2/users/me`;
  it does not trust a browser-supplied ID. If the verified Juicebox realm
  origins change, the app reloads once to apply exact HTTPS origins to CSP;
  select the button again before entering the PIN.
- Enter the existing four-digit Chat XDK Passcode manually. The browser calls
  Juicebox `unlock()` once per click, clears the input, and verifies the
  recovered identity and signing key against exactly one public-key record.
  The app never calls `setup()`, registers a public key, or rotates keys.
- The private-key blob remains available under the fallback disclosure. Its
  registered signing-key version is still checked against the account's
  public-key records before setting session identity.
- Use a known existing 1:1 conversation. Confirm the self public-key record
  contains the signing-key version before setting the session identity.
- For a group test, obtain explicit consent from every member, list only their
  numeric X user IDs, verify every public-key binding, and use a non-production
  group. Creating a group is an external write; the app will ask for a final
  confirmation before it makes that request.

## 3. Go/no-go before each live case

- Verify the intended recipient and canonical conversation ID; do not use a
  production recipient as an exploratory target.
- Confirm the history response supplies the expected KeyChange material and
  participant signing keys. Do not bypass signature failure or a missing key.
- Keep the browser console and server logs free of plaintext, private keys,
  PINs, OAuth/realm tokens and full key blobs. The Juicebox realm token map is
  held in browser memory only during preparation/unlock and cleared after
  success; it is never persisted or logged.
- Stop immediately on unexpected recipient, key version, signature result, API
  scope error, or ambiguous send result. Reconcile history before any resend.

## 4. Acceptance sequence

1. A sends a short text message to B; B loads it, verifies it and decrypts it.
2. A sends a harmless HTTPS URL; B verifies/decrypts it and confirms the X
   client handles the link as expected.
3. A sends one small PNG; B verifies the message, downloads ciphertext, and
   decrypts bytes equal to the original with that event's key version.
4. Repeat the media case with JPEG and multiple upload parts if the enabled X
   limits permit it.
5. Exercise a controlled retry only after an explicitly ambiguous response;
   reuse the identical encrypted payload and signed message ID.
6. After the one-to-one checks pass, create one consented group, verify the
   returned group ID and key-change history, then send one harmless text and
   one small image. Treat member changes as a separate future acceptance case.

## 5. Redacted evidence

For each case, retain only: date/time, test-account aliases, redacted
conversation/event IDs, signed message ID, key version, media byte comparison
result, X HTTP outcome, verification outcome, and cleanup outcome. Delete test
media and revoke/expire the test token according to the agreed retention
policy. A successful HTTP response alone is not `LIVE_PASS`.

The local history inspector reports only signature/version presence, sender
and signing-key-version matches, event type, KeyChange presence, and parser
status. It parses bounded Thrift metadata but does not verify signatures;
`signing_key_resolution_ambiguous` means the SDK error alone cannot distinguish
a missing signature from an unavailable matching signing key.

Unsigned historical messages are shown as redacted placeholders and are not
retried in later refreshes of the same conversation. Invalid signatures,
missing keys, and other unverified events receive distinct placeholder
statuses. No plaintext is rendered unless the SDK returns a verified message.
Before a new-message live test, confirm that the selected test conversation
already has a decryptable conversation key; this static preflight does not
make Live API requests or send a message.

## PIN unlock readiness

- Static readiness does not mean the real account has been unlocked. This
  implementation stops before accepting the owner's PIN unless they click the
  unlock control themselves.
- Do not repeat PIN attempts automatically. Stop on a key mismatch, ambiguous
  matching records, an unexpected key version, or Juicebox error.
- `PIN_UNLOCK_PASS` requires the owner to unlock the real account and evidence
  that the recovered identity matches exactly one verified public-key record.
