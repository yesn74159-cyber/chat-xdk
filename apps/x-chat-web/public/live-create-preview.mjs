import {
  isCurrentOAuthIdentity,
  matchesDirectChatRecipient,
  permissionForEncryptedChat,
  resolveExistingDirectConversation,
} from "./contact-lookup.mjs";
import {
  canOpenConversation,
  conversationIdOf,
  conversationTypeOf,
  mapConversationResponse,
} from "./conversation-list.mjs";

function failureReason(error, label) {
  const status = Number(error?.status || 0);
  if (status === 429) return `${label}: HTTP 429 ถูกจำกัดอัตรา; ไม่มีการลองซ้ำอัตโนมัติ`;
  if (status === 408 || status === 0) return `${label}: ตรวจสอบไม่สำเร็จหรือหมดเวลา; ไม่มีการลองซ้ำอัตโนมัติ`;
  return `${label}: ตรวจสอบไม่สำเร็จ${status ? ` (HTTP ${status})` : ""}`;
}

function publicKeysPresent(keys) {
  return Boolean(keys && keys.encryption?.length > 0 && keys.signing?.length > 0);
}

function verifiedConversationRecords(response, authenticatedUserId) {
  const records = Array.isArray(response)
    ? response
    : response && typeof response === "object" && Array.isArray(response.data)
      ? response.data
      : null;
  if (!records) throw new Error("รายการห้องเดิมตอบกลับผิดรูปแบบ");

  const conversations = mapConversationResponse(response, authenticatedUserId);
  if (conversations.length !== records.length) throw new Error("รายการห้องเดิมมีข้อมูลที่ตรวจสอบรูปแบบไม่ได้");
  for (const [index, record] of records.entries()) {
    if (
      conversationTypeOf(record) !== "direct" ||
      !conversationIdOf(record) ||
      !canOpenConversation(conversations[index], authenticatedUserId)
    ) {
      throw new Error("รายการห้องเดิมมีผู้เข้าร่วมหรือ conversation ID ที่ยืนยันไม่ได้");
    }
  }
  return conversations;
}

export async function runLiveCreateReadinessPreview({
  expectedUserId,
  unlockedUserId,
  recipient,
  knownConversations = [],
  getOAuthIdentity,
  lookupRecipient,
  getOwnKeys,
  getRecipientKeys,
  verifyOwnKeyBinding,
  getLocalState,
  isCurrent = () => true,
}) {
  const checks = [
    {
      id: "oauth",
      label: "OAuth identity ตรงกับบัญชีที่ปลดล็อก",
      passed: false,
      reason: "ยังไม่ได้ตรวจสอบ OAuth identity",
    },
    { id: "recipient", label: "Username และ user ID ของผู้รับตรงกัน", passed: false, reason: "ยังไม่ได้ตรวจสอบผู้รับ" },
    { id: "permission", label: "สิทธิ์ผู้รับเป็น encrypted", passed: false, reason: "ยังไม่ได้ตรวจสอบสิทธิ์ผู้รับ" },
    {
      id: "keys",
      label: "ยืนยัน public key identity binding ของทั้งสองบัญชี",
      passed: false,
      reason: "ยังไม่ได้ตรวจสอบ public keys",
    },
    { id: "lookup", label: "ตรวจรายการห้องสนทนาครบถ้วน", passed: false, reason: "ยังไม่ได้ตรวจรายการห้อง" },
    { id: "existing", label: "ไม่พบห้อง 1:1 เดิม", passed: false, reason: "ยังไม่ได้ตรวจห้องเดิม" },
    {
      id: "consent",
      label: "ผู้ใช้เลือกยืนยันความยินยอมอย่างชัดเจน",
      passed: false,
      reason: "ยังไม่ได้ตรวจความยินยอม",
    },
    {
      id: "localState",
      label: "ไม่มี send, draft หรือ blocked retry ค้างอยู่",
      passed: false,
      reason: "ยังไม่ได้ตรวจสถานะในเครื่อง",
    },
  ];
  const setCheck = (id, passed, reason) => {
    const check = checks.find((entry) => entry.id === id);
    check.passed = passed;
    check.reason = reason;
  };

  let oauthUserId = "";
  try {
    const identity = await getOAuthIdentity();
    oauthUserId = String(identity?.id ?? "");
    const matched = isCurrentOAuthIdentity(expectedUserId, oauthUserId, unlockedUserId);
    setCheck(
      "oauth",
      matched,
      matched ? "ยืนยัน OAuth identity ตรงกับบัญชีที่ปลดล็อกแล้ว" : "OAuth identity ไม่ตรงกับบัญชีที่ปลดล็อก",
    );
  } catch (error) {
    setCheck("oauth", false, failureReason(error, "ตรวจ OAuth identity ไม่สำเร็จ"));
  }

  const stopIfStale = () => {
    if (isCurrent()) return false;
    for (const check of checks) {
      if (!check.passed) check.reason = "การตรวจถูกยกเลิกเพราะปิดหน้าต่างหรือเปลี่ยนผู้รับ";
    }
    return true;
  };

  if (stopIfStale()) return { status: "blocked", checks, oauthUserId };
  if (!checks[0].passed) {
    const reason = "หยุดตรวจรายการเครือข่ายเพราะยืนยัน OAuth identity ไม่ได้";
    setCheck("recipient", false, reason);
    setCheck("permission", false, reason);
    setCheck("keys", false, reason);
    setCheck("lookup", false, reason);
    setCheck("existing", false, reason);
  } else {
    let data = null;
    try {
      data = await lookupRecipient(recipient?.username);
      const user = data?.user;
      const matches =
        String(data?.authenticated_user_id ?? "") === expectedUserId && matchesDirectChatRecipient(recipient, user);
      setCheck(
        "recipient",
        matches,
        matches
          ? "Username, user ID และบัญชี OAuth จากผลค้นหาตรงกัน"
          : "Username, user ID หรือบัญชี OAuth จากผลค้นหาไม่ตรงกัน",
      );
      const permission = permissionForEncryptedChat(user?.receives_your_chat);
      setCheck(
        "permission",
        matches && permission === "encrypted",
        matches
          ? permission === "encrypted"
            ? "X รายงานสิทธิ์ผู้รับเป็น encrypted"
            : `สิทธิ์ผู้รับเป็น ${permission}; ต้องเป็น encrypted เท่านั้น`
          : "หยุดตรวจสิทธิ์เพราะยืนยันผู้รับไม่ได้",
      );
      const lookupStatus = data?.conversation_lookup;
      const lookupComplete = ["available", "existing", "ambiguous"].includes(lookupStatus);
      setCheck(
        "lookup",
        lookupComplete,
        lookupComplete
          ? lookupStatus === "available"
            ? "การค้นหารายการห้องเดิมครบถ้วนและรายงาน available"
            : `การค้นหารายการห้องเดิมครบถ้วนและรายงาน ${lookupStatus}`
          : lookupStatus === "incomplete"
            ? "รายการห้องเดิมยังไม่ครบ จึงหยุดแบบ fail-closed"
            : lookupStatus === "error"
              ? "เกิดข้อผิดพลาดขณะตรวจรายการห้องเดิม"
              : "สถานะความครบถ้วนของรายการห้องไม่ทราบ",
      );
      const conversations = verifiedConversationRecords(data?.conversations, expectedUserId);
      const existing = resolveExistingDirectConversation(
        conversations,
        knownConversations,
        expectedUserId,
        String(recipient?.id ?? ""),
        lookupStatus === "available" ? "existing" : lookupStatus,
      );
      const notFound = lookupStatus === "available" && existing.status === "not_found";
      setCheck(
        "existing",
        notFound,
        notFound
          ? "ตรวจครบถ้วนแล้วและไม่พบห้อง 1:1 เดิม"
          : existing.status === "found"
            ? "พบห้อง 1:1 เดิม; ไม่พร้อมเริ่มห้องใหม่"
            : existing.status === "ambiguous"
              ? "พบห้องเดิมหลายรายการ; หยุดเพื่อป้องกันการสร้างซ้ำ"
              : lookupStatus === "available"
                ? "ยังยืนยันว่าไม่มีห้องเดิมไม่ได้"
                : "ผลสถานะ lookup ไม่ตรงกับรายการห้อง; หยุดแบบ fail-closed",
      );
    } catch (error) {
      const reason = failureReason(error, "ตรวจผู้รับและรายการห้องไม่สำเร็จ");
      setCheck("recipient", false, reason);
      setCheck("permission", false, "หยุดตรวจสิทธิ์เพราะผลค้นหาผู้รับไม่สมบูรณ์");
      setCheck("lookup", false, reason);
      setCheck("existing", false, "ยังยืนยันว่าไม่มีห้องเดิมไม่ได้");
    }

    if (stopIfStale()) return { status: "blocked", checks, oauthUserId };
    if (!checks[1].passed) {
      setCheck("keys", false, "หยุดตรวจ public keys เพราะยืนยันผู้รับไม่ได้");
    } else {
      try {
        const ownKeys = await getOwnKeys(expectedUserId);
        if (!publicKeysPresent(ownKeys) || !verifyOwnKeyBinding(ownKeys, expectedUserId)) {
          throw new Error("key binding ไม่ผ่าน");
        }
        if (stopIfStale()) return { status: "blocked", checks, oauthUserId };
        const recipientKeys = await getRecipientKeys(String(recipient.id));
        const validRecipientKeys = publicKeysPresent(recipientKeys);
        setCheck(
          "keys",
          validRecipientKeys,
          validRecipientKeys
            ? "ตรวจลายเซ็น identity binding และ public keys ของทั้งสองบัญชีแล้ว"
            : "public keys ของผู้รับไม่ครบ; ยืนยัน identity binding ไม่ได้",
        );
      } catch (error) {
        setCheck("keys", false, failureReason(error, "ยืนยัน public key identity binding ไม่สำเร็จ"));
      }
    }
  }

  if (stopIfStale()) return { status: "blocked", checks, oauthUserId };
  const localState = getLocalState();
  setCheck(
    "consent",
    localState.consentChecked === true,
    localState.consentChecked === true ? "เลือกยืนยันความยินยอมแล้ว" : "ยังไม่ได้เลือกยืนยันความยินยอม",
  );
  const clear = !localState.pendingSend && !localState.draft && localState.retryBlocked !== true;
  setCheck(
    "localState",
    clear,
    clear
      ? "ไม่มี pending send, draft หรือ blocked retry"
      : [
          localState.pendingSend && "มี pending send ค้างอยู่",
          localState.draft && "มี draft ค้างอยู่",
          localState.retryBlocked === true && "มี blocked retry",
        ]
          .filter(Boolean)
          .join("; "),
  );

  return {
    status: checks.every((check) => check.passed) ? "ready" : "blocked",
    checks,
    oauthUserId,
  };
}
