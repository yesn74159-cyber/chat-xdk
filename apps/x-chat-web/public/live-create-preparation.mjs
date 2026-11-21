import { isCanonicalDirectConversationId } from "./direct-conversation-id.mjs";

const USER_ID_PATTERN = /^\d{1,19}$/;

export function reconciliationResult(status, detail = "") {
  const parsedStatus = Number(status || 0);
  const code = Number.isFinite(parsedStatus) ? parsedStatus : 0;
  if (code === 408 || code === 409 || code === 429 || code === 0 || code >= 500) {
    return {
      status: "reconcile",
      requiresReconciliation: true,
      automaticRetry: false,
      detail: detail || `HTTP ${code || "unknown"}; reconcile room state before any manual retry`,
    };
  }
  return { status: "failed", requiresReconciliation: false, automaticRetry: false, detail };
}

export function exactRecipientAndCanonicalId(expectedUserId, recipientId, conversationId) {
  if (
    !USER_ID_PATTERN.test(String(expectedUserId ?? "")) ||
    !USER_ID_PATTERN.test(String(recipientId ?? "")) ||
    String(expectedUserId) === String(recipientId) ||
    typeof conversationId !== "string"
  ) {
    return false;
  }
  return isCanonicalDirectConversationId(conversationId, String(expectedUserId), String(recipientId));
}

export function zeroizeLiveCreateKeys(rawKeys) {
  for (const raw of Array.isArray(rawKeys) ? rawKeys : []) {
    if (raw instanceof Uint8Array) raw.fill(0);
  }
}

export function createLiveCreatePreparation({ liveCreateGateEnabled = false } = {}) {
  let duplicateSubmitted = false;

  return {
    async prepare(options = {}) {
      if (liveCreateGateEnabled !== true) {
        zeroizeLiveCreateKeys(options.rawKeys);
        return { status: "disabled", httpStatus: 501, duplicateSubmitted, requiresReconciliation: false };
      }

      const recipientConsent = options.recipientConsentConfirmed === true;
      const finalApproval = options.finalApprovalConfirmed === true;
      if (!recipientConsent || !finalApproval) {
        zeroizeLiveCreateKeys(options.rawKeys);
        return {
          status: "blocked",
          httpStatus: 400,
          duplicateSubmitted,
          requiresReconciliation: false,
          detail: "Recipient consent and separate final approval are both required",
        };
      }

      const expectedUserId = String(options.expectedUserId ?? "");
      const recipientUserId = String(options.recipientUserId ?? "");
      const conversationId = options.conversationId;
      if (!exactRecipientAndCanonicalId(expectedUserId, recipientUserId, conversationId)) {
        zeroizeLiveCreateKeys(options.rawKeys);
        return {
          status: "blocked",
          httpStatus: 400,
          duplicateSubmitted,
          requiresReconciliation: false,
          detail: "Recipient or canonical conversation ID mismatch",
        };
      }

      if (typeof options.revalidateImmediately !== "function" || typeof options.initiateLivePost !== "function") {
        zeroizeLiveCreateKeys(options.rawKeys);
        return { status: "disabled", httpStatus: 501, duplicateSubmitted, requiresReconciliation: false };
      }

      if (duplicateSubmitted) {
        zeroizeLiveCreateKeys(options.rawKeys);
        return { status: "duplicate", httpStatus: 409, duplicateSubmitted, requiresReconciliation: true };
      }

      duplicateSubmitted = true;
      let keyOwnershipTransferred = false;
      try {
        let preview;
        try {
          preview = await options.revalidateImmediately({ expectedUserId, recipientUserId, conversationId });
        } catch (error) {
          return reconciliationResult(error?.status, "Immediate Live Create revalidation failed");
        }

        if (
          !preview ||
          preview.status !== "ready" ||
          preview.oauthUserId !== expectedUserId ||
          preview.recipientUserId !== recipientUserId ||
          preview.conversationId !== conversationId
        ) {
          return {
            status: "blocked",
            httpStatus: 400,
            duplicateSubmitted,
            requiresReconciliation: true,
            detail:
              "Immediate OAuth, recipient, canonical conversation, permission, key, and lookup revalidation was incomplete",
          };
        }

        let result;
        try {
          result = await options.initiateLivePost({ expectedUserId, recipientUserId, conversationId });
        } catch (error) {
          return reconciliationResult(error?.status, "Live POST outcome requires reconciliation");
        }

        const parsedStatus = Number(result?.httpStatus ?? result?.status ?? 0);
        const httpStatus = Number.isFinite(parsedStatus) ? parsedStatus : 0;
        if (httpStatus === 408 || httpStatus === 409 || httpStatus === 429 || httpStatus === 0 || httpStatus >= 500) {
          return reconciliationResult(httpStatus, "Live POST outcome requires reconciliation");
        }
        if (httpStatus < 200 || httpStatus >= 300) {
          return {
            status: "failed",
            httpStatus,
            duplicateSubmitted,
            requiresReconciliation: false,
            automaticRetry: false,
          };
        }
        if (result?.conversationId !== conversationId) {
          return reconciliationResult(0, "Live POST response did not confirm the expected conversation");
        }

        keyOwnershipTransferred = true;
        return { status: "submitted", httpStatus, duplicateSubmitted, result };
      } finally {
        if (!keyOwnershipTransferred) zeroizeLiveCreateKeys(options.rawKeys);
      }
    },
  };
}
