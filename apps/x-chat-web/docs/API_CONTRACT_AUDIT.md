# X Chat API contract audit

Audited against the official X documentation on 2026-11-21, before the first
live request. This is a design-time contract check, not evidence that an X
Developer app, token, scope, or endpoint access is active.

## Adapter contract

| Operation              | Local route                                          | X request contract used by the app                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current user           | `GET /api/me`                                        | `GET /2/users/me`                                                                                                                                                                             |
| Signing keys           | `GET /api/public-keys?user_id=`                      | `GET /2/users/{id}/public_keys` with explicit `public_key.fields=identity_public_key_signature,public_key,public_key_version,signing_public_key`                                              |
| Contact lookup         | `GET /api/contacts/lookup?username=`                 | Server-only `GET /2/users/by/username/{username}` with `user.fields=id,name,username,profile_image_url,receives_your_chat`; rejects self by authenticated user ID                             |
| Existing direct room   | Included in contact lookup                           | `GET /2/chat/conversations` with `type=direct`, `participant_ids={authenticated-user-id},{recipient-id}`, and `expansions=participant_ids`; the browser still verifies the exact participants |
| Direct key initialize  | `POST /api/conversations/initialize` (Mock only)     | Contract preview for `POST /2/chat/conversations/{recipientUserId}/keys`; the local adapter validates SDK participant keys/action signatures and deliberately returns `501` outside Mock mode |
| Juicebox unlock config | `GET /api/juicebox/config`                           | Server derives the account from `GET /2/users/me`, then requests `GET /2/users/{id}/public_keys` with `juicebox_config` and public-key fields; no browser-supplied user ID is trusted         |
| Group initialize       | `POST /api/group/initialize`                         | `POST /2/chat/conversations/group/initialize`; returns the `g`-prefixed conversation ID used by the SDK and group-create request                                                              |
| Group create           | `POST /api/group/create`                             | `POST /2/chat/conversations/group` with SDK-prepared participant key wraps, encrypted title, members/admins, and both action signatures                                                       |
| Event history          | `GET /api/events?conversation_id=&pagination_token=` | `GET /2/chat/conversations/{id}/events`; URL path uses hyphens, history uses `pagination_token` / `meta.next_token`, and requests the fields needed to obtain `encoded_event`                 |
| Send ciphertext        | `POST /api/send`                                     | `POST /2/chat/conversations/{id}/messages` with `message_id`, `encoded_message_create_event`, `encoded_message_event_signature`, and `xdk_version`                                            |
| Media initialize       | `POST /api/media/initialize`                         | `POST /2/chat/media/upload/initialize` with canonical-colon `conversation_id` and encrypted `total_bytes`                                                                                     |
| Media append           | `POST /api/media/append`                             | `POST /2/chat/media/upload/{id}/append`; JSON media is base64 and `segment_index` is an integer from 0 to 999                                                                                 |
| Media finalize         | `POST /api/media/finalize`                           | `POST /2/chat/media/upload/{id}/finalize`; `num_parts` is a numeric string                                                                                                                    |
| Media download         | `GET /api/media/download`                            | `GET /2/chat/media/{conversation-id}/{media-hash-key}`                                                                                                                                        |

The signed attachment records the original plaintext file size, while the media
initialize request declares the encrypted upload size. The app keeps the
conversation ID in colon form when passing it to the Chat XDK and changes it
only for the path-based event, send, and download requests.

## Error and data-handling policy

- The loopback server attaches the OAuth user token itself; browser JavaScript
  never receives it.
- For PIN unlock the authenticated account's `juicebox_config` and realm token
  map are returned to browser memory because Chat XDK's supported Juicebox
  `getAuthToken` callback runs in the browser. PIN and realm tokens are never
  sent to the local server, logged, or persisted. CSP allows only exact HTTPS
  origins parsed from the authenticated config.
- Chat XDK 0.7.1's `unlock(pin)` recovers and imports existing keys. The app
  checks `getPublicKeys()`, `matchesRegisteredKey()`, and
  `verifyKeyBinding()` against all returned records; it sets identity only
  when exactly one record matches, using that record's own version. No latest
  version is inferred, and `setup()` is never called.
- Redirects are rejected, requests time out after ten seconds, JSON reads are
  capped at 1 MiB, and media reads are capped at 16 MiB.
- The adapter reports only a status-oriented error and retryability. It never
  forwards an upstream response body, preventing accidental token or data
  disclosure through the UI.
- Chat XDK remains the only component that decrypts or verifies events and
  attachments. The adapter only forwards ciphertext and API metadata.
- Username lookup is issued only after an explicit form submit (button or
  Enter). The OAuth token remains on the local server. Invalid handles are
  rejected locally, self lookup is rejected by authenticated ID, and
  `receives_your_chat` is rendered as encrypted, unencrypted, none, or unknown;
  it is not inferred from follows and does not guarantee a later send will
  succeed.
- Existing conversations must be a single verified direct room for the exact
  recipient. If lookup fails or finds multiple matches, starting a new room is
  blocked. A verified existing room is opened instead of creating another.
- The installed Chat XDK 0.7.1 declares
  `prepareConversationKeyChange({ publicKeys })` and returns the canonical
  `conversationId`, raw 32-byte `conversationKey`, `conversationKeyVersion`,
  exactly two participant key wraps, and one signed action for a new 1:1.
  The application verifies the SDK's numeric-sorted canonical ID and maps the
  returned wraps/signature to the official request body. The official request
  is `POST /2/chat/conversations/{recipientId}/keys` (recipient user ID, not
  the SDK's canonical conversation ID). Live forwarding remains disabled by
  default and requires the exact, expiring, one-shot local permit. A Mock
  acknowledgement is required before the raw key becomes the active in-memory
  conversation key in Mock mode; all failed/unknown flows zeroize it, and an
  unknown outcome is reconciled against a fresh room lookup before retry.
  Never call this method with an existing direct conversation ID.
- The SDK action signature is mapped without adding fields: `message_id`,
  `encoded_message_event_detail`, and `message_event_signature` containing
  `signature`, `signature_version`, `public_key_version`, and
  `signing_public_key`. The official Add Conversation Keys OpenAPI schema
  requires the first three nested signature properties; `signing_public_key`
  is an allowed optional property. The SDK's `signing_public_key` is forwarded
  as supplied; `signature_payload` and `message_signing_key_info_list` are not
  fabricated. The successful mock acknowledgement is accepted only when its
  `data.conversation_id` matches the SDK's canonical participant ID.
- Contact and preflight regression tests use the in-process Mock adapter.
  Automated browser tests must abort requests to `https://api.x.com/**`,
  including the SDK feature-switch fetch.
- For group creation, the browser verifies every identity-to-signing-key
  binding before it passes that user's identity key to `prepareGroupCreate`.
  The raw conversation key remains in browser memory and is never included in
  the local route payload.

## Official sources

- [X Chat introduction](https://docs.x.com/xchat/introduction)
- [Getting started](https://docs.x.com/xchat/getting-started)
- [Get user by username](https://docs.x.com/x-api/users/get-user-by-username)
- [Get chat conversation](https://docs.x.com/x-api/chat/get-chat-conversation)
- [Get chat conversations](https://docs.x.com/x-api/chat/get-chat-conversations)
- [Add conversation keys](https://docs.x.com/x-api/chat/add-conversation-keys)
- [Media guide](https://docs.x.com/xchat/media)
- [Conversation events](https://docs.x.com/x-api/chat/get-chat-conversation-events)
- [Send message](https://docs.x.com/x-api/chat/send-chat-message)
- [Public keys](https://docs.x.com/x-api/chat/get-user-public-keys)
- [Initialize group](https://docs.x.com/x-api/chat/initialize-chat-group)
- [Create group](https://docs.x.com/x-api/chat/create-chat-group-conversation)
- [Initialize media](https://docs.x.com/x-api/chat/initialize-chat-media-upload)
- [Append media](https://docs.x.com/x-api/chat/append-chat-media-upload)
- [Finalize media](https://docs.x.com/x-api/chat/finalize-chat-media-upload)
- [Download media](https://docs.x.com/x-api/chat/download-chat-media)
