import assert from "node:assert/strict";
import test from "node:test";
import { sendPhaseLabel } from "../public/send-progress.mjs";

test("send progress exposes each user-visible state and defaults safely", () => {
  assert.equal(sendPhaseLabel("draft"), "พร้อมร่างข้อความ");
  assert.equal(sendPhaseLabel("encrypting"), "กำลังเข้ารหัสในเบราว์เซอร์");
  assert.equal(sendPhaseLabel("uploading"), "กำลังอัปโหลด ciphertext");
  assert.equal(sendPhaseLabel("sending"), "กำลังส่งข้อความที่ลงลายเซ็นแล้ว");
  assert.equal(sendPhaseLabel("sent"), "ส่งสำเร็จ");
  assert.equal(sendPhaseLabel("failed"), "ส่งไม่สำเร็จ");
  assert.equal(sendPhaseLabel("unknown"), "ยังยืนยันผลการส่งไม่ได้");
  assert.equal(sendPhaseLabel("not-a-phase"), "รอเลือกบทสนทนา");
});
