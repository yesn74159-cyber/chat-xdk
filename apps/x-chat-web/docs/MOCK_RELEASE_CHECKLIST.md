# Mock release checklist

This checklist is evidence for the local Mock-first slice only. It never
substitutes for a live X API result.

## Required local gates

- [x] `npm run check`: formatting, syntax and JS type checking.
- [x] `npm test`: real WASM offline crypto/media checks and loopback Mock tests.
- [x] `npm run test:browser`: installed-browser smoke (skips cleanly when no
      Chrome/Edge is present; set `X_CHAT_BROWSER_PATH` to choose one).
- [x] Credential marker scan and production dependency audit in CI.
- [x] CycloneDX SBOM artifact generated in CI.
- [x] Mock text, URL and PNG/JPEG ciphertext round trips.
- [x] Mock group creation, three-member roster change, key rotation and stale-roster rejection.
- [x] Mock pagination, duplicate/out-of-order delivery simulation, offline/reconnect and unread read-state.
- [x] Encrypted IndexedDB envelope rejects plaintext/private-key/token/passphrase/PIN fields; export, clear and restore round-trip in a real browser without losing the imported envelope.
- [x] Draft is manually approved; no auto-send, background delivery or broadcast route exists.

## Deliberately not yet release proof

- [x] Browser E2E on installed Chrome/Edge (`npm run test:browser`): desktop
      and 375px load, settings, cache unlock/restart, offline shell, no
      horizontal overflow and no console errors. Keyboard-only traversal and
      200% zoom are still manual checks.
- [ ] Live OAuth, scopes/credits, consented X test accounts and text/URL/image/group results.
- [ ] Live real-time delivery/reconnect and live roster admin/title operations.
- [ ] Hosted/team backend, multi-account permissions, durable secure key backup or auto-send.

`LIVE_PASS` remains **NOT_VERIFIED** until the separate live preflight and
redacted two-account evidence are complete.
