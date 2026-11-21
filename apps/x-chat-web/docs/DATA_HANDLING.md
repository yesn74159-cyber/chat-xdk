# Data handling and retention — local prototype

This policy describes the current local-only MVP. It is not a policy for a
hosted, team, or production deployment.

| Data                                                                              | Classification              | Location                                                               | Retention                                                                                                   |
| --------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Private-key blob and unlocked key                                                 | Highly sensitive            | Browser/WASM memory only                                               | Until page close or reload; never sent to the Node adapter                                                  |
| OAuth user token                                                                  | Highly sensitive            | Node process environment only                                          | Until terminal/process exit; never returned to browser code                                                 |
| Juicebox config and realm auth tokens                                             | Highly sensitive            | Authenticated local response and browser memory during unlock          | Config/token map and token references cleared after successful unlock or page close; never logged/persisted |
| Four-digit Chat XDK Passcode                                                      | Highly sensitive            | Browser input and short-lived `Uint8Array` only                        | Input cleared before SDK call; byte buffer zeroed after unlock; never sent to Node                          |
| Plaintext messages and media                                                      | Highly sensitive            | Browser memory and rendered DOM after successful verify/decrypt        | Until page close/reload; no app persistence or server logging                                               |
| Signed ciphertext events, media hashes, conversation IDs, unread and delivery IDs | Sensitive metadata          | Encrypted IndexedDB cache, browser memory, loopback transit, and X API | Encrypted local cache until explicit deletion/export; mock server values end on process exit                |
| Public signing/identity keys and key versions                                     | Sensitive public metadata   | Browser memory and X API responses                                     | No app persistence; refreshed when the current session needs them                                           |
| Operational errors                                                                | Low sensitivity if redacted | Browser status UI and process stderr                                   | No structured log store; adapter exposes status/retryability only                                           |

## Rules

- Responses use `Cache-Control: no-store`. The optional IndexedDB vault holds
  only a versioned encrypted envelope: signed ciphertext, media metadata,
  conversation metadata, unread state, delivery IDs and redacted draft audit
  metadata. It uses AES-GCM with a PBKDF2-derived in-memory key; the
  passphrase, plaintext, raw private-key blob, conversation key, PIN and OAuth
  token are rejected from the persisted document and disappear on page close.
- Export/import transfers that same encrypted envelope only. Import does not
  unlock it. Deleting local data requires an explicit confirmation; local
  deletion cannot remove a copy previously exported by the user.
- Do not add browser analytics, crash reporting, or request logging until a
  separate privacy review proves their redaction behavior.
- The local server obtains `/users/me` itself and derives the user ID used to
  fetch Juicebox configuration and public-key records. It returns only the
  current account, config, realm origins, and public-key records required for
  unlock; the browser clears realm-token references after success. The server
  adds only those exact HTTPS origins to `connect-src` and never uses a scheme
  wildcard.
- The mock server keeps test events and media only in RAM; closing it deletes
  them. Use harmless test content only.
- On suspected token exposure, stop the local server, revoke or rotate the
  token in the X Developer Console, and record only redacted incident details.
- On suspected private-key or conversation-key exposure, stop using that key
  material; the accountable security owner must decide the recovery and key
  rotation procedure before further live sends.

Changing the product to persist plaintext, run as a hosted service, or support
a team requires a new retention, deletion, backup, access-control, and
incident review before implementation.
