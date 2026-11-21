# Threat model — X Chat Local Inbox

## Scope

This document covers the local, single-account web prototype in this directory.
It runs a loopback-only Node server and browser UI on the same device. The
browser uses the Chat XDK WASM binding for key handling and cryptography; the
server relays ciphertext and X API metadata. It is not a hosted service or a
team product.

The model does not change the X Chat protocol's documented limitations. In
particular, the protocol does not provide forward secrecy or post-compromise
security. A future deployment needs a new review rather than inheriting this
document unchanged.

## Assets and trust boundaries

| Asset                                     | Expected location                                          | Must not cross                                 | Primary protection                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private-key blob and unlocked private key | Browser memory                                             | Node server, logs, commits, persistent storage | The UI imports directly into WASM and clears the text input; server routes never accept it                                                                              |
| New conversation key                      | Browser memory after Mock acknowledgement                  | Node server, logs, cache, persistent storage   | SDK prepares it after explicit confirmation; only encrypted participant wraps/signatures reach the Mock adapter; failure/cancellation/account switch clears the raw key |
| X user token                              | Local server process environment                           | Browser, repository, logs                      | Read only from `X_ACCESS_TOKEN`; loopback server attaches it to live X requests                                                                                         |
| Juicebox realm tokens and four-digit PIN  | Browser memory during explicit unlock                      | Node server, logs, persistent storage          | Server derives the account and returns its Juicebox config; input clears immediately and PIN bytes are zeroed                                                           |
| Plaintext text and media                  | Browser memory/UI                                          | Server, logs, persistent storage               | Encrypt/decrypt in WASM; UI renders verified plaintext only                                                                                                             |
| Ciphertext, signatures and media hash     | Browser ↔ encrypted IndexedDB ↔ loopback server ↔ X API | —                                              | Treated as untrusted on receipt; signatures are verified in the SDK before display                                                                                      |
| Conversation and signing public keys      | X API response / browser memory                            | —                                              | Map into SDK signing-key entries and verify events before use                                                                                                           |
| Local app routes                          | `127.0.0.1` only                                           | LAN/public network                             | Loopback bind, loopback-only `Host` allowlist, local POST header/origin check, CSP and no-store responses                                                               |

## Threats and current controls

| Threat                                              | Control in this prototype                                                                                                                                                                                    | Residual risk / release requirement                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Network attacker modifies/replays X event data      | `decryptEvents`/`decryptEvent` verifies signatures; unverified events are not rendered; Mock delivery IDs dedup reconnect simulation                                                                         | Live delivery/replay integration is not implemented yet                                                           |
| Stale or downgraded conversation key                | SDK holds the monotonic key-version floor                                                                                                                                                                    | History pagination and real-time reconciliation must preserve KeyChange ordering                                  |
| Server or logs capture private keys/plaintext       | Private-key import and crypto remain in browser WASM; server receives encrypted message fields only                                                                                                          | A malicious browser extension, compromised device or developer tools can still read browser memory/UI             |
| Token leaks to browser, redirects or source control | Token is read only by server environment, never returned by `/api/status`, and upstream fetch rejects redirects                                                                                              | Replace ad-hoc shell token with OAuth/token lifecycle controls before live release                                |
| Unrelated website posts to local server             | Server binds loopback, rejects non-loopback `Host` values, and requires JSON plus `x-chat-local: 1`; cross-origin `Origin` is rejected                                                                       | Another process on the same device can make loopback requests; local-only is not a trust boundary against malware |
| Browser XSS or unsafe link rendering                | Text is inserted with DOM text nodes, links use `noopener noreferrer`, and CSP restricts scripts to self and connections to exact HTTPS Juicebox realm origins; `wasm-unsafe-eval` loads bundled crypto WASM | Addressed in `SECURITY_REVIEW.md` (2026-11-21); re-review after any HTML sink is introduced                       |
| Oversized or malformed local request                | Server caps JSON body at 5 MiB, cache import is capped at 20 MiB, and identifiers/numbers are validated                                                                                                      | Rate limits remain to be added before any non-loopback deployment                                                 |
| Malicious media or wrong media key                  | Media remains ciphertext until SDK decrypt succeeds; decrypted MIME is detected locally                                                                                                                      | Decode/render safety and large-file streaming need platform-specific review                                       |
| Duplicate/ambiguous send                            | UI retains the same encrypted payload and `message_id` for an in-session retry; Mock reconnect dedups delivery IDs                                                                                           | Durable idempotency/reconciliation is not implemented across reloads                                              |
| Wrong group membership or untrusted member key      | Manual IDs only; browser includes the owner, verifies every identity-to-signing-key binding, reads Mock roster and key version before membership mutation                                                    | Live roster/membership operations are not implemented                                                             |
| Local ciphertext cache is copied or tampered with   | AES-GCM authenticated encryption, PBKDF2-derived in-memory key, no plaintext/key/token/passphrase fields, explicit export/import/delete                                                                      | A weak/reused passphrase or compromised local browser/device can expose cache metadata after unlock               |
| Mock identity confused with a real account          | Mock-only control generates ephemeral browser keys and registers only public data with the in-memory adapter                                                                                                 | Restart in live mode and complete OAuth/key onboarding for any real account                                       |
| Token/key loss or suspected compromise              | No automatic recovery makes silent persistence less likely                                                                                                                                                   | Incident runbook, revocation and secure backup are required before live release                                   |

## Explicit non-goals and assumptions

- The prototype is used only by the local account owner on a trusted device.
- It does not protect against malware, a malicious extension, an unlocked
  browser session, or another privileged local user.
- It does not store plaintext, raw private keys, OAuth tokens, passphrases or
  conversation keys persistently. An active conversation key exists only in
  browser memory for encryption/decryption and is never placed in the cache or
  sent to the local server. It optionally stores encrypted ciphertext/metadata
  only.
- The browser temporarily holds the Juicebox config/token map only to satisfy
  Chat XDK's browser-side Juicebox callback. It clears the map after success;
  the callback then has no token values to return.
- It does not make a failed signature, missing key, or failed media decrypt
  look successful.
- It does not send messages to arbitrary recipients, implement broadcast delivery, or implement automation.

## Security gates before live traffic

- Verify X OAuth scopes and store/refresh/revoke tokens without exposing them
  to browser code or logs.
- X API response bodies and request timeouts are bounded in the local adapter;
  retain tests and review these limits if the supported media limit changes.
- Complete test coverage for pagination, duplicate/out-of-order events,
  signature failures, missing signing keys, key rotations and media failures.
- Keep direct conversation-key initialization Mock-only until a separate live
  approval, endpoint integration review and two-party test are completed.
- Add a secret scan, dependency review, accessibility review and a release
  security review. (Secret scan, dependency audit, browser/accessibility smoke
  and the 2026-11-21 release security review are complete for the Mock slice —
  see `SECURITY_REVIEW.md`.)
- Define incident, deletion, backup and recovery runbooks; test them with
  redacted evidence.
- Obtain explicit approval and two consented test identities before `LIVE_PASS`.
