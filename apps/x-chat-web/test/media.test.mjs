import assert from "node:assert/strict";
import test from "node:test";
import { supportedImageMime } from "../public/media.mjs";

test("supported image MIME requires PNG or JPEG magic bytes", () => {
  assert.equal(supportedImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(supportedImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(supportedImageMime(new Uint8Array([0x3c, 0x73, 0x76, 0x67])), null);
  assert.equal(supportedImageMime(new Uint8Array([0x89, 0x50, 0x4e])), null);
});
