# Operations runbook — local prototype

This runbook covers the local, single-account web app in `apps/x-chat-web`.
It is not an operations plan for a hosted or team deployment; see
`THREAT_MODEL.md` and `DATA_HANDLING.md` for the limits that carry over.

## Environments and configuration

| Environment | How it runs                                                             | Network  | State                                                              |
| ----------- | ----------------------------------------------------------------------- | -------- | ------------------------------------------------------------------ |
| Development | `npm run start:mock` (or `X_CHAT_API_MODE=mock npm start`)              | loopback | In-memory Mock store; lost on server restart                       |
| Test / CI   | `npm test`, `npm run test:browser`, `npm run soak:mock`                 | loopback | Mock server spawned per run on an ephemeral `PORT=0` and discarded |
| Production  | `X_CHAT_API_MODE=live` with `X_ACCESS_TOKEN` in the process environment | loopback | Encrypted browser IndexedDB cache; no server-side persistence      |

Configuration is read only from the server process environment:

| Variable                                      | Purpose                                               | Notes                                                  |
| --------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `PORT`                                        | Loopback port (default `8787`)                        | Bind is always `127.0.0.1`; do not expose it           |
| `X_CHAT_API_MODE`                             | `live` (default) or `mock`                            | Mock is for local testing only                         |
| `X_ACCESS_TOKEN`                              | User token for live X API calls                       | Env-only; never `.env`, `setx`, command line or source |
| `X_CHAT_LIVE_OWNER_USER_ID`                   | Single-use Live Create owner ID                       | All four Live Create values must be present and valid  |
| `X_CHAT_LIVE_OWNER_USERNAME`                  | Single-use Live Create owner username                 | Env-only                                               |
| `X_CHAT_LIVE_RECIPIENT_USER_ID`               | Single-use Live Create recipient ID                   | Env-only                                               |
| `X_CHAT_LIVE_RECIPIENT_USERNAME`              | Single-use Live Create recipient username             | Env-only                                               |
| `X_CHAT_BROWSER_PATH`                         | Browser binary for `test:browser` (developer/CI only) | Never needed by the app itself                         |
| `X_CHAT_BROWSER_REQUIRED`                     | `1` turns a missing browser into a CI failure         | CI only                                                |
| `SOAK_SECONDS`, `SOAK_CONCURRENCY`            | Soak duration and worker count                        | Probe defaults: 8s, 8 workers                          |
| `SOAK_MAX_P95_MS`, `SOAK_MAX_HEAP_GROWTH_MIB` | Soak failure thresholds                               | Defaults: 1000 ms, 64 MiB                              |

There is no development-only build flag. `vite build` runs the same way in
every environment, and `tools` such as the Mock identity button are gated by
`X_CHAT_API_MODE=mock` at runtime, not by a build variant.

## Setup from a clean checkout

```powershell
cd apps/x-chat-web
npm ci                 # installs exactly package-lock.json
npm run scan:secrets
npm run check
npm test
npm run start:mock     # build + serve with in-memory Mock data
```

The built static files live in `node_modules/.cache/x-chat-web` (configured by
`vite.config.mjs`); `npm start` rebuilds before serving. Browser state
(IndexedDB cache) lives in the browser profile, not in this directory.

## Build, artifacts and SBOM

- The lockfile is committed; `npm ci` is the only supported install for a
  build or CI. `engines.node` is `>=20`, and CI verifies Node 20 and 22.
- Two consecutive `npm run build` runs were byte-identical on 2026-11-21
  (same file set and SHA-256 per file). The build has no timestamp, random or
  machine-specific input; a release should still compare hashes between the
  build host and CI before publishing.
- `npm run sbom` writes a CycloneDX SBOM of production dependencies to stdout;
  CI uploads the same artifact for Node 20 and 22.
- Production dependencies are `@xdevplatform/chat-xdk` 0.7.1 (MIT) and
  `juicebox-sdk` 0.3.7 (MIT); the SDK's transitive notices are covered by the
  repository `THIRD_PARTY_NOTICES.md`.
- A build artifact must not contain environment values: `vite build` output
  contains no `X_ACCESS_TOKEN` or `X_CHAT_LIVE_*` names or values (checked
  2026-11-21). Re-check after any change that touches server config or the
  Vite define list.
- Signed/attested artifacts are **not** produced: there is no release-signing
  key or distribution channel yet. Defining one is an owner decision before
  any artifact leaves this machine.

## Data backup, restore and delete

Servers keep no message data. The only durable user data is the optional
encrypted IndexedDB cache in the browser.

1. Back up: Settings → cache section → export. The downloaded envelope holds
   signed ciphertext/metadata encrypted with the user passphrase.
2. Restore: import the envelope (it is validated and not unlocked), then
   unlock with the same passphrase. A wrong passphrase, unsupported version or
   malformed envelope fails closed and leaves the existing cache untouched.
3. Delete: use the explicit delete control and confirm. This clears the local
   database only; an exported copy is outside app control.
4. Mock server restart deletes all Mock users, conversations and deliveries;
   this is expected and needs no backup.
5. Before uninstalling a browser profile or moving devices, export first —
   the cache is not recoverable from the server.

## Upgrade and migration

1. Stop the server, export the cache if the change touches the cache schema.
2. `npm ci` (never a partial `npm install`) and re-run the gates below.
3. The cache envelope carries a version; a reader rejects unknown versions
   with an explicit error instead of guessing. Current prototype version is
   version 1 (`x-chat-local-cache-v1`).
4. A protocol or SDK upgrade that changes event verification requires the
   full offline and Mock suites plus a new security review; do not relax
   verification to keep old data readable.

## Rollback

1. Stop the server and revert to the previous known-good commit
   (`git revert` a bad change, or check out the prior commit on a separate
   branch). Do not force-push shared history.
2. Re-run `npm ci`, `npm run check`, `npm test`, `npm run test:browser` and
   `npm run soak:mock` on the rolled-back tree.
3. Browser cache: an older app that does not know a newer envelope version
   rejects it with "Unsupported encrypted cache version". Export on the newer
   version first, roll back, then import only if the older version accepts the
   version; otherwise keep the export until forward-fixing is possible.
4. Rolling back the app does not revoke or rotate the X token. If the rollback
   was caused by a credential incident, follow `INCIDENT_RESPONSE.md`.

## Verification and monitoring

- Gates: `npm run check`, `npm test`, `npm run test:browser` (CI requires a
  browser), `npm run soak:mock`, `npm run scan:secrets`,
  `npm audit --omit=dev --audit-level=high`.
- `/api/health` reports mode, SDK presence and uptime; `/api/metrics` reports
  request counts, status buckets, server errors and RSS/heap. Neither exposes
  paths, accounts, tokens or message data.
- There is no alerting, structured log store or rate limiter. A loopback-only
  server remains reachable by other local processes; treat the device as
  trusted until those gaps are closed.
