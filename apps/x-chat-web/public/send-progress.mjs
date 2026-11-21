const labels = Object.freeze({
  idle: "รอเลือกบทสนทนา",
  draft: "พร้อมร่างข้อความ",
  encrypting: "กำลังเข้ารหัสในเบราว์เซอร์",
  uploading: "กำลังอัปโหลด ciphertext",
  sending: "กำลังส่งข้อความที่ลงลายเซ็นแล้ว",
  sent: "ส่งสำเร็จ",
  failed: "ส่งไม่สำเร็จ",
  unknown: "ยังยืนยันผลการส่งไม่ได้",
});

export function sendPhaseLabel(phase) {
  return labels[phase] || labels.idle;
}
