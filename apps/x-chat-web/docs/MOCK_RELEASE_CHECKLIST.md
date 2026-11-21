# Mock release checklist

This checklist is evidence for the local Mock-first slice only. It never
substitutes for a live X API result.

## Required local gates

- [x] `npm run check`: formatting, syntax and JS type checking.
- [x] `npm test`: real WASM offline crypto/media checks and loopback Mock tests.
- [x] Credential marker scan and production dependency audit in CI.
- [x] CycloneDX SBOM artifact generated in CI.
- [x] Mock text, URL and PNG/JPEG ciphertext round trips.
- [x] Mock group creation, three-member roster change, key rotation and stale-roster rejection.
- [x] Mock pagination, duplicate/out-of-order delivery simulation, offline/reconnect and unread read-state.
- [x] Encrypted IndexedDB envelope rejects plaintext/private-key/token/passphrase/PIN fields.
- [x] Draft is manually approved; no auto-send, background delivery or broadcast route exists.

## Deliberately not yet release proof

- [ ] Browser E2E on a real installed browser for keyboard/focus/responsive layout.
- [ ] Live OAuth, scopes/credits, consented X test accounts and text/URL/image/group results.
- [ ] Live real-time delivery/reconnect and live roster admin/title operations.
- [ ] Hosted/team backend, multi-account permissions, durable secure key backup or auto-send.

`LIVE_PASS` remains **NOT_VERIFIED** until the separate live preflight and
redacted two-account evidence are complete.
