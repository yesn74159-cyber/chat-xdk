import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { base64ToBytes, createChat, encryptedFileSize } from "@xdevplatform/chat-xdk";
import { decryptSupportedImageStream } from "../public/media.mjs";

const vectors = JSON.parse(
  await readFile(new URL("../../../tests/fixtures/sdk_vectors.json", import.meta.url), "utf8"),
);

test("real WASM binding decrypts history, encrypts a link and round-trips an attached image", async () => {
  const chat = await createChat();
  chat.importKeys({
    keys: base64ToBytes(vectors.private_keys_concat_b64),
    signingKeyVersion: vectors.event_recipient_key_version,
  });
  chat.setIdentity({ userId: vectors.event_sender_id, signingKeyVersion: vectors.event_signing_key_version });
  chat.setCacheKeys(true);
  const signingKeys = [
    {
      userId: vectors.event_sender_id,
      publicKeyVersion: vectors.event_signing_key_version,
      publicKey: vectors.signing_public_b64,
      identityPublicKey: vectors.identity_public_b64,
      identityPublicKeySignature: vectors.identity_public_key_signature_b64,
    },
  ];
  chat.setSigningKeys(signingKeys);
  const batch = chat.decryptEvents({ events: [vectors.event_key_change_b64, vectors.event_message_b64] });
  assert.equal(
    batch.events.some((item) => item.event.type === "message" && item.event.verified === true),
    true,
  );

  const link = chat.encryptMessage({ conversationId: vectors.event_conversation_id, text: "See https://example.com" });
  assert.ok(link.encodedMessageCreateEvent);
  assert.ok(link.encodedMessageEventSignature);
  assert.ok(link.messageId);
  assert.ok(link.xdkVersion);
  const openedLink = chat.decryptEvent({
    eventB64: link.eventB64,
    conversationKeys: batch.conversationKeys.keys,
    signingKeys,
  });
  assert.equal(openedLink.content?.text, "See https://example.com");
  assert.equal(openedLink.verified, true);
  const noSigningKeys = await createChat();
  assert.throws(() =>
    noSigningKeys.decryptEvent({
      eventB64: link.eventB64,
      conversationKeys: batch.conversationKeys.keys,
      signingKeys: [],
    }),
  );

  const image = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
  const size = encryptedFileSize(image.length);
  const mediaHashKey = "offline-image";
  const message = chat.encryptMessage({
    conversationId: vectors.event_conversation_id,
    text: "image",
    attachments: [
      {
        attachment_type: "media",
        media_hash_key: mediaHashKey,
        width: 1,
        height: 1,
        filesize_bytes: image.length,
        filename: "one.png",
        media_type: 1,
      },
    ],
  });
  const openedImage = chat.decryptEvent({
    eventB64: message.eventB64,
    conversationKeys: batch.conversationKeys.keys,
    signingKeys,
  });
  assert.equal(openedImage.attachments?.[0]?.filesizeBytes, image.length);
  const ciphertext = chat.encryptFile({ file: image, eventB64: message.eventB64, mediaHashKey });
  assert.equal(ciphertext.length, size);
  const plaintext = chat.decryptFile({
    encrypted: ciphertext,
    eventB64: message.eventB64,
    conversationKeys: batch.conversationKeys.keys,
    mediaHashKey,
  });
  assert.deepEqual(plaintext, image);
  assert.throws(() =>
    chat.decryptFile({
      encrypted: ciphertext,
      eventB64: message.eventB64,
      conversationKeys: batch.conversationKeys.keys,
      mediaHashKey: "wrong-media-hash",
    }),
  );

  const streamEncryptor = chat.fileEncryptor({ eventB64: message.eventB64, mediaHashKey });
  const encryptedChunks = [
    streamEncryptor.push(image.subarray(0, 7)),
    streamEncryptor.push(image.subarray(7)),
    streamEncryptor.finish(),
  ];
  const streamed = Uint8Array.from(encryptedChunks.flatMap((chunk) => [...chunk]));
  assert.equal(streamed.length, size);
  const streamDecryptor = chat.fileDecryptor({
    eventB64: message.eventB64,
    conversationKeys: batch.conversationKeys.keys,
    mediaHashKey,
  });
  const plaintextChunks = [
    streamDecryptor.push(streamed.subarray(0, 11)),
    streamDecryptor.push(streamed.subarray(11)),
    streamDecryptor.finish(),
  ];
  assert.deepEqual(Uint8Array.from(plaintextChunks.flatMap((chunk) => [...chunk])), image);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(streamed.subarray(0, 11));
        controller.enqueue(streamed.subarray(11));
        controller.close();
      },
    }),
  );
  const downloaded = await decryptSupportedImageStream(
    response,
    chat.fileDecryptor({
      eventB64: message.eventB64,
      conversationKeys: batch.conversationKeys.keys,
      mediaHashKey,
    }),
  );
  assert.equal(downloaded.mimeType, "image/png");
  assert.deepEqual(Uint8Array.from(downloaded.plaintextChunks.flatMap((chunk) => [...chunk])), image);
});

test("attachment decryption rejects non PNG/JPEG bytes before finishing the stream", async () => {
  const chat = await createChat();
  chat.importKeys({
    keys: base64ToBytes(vectors.private_keys_concat_b64),
    signingKeyVersion: vectors.event_recipient_key_version,
  });
  chat.setIdentity({ userId: vectors.event_sender_id, signingKeyVersion: vectors.event_signing_key_version });
  chat.setCacheKeys(true);
  chat.setSigningKeys([
    {
      userId: vectors.event_sender_id,
      publicKeyVersion: vectors.event_signing_key_version,
      publicKey: vectors.signing_public_b64,
      identityPublicKey: vectors.identity_public_b64,
      identityPublicKeySignature: vectors.identity_public_key_signature_b64,
    },
  ]);
  const batch = chat.decryptEvents({ events: [vectors.event_key_change_b64, vectors.event_message_b64] });
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
  const mediaHashKey = "offline-gif";
  const message = chat.encryptMessage({
    conversationId: vectors.event_conversation_id,
    text: "gif",
    attachments: [
      {
        attachment_type: "media",
        media_hash_key: mediaHashKey,
        width: 1,
        height: 1,
        filesize_bytes: gif.length,
        filename: "one.gif",
        media_type: 1,
      },
    ],
  });
  const encrypted = chat.encryptFile({ file: gif, eventB64: message.eventB64, mediaHashKey });
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encrypted);
        controller.close();
      },
    }),
  );
  await assert.rejects(
    decryptSupportedImageStream(
      response,
      chat.fileDecryptor({ eventB64: message.eventB64, conversationKeys: batch.conversationKeys.keys, mediaHashKey }),
    ),
    /ไฟล์ชนิดนี้ยังไม่รองรับ/,
  );
});

test("tampered ciphertext and missing key material fail closed", async () => {
  const chat = await createChat();
  chat.importKeys({
    keys: base64ToBytes(vectors.private_keys_concat_b64),
    signingKeyVersion: vectors.event_recipient_key_version,
  });
  chat.setIdentity({ userId: vectors.event_sender_id, signingKeyVersion: vectors.event_signing_key_version });
  chat.setCacheKeys(true);
  const signingKeys = [
    {
      userId: vectors.event_sender_id,
      publicKeyVersion: vectors.event_signing_key_version,
      publicKey: vectors.signing_public_b64,
      identityPublicKey: vectors.identity_public_b64,
      identityPublicKeySignature: vectors.identity_public_key_signature_b64,
    },
  ];
  const batch = chat.decryptEvents({ events: [vectors.event_key_change_b64, vectors.event_message_b64] });
  const conversationKeys = batch.conversationKeys.keys;

  const tampered = base64ToBytes(vectors.event_message_b64);
  const middle = Math.floor(tampered.length / 2);
  tampered[middle] ^= 0xff;
  assert.throws(
    () =>
      chat.decryptEvent({
        eventB64: Buffer.from(tampered).toString("base64"),
        conversationKeys,
        signingKeys,
      }),
    /Signature verification failed/,
  );
  assert.throws(
    () => chat.decryptEvent({ eventB64: vectors.event_message_b64, conversationKeys, signingKeys: [] }),
    /signature/i,
  );
  const keyChangeTampered = base64ToBytes(vectors.event_key_change_b64);
  keyChangeTampered[Math.floor(keyChangeTampered.length / 2)] ^= 0xff;
  const rejected = chat.decryptEvents({
    events: [Buffer.from(keyChangeTampered).toString("base64"), vectors.event_message_b64],
  });
  assert.equal(rejected.events.length, 0);
  assert.deepEqual(rejected.conversationKeys.keys, {});
  assert.deepEqual(Object.keys(rejected.errors).sort(), ["0", "1"]);
});
