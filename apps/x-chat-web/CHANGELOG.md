# Changelog — x-chat-web

Versions follow SemVer for the app. While the app is pre-live (0.x), a minor
version may change local behaviour and the encrypted cache format; the cache
reader still rejects versions it does not know instead of guessing. The X Chat
protocol limitations (no forward secrecy) are not app-version issues and are
documented in `docs/THREAT_MODEL.md`.

## [0.1.0] — 2026-11-21

Local, single-account Mock-first prototype. It is not a hosted product and
`LIVE_PASS` remains unverified.

### Added

- Loopback-only Node adapter with browser-side Chat XDK WASM crypto; the
  server never receives private keys, plaintext or the token.
- Send/receive text, URLs and one PNG/JPEG image with signature verification
  and fail-closed rendering.
- Mock direct chats, groups (create + add/remove with key rotation), unread
  state, pagination, offline/duplicate/reverse delivery simulation.
- Optional encrypted IndexedDB cache (PBKDF2 + AES-GCM) with export, import,
  restore and explicit delete.
- Conversation list with unread filter and search; restart/offline shell and
  missing-page handling.
- `/api/health` and `/api/metrics` (counts, status buckets, server errors,
  RSS/heap) with no paths, accounts or message data.
- Quality gates: offline + Mock tests, installed-browser smoke on Chrome/Edge
  at desktop and 375px, loopback soak probe, credential scan, dependency
  audit, CycloneDX SBOM in CI.

### Security

- Loopback `Host` allowlist (DNS-rebinding guard) and a 20 MiB cache-import
  cap. Release security review recorded in `docs/SECURITY_REVIEW.md` with no
  open Mock-slice blockers.
- Threat model, data handling, incident response and operations runbook
  documented.

### Known limitations

- No live real-time delivery/reconnect, live roster admin, durable send
  idempotency across reloads, rate limiting, alerting or incident tooling.
- X Chat gives no forward secrecy or post-compromise security; members who
  held an old conversation key can still read old messages.
- Firefox and Safari are unverified; keyboard-only traversal and 200% zoom are
  manual checks.
- Local-only threat boundary: another process or malicious extension on the
  same device is out of scope.

### Compatibility

- Node.js 20+; the supported browser is the current desktop Chrome or Edge.
- Cache envelope version 1 (`x-chat-local-cache-v1`); unknown versions are
  rejected on read. Export before upgrading or rolling back.
