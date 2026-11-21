const SDK_CATEGORIES = [
  "key_binding_verification",
  "signing_key_resolution_ambiguous",
  "missing_conversation_key_version",
  "invalid_key_version",
  "signature_verification",
  "decryption",
  "parse",
  "invalid_input",
  "other",
];

export function classifySdkError(error) {
  const message = String(typeof error === "string" ? error : error?.kind || "").toLowerCase();
  if (/key binding|identity.*signing/.test(message)) return "key_binding_verification";
  if (/no matching signing key|missing signing key|signing key.*(missing|not found)/.test(message)) {
    return "signing_key_resolution_ambiguous";
  }
  if (/invalid.*key.?version|key.?version.*invalid/.test(message)) return "invalid_key_version";
  if (/conversation.?key|key.?version/.test(message) && /(missing|not found|unknown|unavailable)/.test(message)) {
    return "missing_conversation_key_version";
  }
  if (/signature|verification|verify/.test(message)) return "signature_verification";
  if (/decrypt|ciphertext|authentication/.test(message)) return "decryption";
  if (/parse|decode|malformed|thrift/.test(message)) return "parse";
  if (/invalid input|invalid event/.test(message)) return "invalid_input";
  return "other";
}

export function classifyApiError(error) {
  const marker = `${error?.type || ""} ${error?.title || ""}`.toLowerCase();
  if (/not-authorized|unauthorized|forbidden|field-unauthorized|scope/.test(marker)) return "authorization";
  if (/rate-limit|rate limit|too-many-requests/.test(marker)) return "rate_limited";
  if (/invalid-request|bad-request/.test(marker)) return "invalid_request";
  if (/not-found/.test(marker)) return "not_found";
  if (/unavailable|internal-error|server-error/.test(marker)) return "upstream";
  return "other";
}

function categoryCounts(values, classify) {
  const counts = {};
  for (const value of values) {
    const category = classify(value);
    counts[category] = (counts[category] || 0) + 1;
  }
  return counts;
}

function arraysFromResponse(response) {
  const events = Array.isArray(response?.data) ? response.data : [];
  const keyEvents = response?.meta?.conversationKeyEvents ?? response?.meta?.conversation_key_events ?? [];
  const apiErrors = Array.isArray(response?.errors) ? response.errors : [];
  return { events, keyEvents: Array.isArray(keyEvents) ? keyEvents : [], apiErrors };
}

function formatMetadataCounts(metadata, field) {
  const counts = categoryCounts(metadata, (entry) => {
    const value = entry?.[field];
    return value === null || value === undefined ? "unknown" : String(value);
  });
  return formatCategories(counts);
}

/**
 * @param {{ httpStatus?: number, response?: any, additionalApiErrors?: any[], signingKeys?: any[], verifiedSigningKeyCount?: number, eventMetadata?: any[], result?: { errors?: Record<string, string>, conversationKeys?: { keys?: Record<string, unknown> } }, verifiedMessageCount?: number }} options
 */
export function historyDiagnostics({
  httpStatus,
  response,
  additionalApiErrors = [],
  signingKeys = [],
  verifiedSigningKeyCount = 0,
  eventMetadata = [],
  result = {},
  verifiedMessageCount = 0,
}) {
  const { events, keyEvents, apiErrors } = arraysFromResponse(response);
  const allApiErrors = [...apiErrors, ...additionalApiErrors];
  const sdkErrors = Object.values(result.errors || {});
  const sdkErrorCategories = categoryCounts(sdkErrors, classifySdkError);

  return {
    httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
    apiErrorCount: allApiErrors.length,
    apiErrorCategories: categoryCounts(allApiErrors, classifyApiError),
    rawEventCount: events.length,
    encodedEventCount: events.filter((event) => Boolean(event?.encodedEvent ?? event?.encoded_event)).length,
    keyChangeEventCount: keyEvents.length,
    signingKeyRecordCount: signingKeys.length,
    verifiedSigningKeyCount,
    eventMetadata,
    sdkErrorCount: sdkErrors.length,
    sdkErrorCategories,
    extractedConversationKeyCount: Object.keys(result.conversationKeys?.keys || {}).length,
    verifiedMessageCount,
  };
}

function formatCategories(counts) {
  const entries = Object.entries(counts || {}).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([category, count]) => `${category}:${count}`).join(",") : "none";
}

export function formatHistoryDiagnostics(diagnostics) {
  const lines = [
    `HTTP=${diagnostics.httpStatus ?? "unknown"}`,
    `API=${diagnostics.apiErrorCount}[${formatCategories(diagnostics.apiErrorCategories)}]`,
    `RAW=${diagnostics.rawEventCount}`,
    `ENCODED=${diagnostics.encodedEventCount}`,
    `KEYCHANGE=${diagnostics.keyChangeEventCount}`,
    `SIGNING_KEYS=${diagnostics.signingKeyRecordCount}`,
    `VERIFIED_SIGNING_KEYS=${diagnostics.verifiedSigningKeyCount}`,
    `SDK=${diagnostics.sdkErrorCount}[${formatCategories(diagnostics.sdkErrorCategories)}]`,
    `CONVERSATION_KEYS=${diagnostics.extractedConversationKeyCount}`,
    `VERIFIED_MESSAGES=${diagnostics.verifiedMessageCount}`,
  ];
  if (diagnostics.eventMetadata?.length) {
    for (const field of [
      "EMBEDDED_SIGNATURE_PRESENT",
      "EMBEDDED_KEY_VERSION_PRESENT",
      "SENDER_MATCH",
      "SIGNING_KEY_VERSION_MATCH",
      "EVENT_TYPE",
      "KEYCHANGE_PRESENT",
      "PARSER_STATUS",
    ]) {
      lines.push(`${field}=${formatMetadataCounts(diagnostics.eventMetadata, field)}`);
    }
  }
  return lines.join(" | ");
}

export function httpFailureCategory(status) {
  if (status === 401 || status === 403) return "authorization";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (Number.isInteger(status) && status >= 500) return "upstream";
  return "other";
}

export function httpStatusFromError(error) {
  const match = String(error?.message || "").match(/HTTP\s+(\d{3})/i);
  return match ? Number(match[1]) : null;
}

export function sdkErrorCategories() {
  return [...SDK_CATEGORIES];
}
