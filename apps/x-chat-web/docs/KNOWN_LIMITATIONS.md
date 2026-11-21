# Known limitations — local Mock slice

Single source of truth for what this prototype does **not** do. It applies to
the local, single-account app in `apps/x-chat-web` as of 2026-11-21; a hosted,
team or live deployment needs a new review rather than inheriting this list.

## Protocol and cryptography

- X Chat provides no forward secrecy or post-compromise security. Anyone who
  held an old conversation key can still read messages encrypted under it,
  including a member removed after a rotation. The UI states this next to the
  member-change form.
- Key rotation protects only messages sent after the rotation. There is no
  retroactive protection and no guarantee the old key was deleted elsewhere.
- Signature/key-version failures fail closed: the event is not rendered and
  there is no "show anyway" path. There is also no recovery flow if a signing
  key was permanently removed from the public-key endpoint; the UI reports the
  missing key instead of guessing.
- The app does not implement history pagination to exhaustion in live mode or
  webhooks. Real-time `chat.received`/`chat.sent` delivery runs over the X
  activity stream with bounded reconnect backoff, but X refuses
  `backfill_minutes` for this developer app, so a gap while disconnected is only
  covered by the history refresh the page runs when the stream reconnects;
  monotonic key-version reconciliation across live delivery is still open.

## Product scope

- Local, single-account only; no hosted service, team workspace, roles,
  cross-device sync, broadcast or automation/auto-send.
- No live real-time delivery or roster admin. Group create and member change
  have Mock coverage only; live group/member operations are not implemented.
- Send retry reuses the same signed payload and `message_id` in-session, but
  durable idempotency across reloads is not implemented.
- Plaintext is never persisted. Only an optional encrypted IndexedDB cache of
  ciphertext/metadata exists; there is no plaintext cache opt-in.
- Unread state, read marking and the delivery queue are Mock-only behaviours.

## Operations and security

- Loopback only. There is no rate limiter, alerting, structured log store,
  on-call rotation, signed release artifact or publish channel. Another process
  or malicious extension on the same device is outside the threat boundary.
- Mock state lives in RAM and disappears on restart; there is no mock backup.
  Browser cache backup is export-only; an exported envelope is outside app
  control and a weak/reused passphrase weakens its protection.
- Live use still needs X OAuth scopes/credits, consented test accounts and the
  redacted two-account evidence. `LIVE_PASS` is **NOT_VERIFIED**.
- Server-side OAuth (PKCE, refresh) is implemented and fake-IdP tested, but the
  token stays in server memory only: a restart requires signing in again, and
  there is no sign-out/revoke endpoint. Real-app authorization and token
  lifetime behaviour remain part of `LIVE_PASS` (`NOT_VERIFIED`).

## Client support and accessibility

- Verified: current desktop Chrome/Edge, 1280×900 and 375×812, automated
  browser smoke plus contrast pairs. Firefox and Safari are unverified.
- Keyboard-only traversal, focus return from dialogs, 200% zoom and screen
  reader behaviour are manual checks; see `ACCESSIBILITY_AUDIT.md`.

## Verification status

Mock gates, the 2026-11-21 security review, soak probe and browser matrix are
recorded in `MOCK_RELEASE_CHECKLIST.md` and `SECURITY_REVIEW.md`. Nothing here
substitutes for live X API evidence or a production incident/support process.
