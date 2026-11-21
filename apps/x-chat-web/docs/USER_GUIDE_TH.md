# คู่มือใช้งาน — X Chat Local Inbox

เอกสารนี้พาจาก "เปิดแอปครั้งแรก" ไปจนถึง "ส่งข้อความเข้ารหัสจริง" ทุกคำสั่งใช้
PowerShell และรันในโฟลเดอร์ `apps/x-chat-web`

---

## 1. แอปนี้คืออะไร

- ไคลเอนต์เว็บ **บัญชีเดียว** สำหรับอ่าน/ส่ง DM เข้ารหัสของ X Chat
- การเข้ารหัส/ถอดรหัส/ตรวจลายเซ็นทั้งหมดทำใน **เบราว์เซอร์** ผ่าน WASM ของ `chat-xdk`
- เซิร์ฟเวอร์ Node เป็นเพียงตัว relay บน **127.0.0.1 เท่านั้น** เก็บ `X_ACCESS_TOKEN`
  และส่งต่อ ciphertext — **ไม่เคยเห็น private key, PIN หรือข้อความธรรมดา**
- รองรับ: ข้อความ, URL ในข้อความ, ภาพ PNG/JPEG 1 ภาพต่อข้อความ, กลุ่ม (Mock),
  cache ciphertext ในเครื่อง, draft-first send

**ไม่ใช่:** บริการ hosted, ระบบทีม, ระบบส่งอัตโนมัติ หรือ real-time push

---

## 2. สิ่งที่ต้องมี

| สิ่งที่ต้องมี                  | หมายเหตุ                                                 |
| ------------------------------ | -------------------------------------------------------- |
| Node.js 20+                    | ตรวจด้วย `node -v`                                       |
| Chrome หรือ Edge รุ่นปัจจุบัน  | ต้องรองรับ WebAssembly, WebCrypto, IndexedDB, `<dialog>` |
| `X_ACCESS_TOKEN`               | เฉพาะโหมด Live (user-context token)                      |
| บัญชีทดสอบที่ยินยอมทั้งสองฝ่าย | เฉพาะการทดสอบ Live                                       |

ติดตั้ง dependencies ครั้งแรก:

```powershell
cd C:\Users\ADMIN\OneDrive\chat-xdk\apps\x-chat-web
npm ci
```

---

## 3. เริ่มเร็ว: โหมด Mock (ไม่ต้องมี token)

```powershell
npm run start:mock
```

เปิด `http://127.0.0.1:8787` แล้วทำตามลำดับ:

> ถ้าพอร์ต 8787 ถูกโปรเซสอื่นใช้อยู่ เซิร์ฟเวอร์จะแจ้ง
> `127.0.0.1:8787 is already in use` แล้วจบการทำงาน ให้ตั้งพอร์ตใหม่ก่อนรัน
> (ใช้ได้ทั้ง Mock และ Live):
>
> ```powershell
> $env:PORT = "8788"
> npm run start:mock
> ```
>
> แล้วเปิด `http://127.0.0.1:8788` แทน

1. เปิด **การตั้งค่าและเครื่องมือขั้นสูง** (รูปเฟืองมุมขวา)
2. เลื่อนลงถึง **Developer diagnostics และ Mock tools** → กด **สร้างตัวตน Mock ชั่วคราว**
3. ดูแถบสถานะด้านล่าง จะมีข้อความบอก username ของเพื่อน เช่น `ค้นหา @xxxx เพื่อทดสอบเริ่มแชท`
4. กดปุ่ม **+** (ค้นหาผู้ติดต่อ) → พิมพ์ `@username` ที่ได้ → กดค้นหา
5. เลือกผู้ติดต่อ → ติ๊กยินยอม → กด **ยืนยันเริ่มแชท**
6. พิมพ์ข้อความ → กด **สร้าง draft** → ตรวจ preview → กด **อนุมัติและส่ง**

ข้อความจะถูกเข้ารหัสจริงและถอดกลับมาแสดงพร้อมสถานะ "ตรวจลายเซ็นแล้ว"
แต่ยังอยู่แค่ในหน่วยความจำของ Mock — **ไม่ใช่หลักฐานว่าส่งถึง X จริง**

ข้อมูล Mock หายทั้งหมดเมื่อรีสตาร์ตหน้าเว็บหรือเซิร์ฟเวอร์

---

## 4. โหมด Live: เตรียมตัว

### 4.1 token และ environment

เปิด PowerShell หน้าต่างใหม่ และรันคำสั่งเหล่านี้ในหน้าต่างเดียวกันตลอด:

```powershell
cd C:\Users\ADMIN\OneDrive\chat-xdk\apps\x-chat-web
$env:X_CHAT_API_MODE = "live"
$env:X_ACCESS_TOKEN = Read-Host "X access token"
npm start
```

- `Read-Host` ทำให้ token ไม่ถูกบันทึกลง history ของ shell
- ห้ามสร้าง `.env`, ห้ามใช้ `setx`, ห้ามวาง token ในแชตหรือไฟล์
- เปิด `http://127.0.0.1:8787/api/status` ต้องเห็น `tokenConfigured: true`
  (ค่านี้บอกแค่ว่ามี token ไม่ได้บอกว่า token ใช้ได้)

### 4.2 ถ้าต้องการสร้างห้องใหม่ด้วย Live Create

ต้องตั้ง target ให้ครบ 4 ตัวก่อน `npm start`:

```powershell
$env:X_CHAT_LIVE_OWNER_USER_ID = "<user id ของคุณ>"
$env:X_CHAT_LIVE_OWNER_USERNAME = "<username ของคุณ>"
$env:X_CHAT_LIVE_RECIPIENT_USER_ID = "<user id ผู้รับ>"
$env:X_CHAT_LIVE_RECIPIENT_USERNAME = "<username ผู้รับ>"
```

ถ้าไม่ครบ `/api/status` จะรายงาน `liveCreateTargetConfigured: false` และ
Live Create จะตอบ 501 เสมอ (ปิดโดยเจตนา)

จากนั้นสร้าง permit อายุ 5 นาที (ใช้ได้ครั้งเดียว):

```powershell
$permitDir = Join-Path $env:LOCALAPPDATA 'X Chat'
New-Item -ItemType Directory -Force $permitDir | Out-Null
$expiresAt = [DateTime]::UtcNow.AddMinutes(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
[System.IO.File]::WriteAllText((Join-Path $permitDir 'live-create-permit.json'), (@{ expiresAt = $expiresAt } | ConvertTo-Json -Compress))
```

> ⚠️ เมื่อยิงคำขอสำเร็จ ระบบจะสร้างไฟล์ `live-create-consumed` และห้ามลบเพื่อยิงซ้ำ
> ถ้าผลไม่ชัด ให้ตรวจ history ก่อน การทดสอบรอบใหม่ต้องได้รับอนุมัติใหม่

---

## 5. โหลดกุญแจ (ทำครั้งเดียวต่อ session)

ในแอปมีสองทาง เลือกทางใดทางหนึ่ง:

### ทาง A — PIN unlock ผ่าน Juicebox (แนะนำ)

1. ที่การ์ด **โปรไฟล์บัญชี** กด **ตรวจสอบบัญชี X**
2. หน้ายืนยันบัญชีจะแสดง username — ตรวจว่าเป็นบัญชีที่ต้องการ
3. กรอก **Passcode 4 หลัก** แล้วกด **ปลดล็อกกุญแจเดิม**
4. แอปตรวจว่า identity/signing key ที่กู้คืนมาตรงกับ public-key record
   **เพียงรายการเดียว** ก่อนเปิดใช้งาน

หมายเหตุ: ถ้า realm ของ Juicebox เปลี่ยน หน้าเว็บจะ reload หนึ่งครั้งเพื่อปรับ CSP
ให้กดปุ่มตรวจสอบบัญชีอีกครั้งแล้วค่อยกรอก PIN

### ทาง B — Private key blob

1. เปิด **การตั้งค่าและเครื่องมือขั้นสูง**
2. กาง **ใช้ Private key blob แทน PIN unlock**
3. วาง blob และ signing-key version ที่ลงทะเบียนไว้ → กด **โหลดกุญแจ**
4. ช่องกรอกจะถูกล้างทันทีหลัง import

PIN, blob และข้อมูลกุญแจอยู่ในหน่วยความจำเบราว์เซอร์เท่านั้น ปิดแท็บคือหาย

---

## 6. เปิดบทสนทนา

### 6.1 ห้อง 1:1 ที่มีอยู่แล้ว

1. เปิด **การตั้งค่าและเครื่องมือขั้นสูง**
2. กาง **เปิดบทสนทนาด้วย Conversation ID**
3. ใส่ ID รูปแบบ `A:B` (ตัวเลข user ID สองคน คั่นด้วย `:`)
4. กด **เปิดบทสนทนา**

ต้องมีประวัติ KeyChange ที่เพียงพอ ไม่งั้นจะเปิดไม่ได้ (fail-closed)

### 6.2 สร้างห้องใหม่จากหน้าค้นหาผู้ติดต่อ

1. กดปุ่ม **+** → ค้นหา `@username`
2. เลือกผู้ติดต่อ → ระบบตรวจว่าเป็นแชทเข้ารหัสและยังไม่มีห้องเดิม
3. โหมด Live: กด **Live Preview** → ติ๊กยินยอม → ติ๊กอนุมัติขั้นสุดท้าย →
   กด **Create encrypted chat**

ทุกขั้นมี gate ตรวจบัญชี OAuth, ผู้รับ, กุญแจ, และห้องเดิมซ้ำก่อนยิงคำขอ

---

## 7. ส่งข้อความ / URL / ภาพ

รูปแบบเป็น **draft-first** เสมอ:

1. พิมพ์ข้อความในช่อง **เขียนข้อความ…** (URL ใส่ในข้อความได้เลย)
2. ถ้าต้องการแนบภาพ กด **แนบภาพ** เลือก PNG/JPEG (ไม่เกิน 10 MB)
3. กด **สร้าง draft**
4. ตรวจ preview (ผู้รับ/เนื้อหา/ไฟล์) แล้วกด **อนุมัติและส่ง**

ลำดับสถานะที่เห็น: `encrypting → uploading → sending → sent`
ถ้าผลไม่ชัดเจน ปุ่มจะเปลี่ยนเป็น **ลองส่งซ้ำด้วย ID เดิม** — กดซ้ำได้เลย
ระบบจะตรวจ history หา `message_id` เดิมก่อน ไม่สร้างข้อความซ้ำ

ฝั่งผู้รับจะเห็นข้อความก็ต่อเมื่อถอดรหัสและ **ตรวจลายเซ็นผ่าน** เท่านั้น
event ที่ไม่ผ่านจะแสดงเป็น placeholder สีเตือน ไม่มี plaintext หลุดออกมา

---

## 8. กลุ่ม (Mock)

1. เปิด **การตั้งค่าและเครื่องมือขั้นสูง** → กาง **สร้างแชตกลุ่มแบบเข้ารหัส**
2. ใส่ชื่อกลุ่ม และ user ID สมาชิก (คั่นด้วย comma หรือขึ้นบรรทัดใหม่)
3. กดสร้าง — ระบบตรวจ key binding ของสมาชิกทุกคนก่อน
4. การเปลี่ยนสมาชิกอยู่ในหัวข้อ **เปลี่ยนสมาชิกกลุ่ม (Mock)** และจะ rotate key

ข้อจำกัดที่ต้องรู้: rotation ปกป้องเฉพาะข้อความ**หลัง**เปลี่ยนรายชื่อ สมาชิกที่เคยได้
key เก่ายังอ่านข้อความเก่าที่เคยเข้าถึงได้ ส่วน roster/member ฝั่ง Live ยังไม่ทำ (501)

---

## 9. Local ciphertext cache (ไม่บังคับ)

1. เปิด **จัดการ local ciphertext cache**
2. ใส่ passphrase แล้วกด **ปลดล็อก / สร้าง cache**
3. ใช้ **export / import / ลบ** ตามต้องการ

cache เก็บเฉพาะ ciphertext + metadata ที่เข้ารหัสด้วย AES-GCM
ไม่เก็บ plaintext, private key, PIN, passphrase หรือ token
ถ้าโหลดประวัติจาก X ไม่สำเร็จ หน้าเว็บจะ decrypt จาก cache และแสดงเฉพาะข้อความ
ที่ verify ผ่าน (หลังรีสตาร์ตจะยังว่างจนกว่าจะโหลด signing key ใหม่)

---

## 10. อ่านสถานะและแก้ปัญหา

| อาการ                | ความหมาย                             | ทำอะไรต่อ                                                      |
| -------------------- | ------------------------------------ | -------------------------------------------------------------- |
| `HTTP 401`           | OAuth หมดอายุ/ไม่ถูกต้อง             | กด **ตรวจสอบบัญชี X** ใหม่                                     |
| `HTTP 403`           | สิทธิ์ไม่พอ หรือ key binding ไม่ผ่าน | ตรวจ scope และ public keys ของทั้งสองบัญชี                     |
| `HTTP 429`           | ถูกจำกัดอัตรา                        | รอแล้วลองใหม่ด้วยมือ ไม่มี retry อัตโนมัติ                     |
| `HTTP 501`           | ฟีเจอร์นั้นปิดในโหมดนี้              | Live Create ต้องมี target + permit; group admin เป็น Mock-only |
| `HTTP 503`           | เซิร์ฟเวอร์ยังไม่มี token            | ตั้ง `X_ACCESS_TOKEN` แล้วรีสตาร์ต                             |
| `ตรวจลายเซ็นไม่ผ่าน` | signature/key ไม่ตรง                 | หยุด อย่าเชื่อข้อความนั้น ตรวจ signing key version             |
| `ไม่พบกุญแจ`         | ขาด conversation key/KeyChange       | โหลดประวัติเพิ่ม หรือตรวจว่า key version ถูก                   |
| ปุ่มถูก disable      | preflight ยังไม่ผ่าน                 | อ่านข้อความใต้ปุ่มว่าติดเงื่อนไขใด                             |
| `already in use`     | มีเซิร์ฟเวอร์รันอยู่บนพอร์ตนั้นแล้ว  | ปิดตัวเก่า หรือตั้ง `$env:PORT = "8788"`                       |

---

## 11. กฎความปลอดภัย 7 ข้อ

1. ห้าม commit/log/วาง token, PIN, blob, private key หรือ plaintext ที่ไหนก็ตาม
2. ใช้ `Read-Host` เท่านั้น อย่าใส่ token ใน command line หรือ `.env`
3. เบราว์เซอร์ควรเป็นเครื่องส่วนตัว และปิดแท็บเมื่อเลิกใช้
4. ห้ามลบ `live-create-consumed` เพื่อยิง Live Create ซ้ำ
5. อย่าแสดงข้อความที่ยังไม่ verify ให้ใครถือเป็นข้อมูลจริง
6. ห้ามเปิดพอร์ต 8787 ออกนอกเครื่อง (เซิร์ฟเวอร์ bind แค่ 127.0.0.1)
7. การทดสอบ Live ต้องมีบัญชีที่ยินยอมจริงและบันทึกหลักฐานแบบ redacted

---

## 12. อภิธานศัพท์

- **Conversation key** — กุญแจสมมาตรของห้อง ส่งให้สมาชิกผ่าน ECIES
- **KeyChange** — event ที่ประกาศกุญแจห้องเวอร์ชันใหม่ ต้องประมวลก่อนข้อความที่ใช้มัน
- **Signing key version** — เวอร์ชันกุญแจลายเซ็นของบัญชี ระบุตอน `setIdentity`
- **`message_id`** — ID ที่ลงลายเซ็นแล้วของข้อความ ใช้กันส่งซ้ำ
- **Permit** — ไฟล์อนุมัติชั่วคราวสำหรับ Live Create ครั้งเดียว
- **Fail-closed** — ถ้าตรวจอะไรไม่ได้ ให้ปิดการทำงานแทนการเดา

---

## 13. คำสั่งที่ใช้บ่อย

```powershell
npm run start:mock      # รันโหมด Mock
npm start               # รันโหมด Live (ต้องมี token ใน env)
npm run check           # format + syntax + typecheck
npm test                # offline 104 + mock 20
npm run scan:secrets    # กัน credential หลุด
```

เอกสารที่เกี่ยวข้อง: [README](../README.md), [Live preflight](LIVE_PREFLIGHT.md),
[Threat model](THREAT_MODEL.md), [Data handling](DATA_HANDLING.md),
[Incident response](INCIDENT_RESPONSE.md)
