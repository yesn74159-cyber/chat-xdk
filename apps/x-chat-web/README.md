# X Chat Local Inbox (first implementation slice)

Local, single-account web client for encrypted X Chat messages, basic URL text, and one PNG/JPEG image per message. It is an application **outside** the `chat-xdk` SDK crates. Browser WASM does key and content cryptography; the loopback-only Node server holds the X user token and relays ciphertext/API metadata. It does not hold the private key.

## Start

1. Use Node.js 20 or newer, then run `npm ci` in this directory. The locked
   `@xdevplatform/chat-xdk` 0.7.1 and `juicebox-sdk` 0.3.7 packages include
   their compiled WASM bindings; `npm start` builds the local browser bundle.
2. For live work only, set `X_ACCESS_TOKEN` in your local shell environment to a user-context token.
   The documented baseline is `dm.read`, `dm.write`, `tweet.read`, and
   `users.read`; image upload additionally needs `media.write`. Confirm the
   exact scopes against the operations enabled for the X Developer app. Do not
   place a token in a file or paste it into chat.
3. Run `npm start` and open `http://127.0.0.1:8787` on the same computer. The server binds only to `127.0.0.1`.
   Live Create stays disabled until the operator sets
   `X_CHAT_LIVE_OWNER_USER_ID`, `X_CHAT_LIVE_OWNER_USERNAME`,
   `X_CHAT_LIVE_RECIPIENT_USER_ID`, and `X_CHAT_LIVE_RECIPIENT_USERNAME` in
   the server environment and creates a short-lived permit as described in
   [docs/LIVE_PREFLIGHT.md](docs/LIVE_PREFLIGHT.md). `/api/status` reports only
   `liveCreateTargetConfigured` and `liveCreateOneShotAvailable`, never the IDs.
4. For PIN unlock, select **ตรวจสอบบัญชี X**. If the confirmed Juicebox realm origins change, the page reloads once to apply their exact HTTPS origins to CSP; select the button again, confirm the displayed account, then enter the existing four-digit Passcode. The PIN and realm tokens stay in browser memory only. The app verifies the recovered identity/signing key against exactly one public-key record before enabling conversations. It never calls `setup`, registers a public key, or rotates a key.
5. To retain the existing fallback, expand **ใช้ Private key blob แทน**, enter the exported blob and its registered signing-key version. The blob stays in browser memory and the input is cleared after import.
6. Open an existing one-to-one conversation using its canonical `A:B` conversation ID and a valid KeyChange history. A recipient's user ID alone is not sufficient for the one-to-one flow; use the group creator below when creating a new group.

To create a group, load the private key blob first, enter a group name and the
consented member X user IDs (comma or newline separated). The app includes the
current user, loads and verifies every member's registered key binding, mints a
group ID, has the browser call `prepareGroupCreate`, and sends only the public
key wraps plus the two signed actions to the local adapter. The raw group key
stays in browser memory. In live mode the browser asks for an explicit final
confirmation before any X group-create request. This has `MOCK_API_PASS`, not
live-group proof. 6. Send text/URL, or choose one PNG/JPEG image. The image is encrypted in the browser before it is uploaded; only then is the encrypted message sent.

Run `npm run check` for formatting, JavaScript syntax, TypeScript `checkJs`, and related static checks. `/api/status` reports only whether the token and SDK installation are present, not their values.
Run `npm run test:mock` for the loopback adapter gate, or `npm test` for both
the offline crypto and mock adapter tests.

For adapter testing without X credentials or network calls, run with
`X_CHAT_API_MODE=mock npm start`. Mock mode keeps all state in memory, accepts
the same local routes, and returns mock-mode sends through its in-memory
history endpoint. It is not evidence of a live X send or receive.

In Mock mode, **สร้างตัวตน Mock ชั่วคราว** generates an ephemeral local test
identity and two peer identities in the browser, registers only their public keys
with the in-memory adapter, and pre-fills the peer ID for the group form. It
does not use an X token or real account, and the mock identities disappear when
the page or server is restarted.

## Boundaries

- A bare URL is part of encrypted message text. Rich URL-card previews, including encrypted banner/favicon images, are a later slice.
- This is a local development client, not a hosted or team system. OAuth remains configured in the local server process; there is no hosted multi-user backend, broadcast delivery, or auto-send.
- The optional Local ciphertext cache is AES-GCM encrypted in IndexedDB using a passphrase-derived in-memory key. It stores signed ciphertext and metadata only; it never persists plaintext, a raw private key/blob, PIN, passphrase, conversation key or OAuth token. Export/import is ciphertext-only and delete requires confirmation. When a history refresh fails, the page decrypts cached events for the open conversation and renders only SDK-verified messages; after a restart this fallback is empty until signing keys are loaded again, because public signing keys are not persisted.
- Message composition is draft-first: create a local draft, inspect its recipient/content/file, then explicitly approve it. There is no background delivery, automation, or broadcast. Only the encrypted/no-plaintext audit metadata is retained in the encrypted cache.
- Mock group member add/remove checks the roster and key version before it asks XDK to rotate the group key. Rotation only protects messages sent after the roster change; it does not retroactively protect earlier history. Live group roster, member add/remove, and read-state routes are not implemented: they return HTTP 501, so member management remains a Mock-only capability for now.
- Media upload initializes with the encrypted byte count; the signed attachment
  records the original plaintext file size.
- Refresh loads the first page of events and accompanying KeyChange events;
  **โหลดประวัติเพิ่ม** follows the API's `next_token` cursor. Real-time delivery
  is still a next step.
- If a send response is ambiguous, the retry button resends the same encrypted payload and `message_id` during the current page session. A reload clears that in-memory retry state; check the conversation before sending a new message.
- A successful local HTTP response, page load or offline crypto round trip is **not** a live X send/receive result.
- Do not expose this server beyond loopback, persist raw keys, or commit access tokens.
- Juicebox realm auth tokens are read from the authenticated account config into browser memory only for unlock; the map is cleared after success and is never logged or persisted. An unsupported or malformed realm config or non-HTTPS realm stops unlock.

See [the project plan](../../docs/X_CHAT_APP_PLAN.md) for phases and live acceptance criteria.
See the [local prototype threat model](docs/THREAT_MODEL.md) before enabling live traffic.
See the [API contract audit](docs/API_CONTRACT_AUDIT.md) for the endpoint and payload
shapes checked against the current X documentation.
See [developer onboarding](docs/DEVELOPER_ONBOARDING.md) and the current
[data-handling policy](docs/DATA_HANDLING.md) before changing or sharing the app.
Use the [incident-response runbook](docs/INCIDENT_RESPONSE.md) if token, key,
signature, or recipient safety is in doubt.
Use the [live preflight checklist](docs/LIVE_PREFLIGHT.md) when the test
identities and X Developer app are ready.
