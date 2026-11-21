# Incident response — local prototype

This runbook minimizes further exposure. It does not replace the product and
security owner required before any public release.

## First actions for every incident

1. Stop the local server and do not retry or send follow-up messages.
2. Record only time, redacted conversation/event or message IDs, action,
   HTTP status, and verification outcome. Do not copy plaintext, ciphertext,
   tokens, PINs, raw keys, or key blobs into the record.
3. Preserve no browser screenshot if it exposes message plaintext or secrets.
4. Escalate to the accountable security/product owner before resuming live
   traffic.

## Token exposure or suspected misuse

1. Close the server process so the environment value is discarded.
2. Revoke or rotate the OAuth token in the X Developer Console.
3. Review the consented test scope and use a new least-privilege token only
   after approval.
4. Do not infer that a request failed or a send was not delivered merely from
   a local network error; reconcile history once authorized.

## Lost, exposed, or untrusted private key material

1. Stop the browser session and do not import the same blob into another
   uncontrolled environment.
2. Treat messages encrypted under any possibly exposed conversation key as
   exposed to that key holder; do not claim retroactive protection.
3. The designated security owner must choose account/key recovery and any
   future conversation-key rotation. Do not lower the SDK key-version floor or
   bypass signature verification to recover access.

## Signature, key-binding, or KeyChange verification failure

1. Keep the event unrendered; the application must fail closed.
2. Record the redacted event ID, sender ID, key version, and failure category.
3. Refresh public signing keys and history only through the authenticated API;
   never trust a key embedded in the failing event.
4. Stop if the mismatch persists. Do not add an allowlist or disable
   verification as a workaround.

## Message sent to the wrong conversation or recipient

1. Stop further sends immediately and confirm the canonical conversation ID
   with the accountable owner.
2. Treat the ciphertext as delivered to that conversation if the outcome is
   ambiguous. Do not send an automated correction or assume deletion retracts
   recipient access.
3. Use any X deletion/remediation action only after the owner approves it and
   record its result without copying message content.

## Return to service

Live tests may resume only after the owner confirms the incident action,
credentials and keys have been handled, consent still applies, and the
preflight checks pass again.
