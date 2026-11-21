# แผนแอป X Chat: ข้อความ ลิงก์ และภาพเป็นอันดับแรก

สถานะ: อัปเดต (2026-11-21) — ต้นแบบ local-only ที่ `apps/x-chat-web/` ผ่าน offline/mock/static gate ในเครื่อง (109 offline + 20 mock), มีคู่มือผู้ใช้ภาษาไทย, a11y audit บางส่วน และ cross-tab cache guard; การส่งกับ X API จริงยังไม่ผ่านการตรวจ (`LIVE_PASS` ยังเปิด) — ข้อที่ติดบัญชี/สิทธิ์ดูหัวข้อ "สิ่งที่ยังติด (Blocked)"

## สถานะงานปัจจุบัน

- [x] แยกแอป local-only ออกจาก SDK core และเลือก JS/WASM binding
- [x] ทำ offline crypto round trip ด้วย binding จริง: decrypt history, encrypt/decrypt message และ media
- [x] ตรวจ syntax ของ server/UI และ smoke-test mock adapter แบบ loopback: `me`, history, send และ media upload/download
- [x] ทำ `MOCK_API_PASS`: automated integration test ครบ send/history/media flow พร้อม signing key และ KeyChange history โดยไม่เรียก X จริง
- [x] ทำ `STATIC_PASS` สำหรับ MVP local adapter: syntax, route/input validation, body limits และ local error mapping ที่มี test รองรับ
- [x] (2026-11-21) ถอดบัญชีทดสอบออกจากซอร์ส: Live Create target มาจาก environment 4 ตัว และ test/preflight ใช้ค่าจำลอง
- [x] (2026-11-21) ปิดช่องว่าง STATIC_PASS ที่ทำได้: Node 20+, CI matrix 20/22, retry ใช้ `message_id` เดิม, offline แสดงข้อความที่ verify แล้วจาก cache
- [ ] ทำ `LIVE_PASS`: บัญชีทดสอบ A/B พร้อม OAuth scopes ที่อนุมัติ
- [ ] เพิ่ม inbox persistence, pagination และ real-time events
- [ ] เพิ่มกลุ่ม, team workflow และ automation ตามลำดับเฟส

ลำดับดำเนินงานถัดไป: (1) push และยืนยัน CI จริง (2) เก็บงานเทคนิคที่ไม่ต้องใช้บัญชีในหัวข้อ Blocked ข้อ 3 (3) เตรียม OAuth/X Developer app และบัญชีทดสอบ A/B เพื่อเริ่ม `LIVE_PASS`.

## Master checklist — ตั้งแต่ต้นแบบจนจบโครงการ

รายการนี้คือแผนทำงานหลักของแอป ไม่ใช่แผนเปลี่ยน `chat-xdk` SDK. ทุกข้อที่
เกี่ยวกับการเข้ารหัสต้องเรียก SDK จริง และต้องไม่ย้าย HTTP, OAuth, workflow
หรือการเก็บข้อมูลเข้า `crates/`.

**นิยามสถานะ:** ติ๊ก `[x]` เฉพาะเมื่อมีหลักฐานที่ทำซ้ำได้ (test, log ที่ไม่
มีความลับ, หรือผล UAT); `[ ]` คือยังไม่ผ่าน. `LIVE_PASS` ต้องมีผลจากบัญชี
ทดสอบที่ยินยอมสองฝ่ายเสมอ — หน้าเว็บโหลดได้หรือ HTTP ตอบ 200 ไม่ถือว่าผ่าน.

### P0 — ขอบเขต, ความปลอดภัย และฐานการพัฒนา

- [x] กำหนดว่าแอปเป็น local-only, single-account web prototype แยกจาก SDK
- [x] เลือก JS/WASM binding และยืนยันว่า private-key blob อยู่ใน browser memory เท่านั้น
- [x] ระบุว่า MVP รองรับข้อความ, URL ในข้อความ และ PNG/JPEG หนึ่งภาพต่อข้อความ
- [ ] แต่งตั้ง product/security owner และผู้รับผิดชอบการอนุมัติ live test/release
- [ ] ระบุผู้ใช้เป้าหมาย, use case ที่อนุญาต และสิ่งที่ไม่อยู่ในขอบเขตของ MVP
- [ ] ตัดสินใจรูปแบบผลิตภัณฑ์หลัง MVP: local app, desktop app หรือ hosted service
- [x] เขียน threat model: browser, loopback server, token, private key, ciphertext,
      X API, event delivery และ local storage
- [x] ระบุ data classification และ retention ของ plaintext, ciphertext, metadata,
      logs, backups และไฟล์ชั่วคราวสำหรับ local prototype; hosted/team ต้อง review ใหม่
- [x] กำหนด incident path สำหรับ token รั่ว, key สูญหาย, signature ผิด และส่งผิดห้อง โดย fail-closed และเก็บหลักฐาน redacted
- [x] กำหนดว่าห้าม commit/log/paste: access token, refresh token, PIN, raw private key,
      key blob, plaintext และ ciphertext เต็มก้อน (DEVELOPER_ONBOARDING + README
      Boundaries + secret guard ใน CI บังคับใช้จริง)
- [x] เพิ่ม secret guard ใน CI สำหรับ PEM, literal `X_ACCESS_TOKEN` และ common GitHub/Slack token prefix; `.gitignore` กัน local X Chat `.env` แล้ว
- [x] เขียน developer onboarding ที่ใช้ process environment แบบ interactive เท่านั้น; ไม่ใช้ `.env` หรือ `setx`
- [ ] เลือก license, ownership และช่องทางรายงานช่องโหว่ก่อน public release

### P1 — ทำ mock ให้เป็นเกณฑ์คุณภาพที่ทำซ้ำได้

- [x] สร้าง loopback-only server และ mock API mode ที่ไม่เรียกเครือข่ายภายนอก
- [x] จำกัด request body และตรวจรูปแบบ input ของ local adapter ในเส้นทางหลัก
- [x] smoke-test mock: profile, events, send, initialize/append/finalize/download media
- [x] ทำ automated integration tests ที่เริ่ม/หยุด mock server เองโดยไม่ชน port ของเครื่อง
- [x] ทดสอบ `/api/status`, `/api/me`, public keys และ empty history ใน mock mode
- [x] ทดสอบข้อความ: encrypt → send → history/event response → verify/decrypt ด้วย WASM binding จริง
- [x] ทดสอบ URL segmentation: URL แยกเป็น link และ HTML-like text ไม่ถูกตีความเป็น markup
- [x] ให้ mock เก็บและคืน event ที่ส่ง พร้อม signed KeyChange fixture ที่ใช้เปิดข้อความได้
- [x] ทดสอบ URL ว่า render เป็น DOM text/anchor node ที่มี `noopener noreferrer` โดยไม่สร้าง HTML จากข้อความ
- [x] ทดสอบภาพ: initialize → encrypt → append/finalize → send → download → decrypt ด้วย WASM binding จริง
- [x] ทดสอบหลาย chunk, chunk ที่ขาด/สลับลำดับ, finalize ก่อน append ครบ และ media hash ที่ไม่พบ
- [x] ทดสอบส่งซ้ำหลัง network ambiguity ว่าเก็บ `message_id` และ encrypted payload เดิม; permanent failure ไม่เปิด retry
- [x] ทดสอบ pagination token, empty page, event ซ้ำ และลำดับ KeyChange ก่อน message ผ่าน mock history และ WASM decrypt จริง
- [x] ทดสอบ invalid/missing content-type, origin, local header, route, identifier,
      size, segment index และ malformed JSON
- [x] ทดสอบ 401/403/404/409/429/5xx/timeout จาก adapter; error จะบอกเฉพาะ HTTP status และ retryability ไม่ส่ง body/token ต่อ
- [x] ทดสอบ signature/key/media ผิดว่า SDK ไม่ decrypt/คืน plaintext; UI render เฉพาะ `verified === true`
- [x] เก็บ fixtures แบบไม่มี secret และใช้ SDK จริง ไม่ mock crypto
- [x] เพิ่ม `npm run test:mock` และ CI job สำหรับ offline/mock gate
- [ ] ยืนยันผล CI หลัง commit/push ว่า offline/mock gate ผ่านบน runner ใหม่ (blocked: repo ยังไม่ push)

### P2 — ปิด STATIC_PASS และคุณภาพโค้ด

- [x] มี `npm run check` สำหรับ JavaScript syntax ของ server และ UI
- [x] ทดสอบ route/input validation, body limit, local-origin guard, local error mapping และ static security headers ของ MVP adapter
- [x] เพิ่ม Prettier formatter และ TypeScript `checkJs` type checking ที่บังคับใช้ใน `npm run check` / CI
- [x] แยก adapter, validation, state machine และ UI ให้ทดสอบได้โดยไม่ copy crypto logic
      (ทำแล้ว: `server.mjs` แยกเป็น `lib/api-validation.mjs`, `lib/mock-store.mjs`,
      `lib/direct-conversation-lookup.mjs` พร้อม unit tests
      `test/api-validation.test.mjs` / `test/direct-conversation-lookup.test.mjs`;
      state machine อยู่ใน `public/send-state.mjs`, `event-state.mjs`, `draft-queue.mjs`;
      crypto/verify อยู่หลัง `public/gateway.mjs`, `reconcile.mjs`, `media.mjs`
      และ test ใช้ SDK จริงแทนการ copy logic; UI event wiring ยังรวมใน
      `public/app.js` ตามที่ตั้งใจสำหรับ prototype นี้ โดยไม่มีการคัดลอก crypto)
- [x] ตรวจทุก route ว่ากำหนด method, content type, request/body size, error response และ cache policy; method ผิดตอบ 405 พร้อม `Allow`
- [x] จำกัด static files, ป้องกัน path traversal และยืนยัน MIME/`nosniff` headers ด้วย mock adapter test
- [x] กำหนด CSP, clickjacking/referrer policy และ local origin policy สำหรับ MVP local app
- [x] ตรวจ error mapping ว่าแยก invalid input, auth/config, rate limit, retryable และ permanent failure
- [x] กำหนด timeout 10 วินาที และขอบเขต X API response: JSON 1 MiB, media 16 MiB พร้อม unit tests
- [x] ตรวจว่า retry ไม่สร้าง message ID ใหม่ และไม่ retry การกระทำที่ไม่ idempotent อย่างไร้ขอบเขต
- [x] เพิ่ม dependency audit/lockfile review และ SBOM ตามช่องทาง release ที่เลือก
- [x] เพิ่ม production dependency audit ใน CI; audit ปัจจุบันไม่พบ high vulnerabilities
- [x] ทำ code review ด้าน security/privacy และแก้ทุก finding ระดับ release blocker
      (`docs/SECURITY_REVIEW.md`: 12 หัวข้อ, ไม่มี blocker สำหรับ Mock slice;
      แก้ระหว่างรีวิวคือ loopback `Host` allowlist กัน DNS rebinding และจำกัด
      ไฟล์ import cache 20 MiB; `npm audit` 0 vulnerabilities ทั้ง prod/dev)
- [x] ตรวจ accessibility: keyboard, focus, label, contrast, live status และ error announcement
      (ทำแล้ว: `test:browser` เพิ่ม automated accessible-name audit ของทุก
      visible control (เจอและแก้ `#conversation-search` ที่มีแต่ placeholder),
      ตรวจ dialog focus เข้าใน + Escape คืน focus, ตรวจ live region ของ status
      หลัก, contrast 45 คู่ผ่าน WCAG AA, reduced-motion และ reflow proxy
      640×450 (= 1280×900 ที่ zoom 200%) — ดู `ACCESSIBILITY_AUDIT.md`;
      ยังเหลือ manual screen reader (NVDA/VoiceOver) และ browser-zoom จริง
      ซึ่งต้องมีผู้ทดสอบ ไม่ใช่โค้ด)
- [x] ทดสอบ browser ที่จะรองรับและขนาดหน้าจอขั้นต่ำที่ประกาศ
      (`npm run test:browser` ขับ Chrome 158 และ Edge 155 แบบ headless ที่
      1280×900 และ 375×812: โหลด, ตัวกรอง unread, settings, cache unlock,
      reload แล้ว cache ยังอยู่, backup export/clear/restore, รายการกลุ่ม Mock,
      offline shell, ไม่มี horizontal overflow และไม่มี console/page error —
      8 scenario ผ่านทั้งสองเบราว์เซอร์; Firefox/Safari ยังไม่รองรับ)
- [x] ทำให้ `STATIC_PASS` เป็น CI gate ที่บันทึกผลได้

### P3 — เตรียม X integration และ LIVE_PASS อย่างปลอดภัย

- [x] ตรวจสัญญา X API/OpenAPI ที่ใช้อยู่: public-key/event fields ถูกระบุ explicit, `segment_index` เป็น integer 0–999, `num_parts` เป็น numeric string และ error ไม่เผย upstream body
- [ ] สร้าง/ตรวจ X Developer app และอนุมัติการเข้าถึง X Chat ที่จำเป็น
- [x] จัดทำ live preflight/checklist ที่ไม่บันทึก secret สำหรับ OAuth, test identities และ evidence
- [ ] ยืนยัน OAuth user-context flow, redirect URI, token lifetime/refresh และ least-privilege scopes
- [ ] ยืนยัน `dm.read`, `dm.write`, `tweet.read`, `users.read`, `media.write` และ scope เพิ่มเติมที่ operation จริงระบุ
- [ ] เก็บ token เฉพาะ local secret store/environment; ไม่ส่ง token ให้ browser JavaScript หรือ log
- [ ] สร้างบัญชีทดสอบ A/B และ conversation ที่ทั้งสองฝ่ายยินยอมรับข้อความ
- [ ] ตรวจ public signing keys, identity keys และ key version ของทั้งสองบัญชีก่อนส่ง
- [ ] ทดสอบเริ่ม session: import/unlock, `setIdentity`, signing keys และ conversation keys
- [ ] LIVE: A ส่งข้อความธรรมดาไป B; B โหลด history, verify และ decrypt สำเร็จ
- [ ] LIVE: A ส่ง URL; B เห็น URL และเปิดได้ตามพฤติกรรม X client ที่ยืนยันแล้ว
- [ ] LIVE: A ส่ง PNG; B ดาวน์โหลด ciphertext, decrypt ด้วย **key version ของ event** และได้ bytes ตรงต้นฉบับ
- [ ] LIVE: ทำซ้ำกับ JPEG และหลาย upload parts ภายใต้ขนาดที่ X อนุญาต
- [ ] LIVE: B ตอบกลับ A และทั้งสองฝั่ง verify/decrypt ได้
- [ ] LIVE: ตรวจ response timeout/5xx แล้ว resend payload เดิมโดยไม่สร้างข้อความซ้ำ
- [ ] LIVE: ทดสอบ signing key หาย, signature ผิด, KeyChange ผิด และ media hash ผิดว่า fail-closed
- [ ] บันทึกหลักฐาน LIVE_PASS ที่ redacted: เวลา, test account aliases, conversation/event IDs, key version, outcome
- [ ] ปิด/ถอน test token และลบ ciphertext/plaintext test data ตาม retention เมื่อเสร็จ

### P4 — Inbox ที่ใช้งานต่อเนื่องได้

- [ ] ออกแบบ local persistence โดยเก็บ metadata เท่าที่จำเป็นและกำหนด opt-in ของ plaintext cache
- [ ] เข้ารหัส at-rest ของข้อมูลที่ต้องเก็บ และกำหนด key/backup/restore model โดยไม่เก็บ raw private key แบบไม่ป้องกัน
- [x] ทำรายการ conversation, unread state และการเปิด conversation ที่มีสิทธิ์
      (browser smoke สร้างกลุ่ม Mock แล้วเห็นรายการ/ตัวกรองและ search ทำงาน;
      mock test ยืนยัน unread state; `conversation-list` unit tests ปฏิเสธ
      record ที่ตรวจผู้เข้าร่วมไม่ได้ก่อนเปิด)
- [ ] ทำ history pagination จนสุด โดยประมวล KeyChange metadata ก่อน event ที่พึ่งพากุญแจนั้น
- [x] เพิ่ม cursor pagination ของ event history ด้วย `next_token` → `pagination_token` พร้อม mock adapter test
- [ ] ทำ dedup ด้วย signed `message_id`; แยก event-delivery id สำหรับ dedup ของ stream/webhook
- [x] ทำ in-memory dedup/retry ของข้อความด้วย signed message ID; event-delivery dedup รอ real-time phase
- [x] ทำ optimistic send state: draft → encrypting → uploading → sending → sent/failed/unknown พร้อม live status และ retry ของ payload เดิม
- [x] ทำ retry/reconcile สำหรับสถานะ unknown: ตรวจ history หา signed `message_id` ก่อน; หากไม่พบจึงส่ง payload เดิมซ้ำ
- [x] ทำ upload encryption แบบจำกัด memory: อ่าน Blob ครั้งละ 256 KiB, ใช้ `fileEncryptor`, และ append ciphertext ครั้งละไม่เกิน 3 MiB
- [x] ทำดาวน์โหลด/ถอดไฟล์แบบ streaming: adapter forward bounded ciphertext stream และ browser ใช้ `fileDecryptor` ทีละ chunk ก่อนสร้าง preview Blob
- [x] แสดง preview เฉพาะหลัง decrypt และยอมเฉพาะ PNG/JPEG ที่ตรวจ magic bytes; URL render เป็น text node/HTTP(S) link พร้อม `noopener noreferrer`
- [ ] ทำ search/filter เฉพาะ scope ข้อมูลที่ถูกอนุญาต และกำหนด indexing/retention ของ plaintext
- [x] ทำ export/delete local data และทดสอบ restore โดยไม่ทำข้อมูลอื่นหาย
      (browser smoke: export ไฟล์จริง, import ไฟล์เสียต้องไม่แตะ cache เดิม,
      clear พร้อม confirm แล้ว record หายจริง, import ไฟล์เดิมกลับและปลดล็อก
      ด้วย passphrase เดิมได้; `cache-vault` test ครอบ round-trip)
- [x] ทดสอบ restart, offline, corrupted cache, missing history page และ concurrent tabs
      (restart/offline: `npm run test:browser` reload แล้วปลดล็อก cache เดิมได้
      และ offline แล้ว shell ยังใช้งานได้; corrupted cache: tampered/malformed
      envelope fail-closed test; missing page: mock คืนหน้าว่างแทน error;
      concurrent tabs: `BroadcastChannel` guard + unit test — ยังไม่ได้ทำ
      multi-tab E2E ในเบราว์เซอร์จริง)

### P5 — Real-time delivery และความน่าเชื่อถือ

- [ ] เลือก activity stream หรือ webhook จาก deployment model และบันทึกเหตุผล
- [ ] ทำ subscription lifecycle: create/list/update/delete และ cleanup เมื่อ user disconnects
- [ ] สำหรับ webhook: HTTPS, verification/CRC, request signature verification, replay window และ rate limit
- [ ] สำหรับ stream: reconnect with bounded backoff, cursor/backfill strategy และ cancellation
- [ ] รับ `chat.received` และ `chat.sent`; ผูก event กับ conversation และ refresh signing keys อย่างปลอดภัย
- [ ] ประมวล `conversation_key_change_event` ก่อน message และรักษา monotonic key-version floor
- [ ] ทดสอบ duplicate/out-of-order/lost delivery, reconnect และ backfill โดยไม่ render plaintext ที่ไม่ verify
- [ ] ทำ health/metrics ที่ไม่มี plaintext/key/token และ alert เฉพาะ operational signal ที่จำเป็น
      (ทำแล้ว: `/api/health` + `/api/metrics` นับ request/status bucket/server
      error โดยไม่เผย path หรือ PII + mock test; alerting ต้องมี infra
      จึงยังไม่ทำ)
- [x] ทำ load/soak test กับ mock เพื่อวัด memory, queue/backpressure และ rate-limit behavior
      (ทำแล้ว: `npm run soak:mock` spawn mock server แล้วยิง 8s × 8 workers
      = ~100k requests; วัด p50/p95 latency, status histogram, `/api/metrics`
      `serverErrors` และ heap Δ จาก snapshot สองรอบหลัง settle; ตรวจ bounded
      Mock delivery queue (burst 12), offline read คืน 503 + retryable แล้วกู้
      กลับได้, และ malformed body คืน 400; rate-limit 429 ไม่ได้จำลองใน mock
      แต่มี unit test ฝั่ง adapter/client ครอบอยู่แล้ว; ผลล่าสุด p95 < 1 ms,
      heap +2 MiB, ไม่มี unexpected 5xx; ไม่มี rate limiter ของ server เอง —
      ต้องเพิ่มก่อนเปิดใช้นอก loopback)
- [ ] UAT: ส่งและรับใน real-time, restart/reconnect และ history reconciliation ผ่านเกณฑ์

### P6 — กลุ่มเฉพาะสมาชิก

- [x] ยืนยัน API contract สำหรับ group initialize/create และ action signatures; member-change ยังไม่ทำ
- [x] สร้าง group ใน Mock ผ่าน SDK `prepareGroupCreate` และส่ง action signatures ครบสองรายการ
- [x] โหลด/verify key binding ของสมาชิกแบบระบุ X user ID ก่อนสร้าง group และเก็บ raw group key ใน browser memory
- [x] MOCK: ส่ง/รับข้อความในกลุ่มด้วย group conversation ID และ key version ที่ถูกต้อง
- [ ] LIVE: สร้างกลุ่มที่ทุกบัญชียินยอม และทดสอบข้อความ/ภาพผ่าน X API จริง
- [ ] เพิ่มสมาชิก: rotate key, เผยแพร่ wraps, และยืนยันว่าสมาชิกใหม่อ่านข้อความหลังเข้าร่วมได้
- [ ] ลบสมาชิก: rotate key และยืนยันว่าผู้ถูกลบเปิดข้อความภายใต้ key ใหม่ไม่ได้
- [x] แสดง/สื่อสารข้อจำกัด protocol: ผู้ที่เคยได้ key เก่าอาจอ่านข้อความเก่าที่เคยเข้าถึงได้
      (ข้อความใน settings ใต้ฟอร์มเปลี่ยนสมาชิก ระบุว่า rotation มีผลเฉพาะ
      ข้อความหลังเปลี่ยน และผู้ที่เคยได้คีย์เก่าอาจอ่านข้อความเก่าได้)
- [x] รองรับกรณี signing key ของผู้สร้าง/แอดมินเก่าไม่อยู่ใน public-key endpoint ตามแนวทางที่ตรวจทานด้านความปลอดภัย
      (ทำแล้ว: `signing-key-records` รับ response แบบ array/single object และ
      UI แสดงจำนวนบัญชีที่หา key ไม่พบใน activity แทนการทิ้งเงียบ; การ fail-closed
      เมื่อไม่มี key/signature ตรงกันมี test ครอบ; กรณี key ถูกลบถาวรไม่มี recovery
      flow โดยเจตนา (ทำไม่ได้ตาม protocol) และระบุใน `KNOWN_LIMITATIONS.md`)
- [ ] ทดสอบ membership races, stale key, unauthorized member change และ recovery จาก partial history
      (ทำแล้ว: stale roster/key version ถูกปฏิเสธ, เพิ่มสมาชิกที่มีอยู่/ไม่มี key,
      ลบตัวเอง/คนที่ไม่ใช่สมาชิก, rotation roster ไม่ตรง, และยิงเปลี่ยนสมาชิก
      พร้อมกันสองคำขอด้วย expected version เดียวกัน → สำเร็จเพียงหนึ่งและอีก
      คำขอได้ 400; recovery จาก partial history ยังไม่ทดสอบเพราะต้องมี
      history/real-time reconciliation ก่อน — เป็นงานเฟสถัดไป)
- [ ] UAT กลุ่มอย่างน้อยสามสมาชิกพร้อมหลักฐาน redacted

### P7 — Team workflow

- [ ] ระบุ roles, least privilege, assignment, draft, approval, escalation และ audit requirements
- [ ] ตัดสินใจ owner ของ crypto boundary: เจ้าของบัญชี/อุปกรณ์ใดถือ private key; ห้ามแชร์ raw private key ให้ทีม
- [ ] แยก workflow metadata จาก X ciphertext และกำหนด tenant/team isolation
- [ ] ทำ permission checks ฝั่ง server/storage และ UI; ไม่พึ่งการซ่อนปุ่มเป็น authorization
- [ ] ทำ draft/approval states และ immutable audit trail ที่ไม่บันทึก plaintext/key
- [ ] ทำ revocation/offboarding, session termination และ retention/deletion ของสมาชิกที่ออก
- [ ] ทดสอบ unauthorized access ทุก role, cross-team isolation และ audit completeness
- [ ] ทำ privacy/security review เฉพาะ team model ก่อนเปิดใช้จริง

### P8 — Automation อย่างมีรั้วรอบขอบชิด

- [ ] กำหนด use case ที่อนุญาต, recipient allowlist, policy และ owner ของแต่ละ rule
- [ ] เริ่มจาก draft/propose mode; auto-send ต้องเป็น opt-in แยกและผ่าน approval
- [ ] Verify sender/signature ก่อน rule evaluation; dedup signed message ID และ delivery ID
- [ ] ทำ loop prevention, self-message guard, rate limit, quotas, cooldown และ kill switch
- [ ] เก็บ audit: rule version, trigger metadata, approver, outcome โดยไม่เก็บ key/plaintext เกินจำเป็น
- [ ] ทดสอบ malformed/duplicate/out-of-order events, adversarial text, rate limits และ outage recovery
- [ ] ทำ human review queue และ rollback/disable rule แบบทันที
- [ ] ทำ abuse/privacy review ก่อนเปิด auto-send สำหรับแต่ละ use case

### P9 — Release readiness และเปิดใช้

- [x] กำหนด supported platforms/browsers, system requirements และ compatibility matrix
      (Node 20+, desktop Chrome/Edge, 127.0.0.1 secure context, WASM/WebCrypto/
      IndexedDB/`<dialog>`; `npm run test:browser` รัน matrix จริงบน Chrome 158
      และ Edge 155 ที่ 1280×900 + 375×812 — ดู README §Supported browsers)
- [ ] ทำ reproducible build, signed artifacts และ dependency/license/SBOM review
      (ทำแล้วบางส่วน: lockfile ถูก commit และ CI ใช้ `npm ci` บน Node 20/22;
      `npm run build` สองรอบติดกันได้ไฟล์ชุดเดียวกันและ SHA-256 ต่อไฟล์ตรงกัน
      (ตรวจ 2026-11-21); `npm run sbom` สร้าง CycloneDX ของ production deps และ
      CI อัปโหลด artifact; production deps เป็น MIT ทั้งคู่และ transitive notices
      อยู่ใน `THIRD_PARTY_NOTICES.md`; ยังขาด signed/attested artifacts เพราะยัง
      ไม่มี release-signing key หรือช่องทาง publish — ต้องให้ owner ตัดสินก่อน)
- [x] แยก dev/test/prod configuration และ secret stores; ไม่มี production secret ใน build artifact
      (ทำแล้ว: ตาราง env ทั้งหมดอยู่ใน `docs/OPERATIONS.md`; dev=start:mock,
      test=spawn mock PORT=0, prod=`X_CHAT_API_MODE=live` + `X_ACCESS_TOKEN`
      จาก process env เท่านั้น (ไม่รองรับ `.env`); build ใช้ Vite ชุดเดียวกันทุก
      env โดยไม่ define secret และ grep build output ไม่พบ `X_ACCESS_TOKEN`/
      `X_CHAT_LIVE_*` (2026-11-21); token ที่ขาดทำให้ live ปิดแบบ fail-closed)
- [x] ทำ environment setup, migration, backup/restore และ rollback runbook
      (ทำแล้ว: `docs/OPERATIONS.md` ครอบ clean setup, build/SBOM, cache
      export/import/delete, upgrade แบบ `npm ci` + cache envelope version,
      rollback ด้วย git revert + ข้อจำกัด envelope เวอร์ชันใหม่, และ gate
      verification; เหตุ credential/key ยังอ้าง `INCIDENT_RESPONSE.md`)
- [ ] ทำ monitoring, alert, error triage และ incident/on-call ownership โดย redaction เป็นค่าเริ่มต้น
- [ ] ทำ privacy notice, terms/acceptable-use, data deletion path และ support process ตามรูปแบบ deployment
- [ ] ทำ penetration/security review, accessibility review และ performance/reliability test ตาม risk
- [ ] ทำ release candidate UAT: P1–P8 ที่อยู่ในขอบเขตต้องผ่าน พร้อม evidence และ known limitations ที่อนุมัติ
- [x] ตั้ง versioning/changelog/release notes และ upgrade/downgrade compatibility plan
      (ทำแล้ว: `apps/x-chat-web/CHANGELOG.md` เริ่มที่ 0.1.0 (2026-11-21) พร้อม
      known limitations; นโยบาย SemVer 0.x + cache envelope v1 ที่ปฏิเสธเวอร์ชัน
      ที่ไม่รู้จัก, ต้อง export ก่อน upgrade/rollback, และ compatibility matrix
      Node 20+/Chrome-Edge อยู่ใน `OPERATIONS.md`/README)
- [ ] อนุมัติ go/no-go โดย product, security และ operations owners
- [ ] เปิด rollout แบบจำกัดกลุ่มผู้ใช้ที่ยินยอม พร้อม metrics และ rollback threshold
- [ ] ขยาย rollout เมื่อเกณฑ์ reliability/security/support ผ่านตามที่กำหนด

### P10 — หลังเปิดใช้และคำว่า “สมบูรณ์”

- [ ] ทำ post-launch review ของส่ง/รับ/ไฟล์/real-time failures, abuse reports และ support tickets
- [ ] จัดลำดับ backlog จาก evidence ไม่ใช่จากการ bypass crypto/security invariant
- [ ] ทำ periodic dependency, X API contract, OAuth scope, privacy และ threat-model review
- [ ] ทดสอบ disaster recovery, token/key compromise response และ restore อย่างน้อยตามรอบที่กำหนด
- [ ] ดูแล compatibility ของ chat-xdk และ X API ด้วย test matrix ก่อน upgrade ทุกครั้ง
- [x] ปิดช่องว่าง documented known limitations หรือสื่อสารให้ผู้ใช้รับทราบอย่างชัดเจน
      (ทำแล้ว: `apps/x-chat-web/docs/KNOWN_LIMITATIONS.md` เป็นแหล่งเดียวของ
      protocol/product/ops/browser/accessibility limits และลิงก์จาก README,
      USER_GUIDE_TH, CHANGELOG; ในแอปมีข้อความข้อจำกัด key rotation ใต้ฟอร์ม
      เปลี่ยนสมาชิก; ข้อจำกัดที่เป็นงาน live/hosted ยังคงถูกติดตามเป็นแผนเดิม)
- [x] จัดทำ final architecture, operations, security และ user documentation ที่ตรงกับระบบที่ deploy
      (ทำแล้วสำหรับระบบที่ deploy จริงตอนนี้ = local Mock slice: `docs/ARCHITECTURE.md`
      (repo), `docs/OPERATIONS.md`, `docs/THREAT_MODEL.md`, `docs/DATA_HANDLING.md`,
      `docs/SECURITY_REVIEW.md`, `docs/ACCESSIBILITY_AUDIT.md`, `docs/API_CONTRACT_AUDIT.md`,
      `docs/INCIDENT_RESPONSE.md`, `docs/DEVELOPER_ONBOARDING.md`, `docs/USER_GUIDE_TH.md`,
      README/CHANGELOG; ถ้าเปลี่ยนเป็น hosted/team/live deployment ต้องเขียนชุดใหม่
      ไม่ใช่ต่อยอดเอกสารนี้)
- [ ] โครงการถือว่า “สมบูรณ์” เมื่อ release scope ทุก phase ที่เลือกไว้ผ่าน, ไม่มี open release blocker,
      เจ้าของรับมอบงานแล้ว และมีแผนดูแล/incident/upgrade หลังเปิดใช้

## สิ่งที่ยังติด (Blocked) — ต้องมีคน/บัญชี/การอนุมัติจากเจ้าของ

1. **ต้องมีบัญชีและสิทธิ์จริง:** P3 ทั้งหมด, P6 LIVE, และการยืนยัน CI บน runner
   (P1) — ต้อง push repo, มี X Developer app ที่ได้ scope, และบัญชีทดสอบ A/B
   ที่ยินยอมทั้งสองฝ่าย
2. **ต้องตัดสินใจระดับองค์กร:** เจ้าของ product/security (P0), use case ที่
   อนุญาต, รูปแบบผลิตภัณฑ์หลัง MVP, license/ช่องทางรายงานช่องโหว่, เลือก
   activity stream หรือ webhook (P5), โมเดลทีม (P7), นโยบาย automation (P8),
   และ go/no-go (P9)
3. **งานเทคนิคที่ยังเดินต่อได้โดยไม่มีบัญชี:** UI restart end-to-end, missing
   history page, contrast/screen-reader, browser matrix, แยก adapter/state
   machine (P2), ออกแบบ local persistence (P4), load/soak test กับ mock (P5)

## 1. เป้าหมายจากการสนทนา

สร้างแอปที่ใช้ X API สำหรับการส่ง รับ และจัดการบทสนทนา โดยใช้ `chat-xdk` สำหรับกุญแจ การเข้ารหัส การถอดรหัส และการตรวจลายเซ็น ผู้ใช้ต้องการความสามารถครบสี่แนวทางในระยะยาว: กล่องข้อความส่วนตัว, กล่องงานทีม, ห้อง/กลุ่มเฉพาะสมาชิก, และระบบตอบกลับอัตโนมัติ **ลำดับหนึ่งคือส่งข้อความ ลิงก์ และภาพใน X Chat ให้ครบวงจร**

แอปนี้เป็นผลิตภัณฑ์ชั้นนอก ไม่ใช่ฟีเจอร์ใหม่ใน `crates/core` หรือ binding ของ SDK และไม่ควรเพิ่ม HTTP client, bot logic หรือฐานข้อมูลเข้าไปใน SDK ตัวอย่างใน `examples/` ใช้เป็น reference ได้ แต่ไม่ถือเป็นตัวแอป production

SQLLens MCP เป็นเครื่องมือฐานข้อมูลแยกต่างหาก อาจใช้ตรวจ schema/ข้อมูลของแอปในอนาคต แต่ไม่อยู่ในเส้นทางส่งข้อความหรือเส้นทางจัดการกุญแจ

## 2. ภาพรวมสถาปัตยกรรม

```text
UI / workflow ของแอป
    ├── X API adapter: OAuth, conversations, events, send, media, webhook/stream
    ├── chat-xdk binding: keys, encrypt/decrypt, sign/verify, file crypto
    └── application store: สถานะงานและ metadata ที่จำเป็น (ไม่เก็บ raw private key)
```

- ขาออก: เลือก conversation → เตรียม/โหลด conversation key → `encryptMessage` → ส่ง payload ด้วย X API
- ขาเข้า: รับ event จาก X API → รวม KeyChange เมื่อโหลดประวัติ → `decryptEvents` หรือ `decryptEvent` → ตรวจ `verified` ก่อนแสดงหรือใช้ใน automation
- ภาพ: เริ่ม media upload เพื่อรับ `media_hash_key` → สร้าง message พร้อม media attachment → เข้ารหัสภาพโดยอ้าง `event_b64` ของ message → upload ciphertext ให้ครบ → ส่ง message → ดึงภาพกลับและถอดด้วย event/key version เดิม
- ลิงก์ระดับแรก: URL ในข้อความธรรมดา; ลิงก์แบบ rich card เป็นงานย่อยเพิ่มเติม เพราะต้องเตรียม descriptor และอาจต้องเข้ารหัส banner/favicon ของการ์ด
- API adapter จัดการ URL path (`A-B`) ส่วนการลงลายเซ็นใช้ conversation ID รูป canonical (`A:B`) ตาม SDK

## 3. เฟสและเกณฑ์ผ่าน

### เฟส 0 — ยืนยันขอบเขตและความพร้อม

1. วางแอปเป้าหมายแยกจาก `crates/` ของ SDK (เริ่มที่ `apps/x-chat-web/`; จะแยก checkout/repo ภายหลังได้); ระบุ web/desktop/mobile และผู้ใช้เริ่มต้นว่าเป็นหนึ่งบัญชีหรือหลายบัญชี
2. ยืนยันสิทธิ์ X Developer app และ OAuth user-context สำหรับบัญชีทดสอบ (`dm.read`, `dm.write`, `tweet.read`, `users.read` และ scopes ที่ endpoint ใช้; ภาพต้องตรวจ `media.write`)
3. ยืนยันวิธีเก็บกุญแจ: secure backup/ปลดล็อกด้วย PIN หรือ protected local blob; ไม่ส่ง PIN, private key, token หรือ blob เข้าแชท/commit/log
4. เลือก binding ภาษาเดียวสำหรับแอปแรก; ใช้ SDK ที่มีอยู่ ไม่ทำ crypto เอง
5. กำหนดบัญชีและห้องทดสอบที่ยินยอมรับข้อความ; ไม่เริ่มส่งจริงก่อนมีผู้รับที่กำหนดชัด

ผ่านเมื่อมี architecture decision สั้น ๆ, ขอบเขต checkout, สิทธิ์ API ที่ตรวจจริง และ test identities ที่ปลอดภัย

### เฟส 1 — MVP ส่งข้อความ ลิงก์ และภาพ (อันดับ 1)

1. เปิด session: import/unlock keys, `setIdentity`, โหลด public signing keys และ conversation keys
2. ส่งและรับข้อความธรรมดาแบบ 1:1 พร้อมตรวจลายเซ็นและ error path
3. ส่ง URL เป็นข้อความธรรมดาและยืนยันว่าผู้รับกดได้; เพิ่ม URL-card preview หลังจาก basic link ผ่านแล้ว โดยทดสอบพฤติกรรมบน X client จริง
4. เลือกภาพ, ตรวจชนิด/ขนาดตามข้อกำหนด X API, คำนวณ encrypted size สำหรับ `total_bytes` ของ upload, สร้าง media attachment ที่ `filesize_bytes` เป็นขนาด plaintext ตาม SDK release ที่แอปติดตั้ง, เข้ารหัสภาพแบบ stream, append/finalize, แล้วส่งข้อความ
5. โหลดข้อความ/ภาพที่ส่งกลับจาก X API, ตรวจลายเซ็น, ดาวน์โหลด ciphertext และถอดภาพกลับ; ใช้ key version ของ message นั้น ไม่ใช่ latest key เสมอ
6. UI แสดงสถานะ `draft → encrypting → uploading → sending → sent/failed`, ป้องกันการส่งซ้ำด้วย message ID/idempotency strategy ของแอป และแจ้ง error โดยไม่เผย key/plaintext ใน log

เกณฑ์ผ่าน: บัญชีทดสอบ A ส่งข้อความ, URL และภาพไปบัญชี B; B เห็นข้อความและภาพ, ตรวจลายเซ็นผ่าน, ภาพที่ดาวน์โหลดถอดกลับตรงกับต้นฉบับ; กรณี signature/key/media ผิดต้องไม่แสดง plaintext หรือรายงานส่งสำเร็จผิด ๆ

### เฟส 2 — กล่องข้อความส่วนตัว

- รายการ conversation, ประวัติแบบ pagination, ข้อความใหม่ผ่าน event history ก่อน แล้วค่อยเพิ่ม webhook/activity stream
- ค้นหา/กรองเฉพาะข้อมูลที่แอปมีสิทธิ์เห็น, แสดงสถานะอ่านและข้อความที่ส่งแล้ว
- ตั้งค่าการเก็บข้อมูล: metadata เท่าที่จำเป็น; หากต้อง cache plaintext ต้องกำหนดอายุ การเข้ารหัสที่พักข้อมูล และการลบ

เกณฑ์ผ่าน: หลัง restart แอป โหลดประวัติและ KeyChange ได้ครบ, ไม่แสดง event ที่ตรวจลายเซ็นไม่ผ่าน, ไม่ทำข้อความซ้ำเมื่อรับ event ซ้ำ

### เฟส 3 — ห้อง/กลุ่มเฉพาะสมาชิก

- สร้างกลุ่ม, แชร์ conversation key ให้สมาชิกที่มีสิทธิ์, ส่งข้อความ/ภาพในกลุ่ม
- เพิ่ม/ลบสมาชิกพร้อม key rotation และทดสอบสิทธิ์อ่านก่อน/หลังการเปลี่ยนสมาชิก
- ไม่อ้างว่า rotation ย้อนกลับไปปกป้องข้อความเก่า: ผู้ที่เคยมีกุญแจเก่ายังอ่านข้อมูลเก่าที่เคยเข้าถึงได้

เกณฑ์ผ่าน: สมาชิกใหม่อ่านข้อความหลังเข้ากลุ่มได้, สมาชิกที่ถูกถอดไม่ถอดข้อความภายใต้ key ใหม่, ประวัติเก่ายังคงเป็นไปตามสิทธิ์และข้อจำกัดของ protocol

### เฟส 4 — กล่องงานทีม

- ออกแบบบทบาท/สิทธิ์ของทีม, assignment, draft, approval, audit trail และนโยบายการเห็น plaintext
- ตัดสินใจให้ชัดว่า crypto อยู่บนอุปกรณ์ของเจ้าของบัญชี หรืออยู่ใน service ที่ทีมได้รับสิทธิ์; **ห้ามแก้ปัญหาโดยแชร์ raw private key ให้สมาชิกทีม**
- แยกข้อมูล workflow ของทีมออกจาก ciphertext ของ X และกำหนด retention

เกณฑ์ผ่าน: ผู้ไม่มีสิทธิ์ไม่เห็น plaintext/key; การอนุมัติและการส่งมี audit trail; การออกจากทีมไม่เหลือสิทธิ์เข้าถึงระบบแอป

### เฟส 5 — Automation

- เริ่มจาก rule ที่จำกัดขอบเขต เช่น ตอบรับข้อความในห้องทดสอบ, สร้าง draft หรือเสนอคำตอบให้คนอนุมัติ
- ตรวจ sender/signature, dedup ด้วย signed message ID, rate limit, loop prevention และ policy สำหรับการส่ง
- เปิด auto-send เฉพาะ use case และบัญชีที่อนุมัติแล้ว; ไม่ส่ง DM แบบสุ่มหรือ mass outreach

เกณฑ์ผ่าน: event ซ้ำไม่ส่งซ้ำ, bot ไม่ตอบตัวเองวน, error ไม่ทำให้ key/plaintext รั่ว และทุกการส่งตรวจสอบย้อนหลังได้

## 4. การตรวจสอบแยกชั้น

- `STATIC_PASS`: โครงสร้าง, API call shape, type checking, lint
- `OFFLINE_PASS`: ใช้ binding จริงทดสอบ encrypt → decrypt, signature verification, media round trip; ไม่ mock SDK
- `MOCK_API_PASS`: adapter และ state machine กับ X API mock; ไม่ถือเป็นการส่งถึง X จริง
- `LIVE_PASS`: บัญชีทดสอบสองฝั่งกับ X API จริง ตรวจข้อความ/URL/ภาพใน client จริง รวมผล upload/download
- `NOT_VERIFIED` หรือ `BLOCKED`: ระบุชัดเมื่อไม่มี toolchain, artifact, OAuth scope หรือบัญชีทดสอบ

ก่อนแก้ core/binding ต้องรักษา parity ทุกภาษาและรัน gate ตาม `AGENTS.md`; งานแอปภายนอกไม่ควรเปลี่ยน wire format ของ SDK

## 5. การตัดสินใจสำหรับต้นแบบและเรื่องที่ยังต้องระบุ

1. UI แรก: เว็บ local-only สำหรับบัญชีเดียว เริ่มใน `apps/x-chat-web/` โดยใช้ JS/WASM binding; ไม่เปลี่ยน SDK core
2. บัญชี X ที่จะใช้ทดสอบมีสิทธิ์ X Chat API และ media upload จริงหรือยัง? ถ้ายัง ให้ทำ offline/mock ก่อนและคง live เป็น `NOT_VERIFIED`
3. ลิงก์ต้องเพียงกดได้ หรือมี rich preview พร้อมภาพ/หัวข้อ? ข้อเสนอ: basic URL ใน MVP, rich card เป็นงานย่อยถัดมา
4. ภาพเป้าหมายเริ่มจาก PNG/JPEG ภาพเดียวต่อข้อความหรือหลายภาพ? ข้อเสนอ: หนึ่งภาพก่อนแล้วค่อยเพิ่มจำนวน
5. กล่องทีมจะให้ใครมีสิทธิ์เห็น plaintext และถือกุญแจ? ต้องตกลงก่อนเฟส 4

## 6. แหล่งอ้างอิง

- Repo: `README.md`, `docs/ARCHITECTURE.md`, `docs/API.md` (Message Encryption, AttachmentDescriptor, Files), `docs/CRYPTO.md` (Known Limitations)
- ตัวอย่างจริง: `examples/README.md`, `examples/python/e2e_live.py`, `examples/python/x_api.py`
- X Chat docs: https://github.com/xdevplatform/docs/blob/main/xchat/introduction.mdx
- X Chat getting started: https://github.com/xdevplatform/docs/blob/main/xchat/getting-started.mdx
- X Chat media: https://github.com/xdevplatform/docs/blob/main/xchat/media.mdx
- X Chat groups: https://github.com/xdevplatform/docs/blob/main/xchat/groups.mdx
- X Chat real-time events: https://github.com/xdevplatform/docs/blob/main/xchat/real-time-events.mdx
