# Security and privacy review — local Mock slice

Date: 2026-11-21. Scope: `apps/x-chat-web` at `dc425d3` plus the hardening
changes below. This review covers the loopback-only, single-account Mock slice.
It does not approve live OAuth, hosted deployment, team features or automation;
those require the reviews listed in `THREAT_MODEL.md`.

## Method

- Read `server.mjs`, `lib/*.mjs`, `public/*.mjs`, `public/app.js`, the CSP, and
  the data-handling/threat-model documents.
- Searched the browser code for `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval`, `new Function`, `localStorage`, `sessionStorage`,
  `window.open` and raw `fetch` sinks.
- Traced where the OAuth token, PIN, private-key blob, passphrase, conversation
  keys and plaintext can flow.
- Exercised the gates: `npm run check`, `npm test`, `npm run test:browser`,
  `npm run scan:secrets`, `npm audit --omit=dev --audit-level=high`.

## Findings

| #   | Finding                                                                                                                               | Severity | Status                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The server validated POST origin but not the `Host` header, so DNS rebinding could make an attacker origin same-origin for GET reads. | Low      | Fixed: the request handler rejects any `Host` other than `127.0.0.1:<port>` or `localhost:<port>` with HTTP 403; covered by a mock test.     |
| 2   | Cache import read an arbitrary user-selected file before validating it, allowing a huge file to exhaust browser memory.               | Low      | Fixed: imports over 20 MiB are rejected before reading; covered by the browser smoke.                                                        |
| 3   | XSS through message text, links, filenames or profile data.                                                                           | High     | No finding: no HTML sinks; text uses DOM text nodes; links allow only `http(s)` and set `noopener noreferrer`; CSP blocks inline script.     |
| 4   | OAuth token or Juicebox tokens reaching browser code, logs or the cache.                                                              | High     | No finding: token is process-environment only, `/api/status` exposes booleans, realm tokens are memory-only and cleared after unlock.        |
| 5   | Plaintext, private keys, passphrases or conversation keys persisted in IndexedDB.                                                     | High     | No finding: envelope keys are exactly `version/salt/iv/ciphertext`; forbidden fields fail closed; browser smoke inspects the stored record.  |
| 6   | Cross-site POST to the loopback adapter.                                                                                              | Medium   | No finding: POST needs JSON, `x-chat-local: 1` and the exact loopback `Origin`; tests cover missing/wrong header and origin.                 |
| 7   | Path traversal, MIME sniffing or caching of local files.                                                                              | Medium   | No finding: resolved paths must stay under the static root; `nosniff`, `no-store`, CSP and frame denial are set; traversal tests pass.       |
| 8   | Unbounded upstream reads, redirects or timeouts.                                                                                      | Medium   | No finding: 10 s timeout, redirects rejected, JSON capped at 1 MiB and live media streamed with a 16 MiB bound.                              |
| 9   | Tampered or malformed cache envelope yields plaintext.                                                                                | Medium   | No finding: AES-GCM fails closed; tamper, version, salt and base64 tests pass.                                                               |
| 10  | Mock-only routes active in Live mode.                                                                                                 | Medium   | No finding: every `/api/mock/*` route returns 404 unless `X_CHAT_API_MODE=mock` (two also need the simulation flag).                         |
| 11  | Upstream errors or response bodies leak into local errors.                                                                            | Medium   | No finding: errors map to status/retryability with generic text; X response bodies are never forwarded.                                      |
| 12  | Dependency vulnerabilities.                                                                                                           | High     | No finding: `npm audit` reports 0 vulnerabilities for production and full trees; CI re-runs the production audit and emits a CycloneDX SBOM. |

## Residual risk accepted for this slice

- Loopback is not a trust boundary against malware or another privileged local
  process; the server has no rate limiting and serves the owner's account only.
- A compromised browser, extension or device can read plaintext and keys while
  unlocked.
- The protocol provides no forward secrecy or post-compromise security, and
  removed members may still read history they could access before rotation.
- Live OAuth scope, token refresh/revocation and real-time delivery are out of
  scope and remain blocked on accounts and owner approval.
- Screen-reader and 200% zoom checks remain manual (see `ACCESSIBILITY_AUDIT.md`).

## Release-blocker status

No open release blocker for the local Mock slice. Live traffic still requires
the live gates in `THREAT_MODEL.md`, including the OAuth/token-lifecycle review
and two consented test identities; `LIVE_PASS` stays **NOT_VERIFIED**.

## Reproduce

```bash
npm run check
npm test
npm run test:browser
npm run scan:secrets
npm audit --omit=dev --audit-level=high
```
