export function supportedImageMime(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  if (png) return "image/png";
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return jpeg ? "image/jpeg" : null;
}

function addHeaderBytes(header, chunk) {
  if (header.length >= 8 || !chunk.length) return header;
  const take = Math.min(8 - header.length, chunk.length);
  const next = new Uint8Array(header.length + take);
  next.set(header);
  next.set(chunk.subarray(0, take), header.length);
  return next;
}

/** @param {Response} response @param {{ push: (chunk: Uint8Array) => Uint8Array, finish: () => Uint8Array, free: () => void }} decryptor */
export async function decryptSupportedImageStream(response, decryptor) {
  if (!response.body) throw new Error("ดาวน์โหลด ciphertext ไม่สำเร็จ");
  const reader = response.body.getReader();
  const plaintextChunks = [];
  let header = new Uint8Array();
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const plaintext = decryptor.push(value);
      if (plaintext.length) {
        plaintextChunks.push(plaintext);
        header = addHeaderBytes(header, plaintext);
        if (header.length >= 8 && !supportedImageMime(header)) {
          await reader.cancel().catch(() => {});
          throw new Error("ไฟล์ชนิดนี้ยังไม่รองรับ — แอปถอดได้เฉพาะ PNG/JPEG");
        }
      }
    }
    const finalChunk = decryptor.finish();
    finished = true;
    if (finalChunk.length) {
      plaintextChunks.push(finalChunk);
      header = addHeaderBytes(header, finalChunk);
    }
  } finally {
    reader.releaseLock();
    if (!finished) decryptor.free();
  }
  const mimeType = supportedImageMime(header);
  if (!mimeType) throw new Error("ไฟล์ชนิดนี้ยังไม่รองรับ — แอปถอดได้เฉพาะ PNG/JPEG");
  return { mimeType, plaintextChunks };
}
