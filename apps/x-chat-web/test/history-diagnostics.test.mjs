import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyApiError,
  classifySdkError,
  formatHistoryDiagnostics,
  historyDiagnostics,
  httpFailureCategory,
  httpStatusFromError,
} from "../public/history-diagnostics.mjs";

test("SDK errors are reduced to safe categories without retaining messages", () => {
  assert.equal(classifySdkError("signature missing or no matching signing key"), "signing_key_resolution_ambiguous");
  assert.equal(classifySdkError("invalid conversation key version"), "invalid_key_version");
  assert.equal(classifySdkError("ECDSA signature verification failed"), "signature_verification");
  assert.equal(classifySdkError("unrecognized private diagnostic"), "other");
});

test("API errors are reduced to stable categories", () => {
  assert.equal(
    classifyApiError({ type: "https://api.x.com/2/problems/not-authorized-for-field", title: "Not authorized" }),
    "authorization",
  );
  assert.equal(classifyApiError({ type: "https://api.x.com/2/problems/dm-rate-limited" }), "rate_limited");
  assert.equal(classifyApiError({ type: "https://api.x.com/2/problems/resource-not-found" }), "not_found");
});

test("history summary reports ambiguous SDK errors and redacted event metadata", () => {
  const diagnostics = historyDiagnostics({
    httpStatus: 200,
    response: {
      data: [{ encoded_event: "ciphertext-1" }, { id: "unencrypted" }],
      errors: [{ type: "https://api.x.com/2/problems/field-unauthorized" }],
      meta: { conversation_key_events: ["key-change-ciphertext"] },
    },
    signingKeys: [{ userId: "user-a", publicKeyVersion: "1" }],
    verifiedSigningKeyCount: 1,
    result: {
      errors: { 0: "signature missing or no matching signing key" },
      conversationKeys: { keys: { 7: new Uint8Array(32) } },
    },
    eventMetadata: [
      {
        EMBEDDED_SIGNATURE_PRESENT: true,
        EMBEDDED_KEY_VERSION_PRESENT: true,
        SENDER_MATCH: true,
        SIGNING_KEY_VERSION_MATCH: false,
        EVENT_TYPE: "message_create",
        KEYCHANGE_PRESENT: false,
        PARSER_STATUS: "ok",
      },
    ],
    verifiedMessageCount: 0,
  });

  assert.deepEqual(
    {
      httpStatus: diagnostics.httpStatus,
      apiErrorCount: diagnostics.apiErrorCount,
      rawEventCount: diagnostics.rawEventCount,
      encodedEventCount: diagnostics.encodedEventCount,
      keyChangeEventCount: diagnostics.keyChangeEventCount,
      signingKeyRecordCount: diagnostics.signingKeyRecordCount,
      verifiedSigningKeyCount: diagnostics.verifiedSigningKeyCount,
      ambiguousSigningKeyErrors: diagnostics.sdkErrorCategories.signing_key_resolution_ambiguous,
      sdkErrorCount: diagnostics.sdkErrorCount,
      extractedConversationKeyCount: diagnostics.extractedConversationKeyCount,
      verifiedMessageCount: diagnostics.verifiedMessageCount,
    },
    {
      httpStatus: 200,
      apiErrorCount: 1,
      rawEventCount: 2,
      encodedEventCount: 1,
      keyChangeEventCount: 1,
      signingKeyRecordCount: 1,
      verifiedSigningKeyCount: 1,
      ambiguousSigningKeyErrors: 1,
      sdkErrorCount: 1,
      extractedConversationKeyCount: 1,
      verifiedMessageCount: 0,
    },
  );

  const summary = formatHistoryDiagnostics(diagnostics);
  assert.match(summary, /HTTP=200/);
  assert.match(summary, /SDK=1\[signing_key_resolution_ambiguous:1\]/);
  assert.match(summary, /SIGNING_KEY_VERSION_MATCH=false:1/);
  assert.match(summary, /EVENT_TYPE=message_create:1/);
  assert.doesNotMatch(summary, /MISSING_KEY_VERSIONS|missing_signing_key_version/);
  assert.doesNotMatch(summary, /ciphertext|key-change|user-a|private diagnostic/i);
});

test("HTTP failures have safe categories and status extraction", () => {
  assert.equal(httpStatusFromError(new Error("X API returned HTTP 403")), 403);
  assert.equal(httpFailureCategory(403), "authorization");
  assert.equal(httpFailureCategory(429), "rate_limited");
  assert.equal(httpFailureCategory(503), "upstream");
  assert.equal(httpStatusFromError(new Error("network unavailable")), null);
});
