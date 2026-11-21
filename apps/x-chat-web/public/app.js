async function startLiveDirectChat() {
  const contact = state.newChatContact;
  const simulation = state.mode === "mock" && state.liveCreateSimulationEnabled;
  const ownerUserId = String(state.myId ?? "");
  const recipientUserId = String(contact?.user?.id ?? "");
  const conversationId =
    /^\d{1,19}$/.test(ownerUserId) && /^\d{1,19}$/.test(recipientUserId) && ownerUserId !== recipientUserId
      ? canonicalDirectConversationId(ownerUserId, recipientUserId)
      : "";
  const preview = state.livePreviewResult;
  if (
    state.startingDirectChat ||
    !contact ||
    (state.mode !== "live" && !simulation) ||
    !state.chat ||
    !state.keyVersion ||
    !el("contact-live-consent").checked ||
    !el("contact-live-final-approval").checked ||
    preview?.status !== "ready" ||
    preview.oauthUserId !== ownerUserId ||
    preview.recipientUserId !== recipientUserId ||
    preview.conversationId !== conversationId
  ) {
    setContactLookupStatus("ต้องตรวจ readiness และยืนยันผู้รับกับการอนุมัติขั้นสุดท้ายก่อน", "error");
    return;
  }
  if (state.pendingSend || state.draft) {
    setContactLookupStatus("มีข้อความหรือ draft ค้างอยู่; ส่งซ้ำหรือล้างก่อนเริ่มแชท", "error");
    return;
  }

  const requestId = ++state.directChatEpoch;
  const chat = state.chat;
  const attempt = (state.liveCreatePreparation ??= createLiveCreatePreparation({ liveCreateGateEnabled: true }));
  if (!claimDirectChatAttempt(state)) return;
  state.liveCreateAttemptUsed = true;
  el("contact-search").disabled = true;
  el("contact-username").disabled = true;
  el("new-chat-close").disabled = true;
  renderContactResults();
  setContactLookupStatus("กำลังตรวจบัญชี ผู้รับ กุญแจ และห้องเดิมอีกครั้ง…", "loading");

  let prepared = null;
  let postError = null;
  const rawKeys = [];
  const isCurrent = () =>
    requestId === state.directChatEpoch &&
    state.newChatContact === contact &&
    state.chat === chat &&
    String(state.myId ?? "") === ownerUserId;

  async function openVerifiedExisting() {
    const recheck = await freshDirectChatPreflight(contact, ownerUserId);
    if (!isCurrent()) throw new Error("บัญชีหรือผู้รับเปลี่ยนระหว่างตรวจผลการสร้างห้อง");
    if (recheck.existing.status !== "found") return false;
    const existing = recheck.existing.conversation;
    state.conversations = [
      existing,
      ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationIdOf(existing)),
    ];
    renderConversationList();
    closeNewChat();
    await openConversation(existing);
    return true;
  }

  try {
    const result = await attempt.prepare({
      expectedUserId: ownerUserId,
      recipientUserId,
      conversationId,
      recipientConsentConfirmed: true,
      finalApprovalConfirmed: true,
      rawKeys,
      revalidateImmediately: async () => {
        const fresh = await runLiveCreateReadinessPreview({
          expectedUserId: ownerUserId,
          unlockedUserId: state.myId,
          recipient: contact.user,
          knownConversations: state.conversations,
          getOAuthIdentity: async () => getData(await gateway.me()),
          lookupRecipient: async (username) => (await gateway.lookupContact(username))?.data,
          getOwnKeys: trustedPublicKeysFor,
          getRecipientKeys: trustedPublicKeysFor,
          verifyOwnKeyBinding: (publicKeys) => unlockedIdentityBindingMatches(publicKeys),
          getLocalState: () => ({
            consentChecked: el("contact-live-consent").checked,
            pendingSend: Boolean(state.pendingSend),
            draft: Boolean(state.draft),
            retryBlocked: contact.retryBlocked === true,
          }),
          isCurrent,
        });
        if (!isCurrent() || fresh.status !== "ready") {
          return { ...fresh, recipientUserId, conversationId };
        }

        await assertCurrentOAuthIdentity(ownerUserId);
        const ownKeys = await trustedPublicKeysFor(ownerUserId);
        verifyUnlockedIdentity(ownKeys, ownerUserId);
        const recipientKeys = await trustedPublicKeysFor(recipientUserId);
        if (!isCurrent()) throw new Error("บัญชีหรือผู้รับเปลี่ยนก่อนสร้างห้อง");
        prepared = prepareDirectConversationChange(
          chat,
          [...ownKeys.encryption, ...recipientKeys.encryption],
          ownerUserId,
          recipientUserId,
        );
        if (prepared.conversationId !== conversationId) {
          zeroizePreparedDirectChat(prepared);
          prepared = null;
          throw new Error("canonical conversation ID เปลี่ยนจากผล readiness");
        }
        rawKeys.push(prepared.conversationKey);
        return { ...fresh, recipientUserId, conversationId };
      },
      initiateLivePost: async () => {
        if (!isCurrent() || !prepared) throw new Error("ยกเลิกการสร้างห้องก่อนส่งคำขอ");
        if (!el("contact-live-consent").checked || !el("contact-live-final-approval").checked) {
          throw Object.assign(new Error("การอนุมัติขั้นสุดท้ายถูกยกเลิกก่อนส่งคำขอ"), { status: 400 });
        }
        await assertCurrentOAuthIdentity(ownerUserId);
        const payload = {
          owner_user_id: ownerUserId,
          owner_signing_key_version: String(state.keyVersion),
          recipient_user_id: recipientUserId,
          recipient_username: normalizeUsername(contact.user.username),
          recipient_consent_confirmed: true,
          final_approval_confirmed: true,
          conversation_id: prepared.conversationId,
          request_body: prepared.requestBody,
        };
        try {
          const response = simulation
            ? await gateway.simulateLiveCreate(payload)
            : await gateway.initializeConversation(payload);
          const acknowledgement = validateDirectConversationInitialization(
            response,
            conversationId,
            ownerUserId,
            recipientUserId,
          );
          return { httpStatus: 200, conversationId: acknowledgement.conversation_id, result: acknowledgement };
        } catch (error) {
          postError = error;
          throw error;
        }
      },
    });

    if (result.status === "submitted" && prepared) {
      const conversation = conversationFromContact(contact, conversationId, prepared.conversationKeyVersion);
      state.conversations = [
        conversation,
        ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationId),
      ];
      renderConversationList();
      const key = prepared.conversationKey;
      const keyVersion = prepared.conversationKeyVersion;
      prepared = null;
      closeNewChat();
      await openConversation(conversation, { conversationId, key, keyVersion });
      activity(simulation ? "Simulated Live Create opened the encrypted room" : "Encrypted room created and opened");
      return;
    }

    if (prepared) {
      zeroizePreparedDirectChat(prepared);
      prepared = null;
    }
    if (result.status === "reconcile" || result.status === "blocked") {
      if (await openVerifiedExisting()) return;
      contact.retryBlocked = result.status === "reconcile" || result.requiresReconciliation === true;
      renderContactResults();
      if (result.status === "reconcile") {
        setContactLookupStatus(
          "ผลการสร้างห้องยังไม่แน่ชัด; ตรวจ GET ล่าสุดแล้ว ไม่ลอง POST ซ้ำอัตโนมัติ กดค้นหาผู้รับใหม่ก่อนดำเนินการอีกครั้ง",
          "error",
        );
      } else {
        setContactLookupStatus(result.detail || "ผล readiness เปลี่ยนไป; ตรวจทุก gate ก่อนลองใหม่", "error");
      }
      return;
    }
    if (result.status === "duplicate") {
      setContactLookupStatus("คำขอนี้ถูกล็อกแล้ว; ค้นหาผู้รับใหม่เพื่อเริ่มการตรวจครั้งใหม่", "error");
      return;
    }
    const status = Number(postError?.status || 0);
    setContactLookupStatus(
      status === 501
        ? "Live Create ถูกปิดใช้งานโดยเซิร์ฟเวอร์ (HTTP 501); ไม่มีการส่งคำขอไปยัง X"
        : status === 401
          ? "OAuth ไม่ได้รับอนุญาตหรือหมดอายุ; กรุณายืนยันบัญชีใหม่"
          : status === 403
            ? "X ปฏิเสธสิทธิ์หรือ key binding ไม่ผ่าน"
            : postError?.message || result.detail || "Live Create ไม่สำเร็จ",
      "error",
    );
  } catch (error) {
    if (prepared) zeroizePreparedDirectChat(prepared);
    const status = Number(error?.status || 0);
    setContactLookupStatus(
      status === 501
        ? "Live Create ถูกปิดใช้งานโดยเซิร์ฟเวอร์ (HTTP 501); ไม่มีการส่งคำขอไปยัง X"
        : error?.message || "Live Create ไม่สำเร็จ",
      "error",
    );
  } finally {
    state.startingDirectChat = false;
    el("contact-search").disabled = false;
    el("contact-username").disabled = false;
    el("new-chat-close").disabled = false;
    if (state.newChatContact === contact) renderContactResults();
  }
}

import { createChat, base64ToBytes, bytesToBase64, encryptedFileSize } from "@xdevplatform/chat-xdk";
import {
  canOpenConversation,
  conversationIdOf,
  conversationTypeOf,
  mapConversationResponse,
  verifiedRecipientId,
} from "/conversation-list.mjs";
import {
  canConfirmDirectChat,
  claimDirectChatAttempt,
  createLookupEpoch,
  isCurrentOAuthIdentity,
  matchesDirectChatRecipient,
  normalizeUsername,
  permissionForEncryptedChat,
  requiresExplicitDirectLookup,
  resolveExistingDirectConversation,
  zeroizePreparedDirectChat,
} from "/contact-lookup.mjs";
import { createLiveCreatePreparation } from "/live-create-preparation.mjs";
import { runLiveCreateReadinessPreview } from "/live-create-preview.mjs";
import {
  isCanonicalDirectConversationId,
  prepareDirectConversationChange,
  validateDirectConversationInitialization,
} from "/conversation-key-plan.mjs";
import { canonicalDirectConversationId } from "/direct-conversation-id.mjs";
import { appendLinkedText } from "/links.mjs";
import { decryptSupportedImageStream, supportedImageMime } from "/media.mjs";
import { pendingSendFromPayload, retainPendingSend } from "/send-state.mjs";
import {
  claimRenderableEvent,
  claimUnverifiedEvent,
  classifyUnverifiedEvent,
  isKnownUnsignedEvent,
  missingConversationKey,
  unverifiedEventPlaceholder,
} from "/event-state.mjs";
import { sendPhaseLabel } from "/send-progress.mjs";
import { isConfirmedMessage } from "/reconcile.mjs";
import { groupCreateRequest, groupMemberIds } from "/group-create.mjs";
import { groupMembersAddRequest, groupMembersRemoveRequest } from "/group-members.mjs";
import { createGateway } from "/gateway.mjs";
import { lookupContactsWithLimit, parseContactUsernames } from "/multi-contact-lookup.mjs";
import {
  cacheDocument,
  createCacheStore,
  decryptCacheDocument,
  encryptCacheDocument,
  validateCacheEnvelope,
} from "/cache-vault.mjs";
import { createCacheSync } from "/cache-sync.mjs";
import { approveDraft, createDraft, discardDraft, toDraftAudit } from "/draft-queue.mjs";
import { realmTokensFromConfig, unlockExistingIdentity } from "/pin-unlock.mjs";
import { inspectEventMetadata } from "/event-metadata.mjs";
import {
  formatHistoryDiagnostics,
  historyDiagnostics,
  httpFailureCategory,
  httpStatusFromError,
} from "/history-diagnostics.mjs";
import { signingKeyRecords } from "/signing-key-records.mjs";

const el = (id) => document.getElementById(id);
const cacheSync = createCacheSync();
const state = {
  chat: null,
  myId: "",
  conversationId: "",
  currentConversation: null,
  keyVersion: "",
  keys: {},
  signingKeys: new Map(),
  missingSigningKeys: new Set(),
  shown: new Set(),
  shownUnverifiedEvents: new Set(),
  knownUnsignedEvents: new Set(),
  busy: false,
  pendingSend: null,
  mode: "",
  nextPageToken: null,
  seenPageTokens: new Set(),
  loadingPage: false,
  sendPhase: "idle",
  activeConversationKey: null,
  activeConversationKeyVersion: "",
  groupMemberIds: [],
  groupAdminIds: [],
  groupTitle: "",
  mockPeerId: "",
  conversations: [],
  conversationFilter: "all",
  cachedEvents: {},
  deliveryIds: new Set(),
  audits: [],
  cachePassphrase: "",
  cacheStore: null,
  cacheStale: false,
  cacheWatchStarted: false,
  draft: null,
  draftFile: null,
  deliveryCursor: "0",
  juiceboxConfig: "",
  juiceboxAccount: null,
  juiceboxRecords: [],
  realmTokens: null,
  pinPrepared: false,
  unlockBusy: false,
  newChatContact: null,
  contactResults: [],
  startingDirectChat: false,
  livePreviewBusy: false,
  livePreviewResult: null,
  liveCreatePreparation: null,
  liveCreateAttemptUsed: false,
  liveCreateSimulationEnabled: false,
  directChatEpoch: 0,
};
const FILE_READ_BYTES = 256 * 1024;
const UPLOAD_PART_BYTES = 3 * 1024 * 1024;
const gateway = createGateway();
const contactLookupEpoch = createLookupEpoch();

function activity(message) {
  el("activity").textContent = message;
}
function setSendPhase(phase) {
  state.sendPhase = phase;
  el("send-state").dataset.phase = phase;
  el("send-state").textContent = sendPhaseLabel(phase);
}
function getData(response) {
  return response?.data ?? response;
}

function cacheSummary() {
  return cacheDocument({
    conversations: state.conversations,
    events: state.cachedEvents,
    deliveryIds: [...state.deliveryIds],
    audits: state.audits,
  });
}

async function saveCache() {
  // Never write from a stale tab: another tab's newer document would be lost.
  if (!state.cacheStore || !state.cachePassphrase || state.cacheStale) return;
  const envelope = await encryptCacheDocument(cacheSummary(), state.cachePassphrase);
  await state.cacheStore.save(envelope);
  cacheSync.announce();
}

function markCacheStale() {
  state.cacheStale = true;
  el("cache-status").textContent = "มีแท็บอื่นบันทึก cache; ปลดล็อกด้วย passphrase อีกครั้งก่อนบันทึกทับ";
  activity("แท็บอื่นแก้ไข local cache — หยุดบันทึกอัตโนมัติจนกว่าจะปลดล็อกใหม่");
}

function watchCacheChanges() {
  if (state.cacheWatchStarted) return;
  state.cacheWatchStarted = true;
  cacheSync.onChange(markCacheStale);
}

function unreadOf(conversation) {
  return Number(conversation.unread ?? 0) || 0;
}

function updateChatHeader(conversation = state.currentConversation, groupTitle = state.groupTitle) {
  const type = conversationTypeOf(conversation);
  const recipientId = verifiedRecipientId(conversation, state.myId);
  const name = conversation?.self_conversation
    ? "แชทกับตัวเอง"
    : type === "group"
      ? groupTitle || "กลุ่ม"
      : conversation?.recipient_name || (recipientId ? "ผู้ติดต่อ" : groupTitle || "ยังไม่เลือกบทสนทนา");
  const username =
    type === "direct" && conversation?.recipient_username
      ? `@${conversation.recipient_username}`
      : type === "group" || groupTitle
        ? "กลุ่มเข้ารหัส"
        : "";
  const avatar = el("chat-avatar");
  avatar.replaceChildren();
  if (conversation?.recipient_profile_image_url && type === "direct") {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.src = conversation.recipient_profile_image_url;
    avatar.append(image);
  } else {
    avatar.textContent = name.slice(0, 1).toUpperCase();
  }
  el("conversation-title").textContent = name;
  el("conversation-username").textContent = username;
  el("conversation-username").hidden = !username;
}

function setMobileView(view) {
  el("workspace-layout").dataset.mobileView = view;
}

function setAccountDisplay(account = null, unlocked = false) {
  const name = String(account?.name || "").trim();
  const username = String(account?.username || "").trim();
  const accountName = name || (username ? `@${username}` : "บัญชีที่ปลดล็อกแล้ว");
  const accountHandle = username ? `@${username}` : "กุญแจพร้อมใช้งาน";
  el("account-avatar").textContent = accountName.slice(0, 1).toUpperCase();
  el("account-compact-avatar").textContent = accountName.slice(0, 1).toUpperCase();
  el("account-display-name").textContent = accountName;
  el("account-username").textContent = accountHandle;
  if (account?.id) {
    el("pin-account").textContent = `${name ? `${name} · ` : ""}${username ? `@${username}` : `ID ${account.id}`}${
      unlocked ? " · กุญแจปลดล็อกแล้ว" : " · ยืนยันโดย X API"
    }`;
  } else if (unlocked) {
    el("pin-account").textContent = "กุญแจในเบราว์เซอร์พร้อมใช้งาน";
  }
  if (unlocked) {
    el("account-unlock-controls").hidden = true;
    el("account-compact").hidden = false;
  }
}

function renderConversationList() {
  const list = el("conversation-list");
  list.replaceChildren();
  if (!state.conversations.length) {
    const placeholder = document.createElement("div");
    placeholder.className = "list-placeholder";
    placeholder.textContent = "โหลดรายการบทสนทนาเพื่อเริ่มต้น";
    list.append(placeholder);
    return;
  }
  const search = el("conversation-search").value.trim().toLocaleLowerCase();
  let visibleCount = 0;
  for (const conversation of state.conversations) {
    const id = conversationIdOf(conversation);
    const type = conversationTypeOf(conversation);
    const recipientId = verifiedRecipientId(conversation, state.myId);
    const recipientName = conversation.recipient_name || (recipientId ? "ผู้ติดต่อ" : "ผู้เข้าร่วมยังไม่ยืนยัน");
    const recipientLabel = conversation.recipient_username
      ? `${recipientName} @${conversation.recipient_username}`
      : recipientName;
    const unread = unreadOf(conversation) > 0;
    const matchesFilter =
      state.conversationFilter === "all" ||
      (state.conversationFilter === "unread" && unread) ||
      (state.conversationFilter === "direct" && type === "direct") ||
      (state.conversationFilter === "group" && type === "group");
    const searchText = `${recipientLabel} ${type} ${id}`.toLocaleLowerCase();
    if (!matchesFilter || (search && !searchText.includes(search))) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    button.disabled = !canOpenConversation(conversation, state.myId);
    button.dataset.active = String(id === state.conversationId);
    button.dataset.kind = type || "unknown";
    button.title = button.disabled
      ? "ยังเปิดห้องนี้ไม่ได้จากข้อมูลผู้เข้าร่วมที่ตรวจสอบได้"
      : "เปิดบทสนทนาที่ตรวจสอบผู้เข้าร่วมแล้ว";
    const label = conversation.self_conversation
      ? "แชทกับตัวเอง"
      : type === "group"
        ? "กลุ่ม"
        : type === "direct"
          ? recipientLabel
          : "ไม่ทราบประเภท";
    const copy = document.createElement("span");
    copy.className = "conversation-copy";
    const name = document.createElement("span");
    name.className = "conversation-name";
    name.textContent = type === "direct" ? recipientName : label;
    const username = document.createElement("span");
    username.className = "conversation-username";
    username.textContent =
      type === "direct" && conversation.recipient_username ? `@${conversation.recipient_username}` : "";
    username.hidden = !username.textContent;
    const preview = document.createElement("span");
    preview.className = "conversation-preview";
    preview.textContent = unread ? "มีข้อความยังไม่อ่าน" : type === "group" ? "กลุ่ม" : "บทสนทนาส่วนตัว";
    copy.append(name, username, preview);

    if (conversation.recipient_profile_image_url) {
      const avatar = document.createElement("img");
      avatar.className = "conversation-avatar";
      avatar.alt = "";
      avatar.loading = "lazy";
      avatar.referrerPolicy = "no-referrer";
      avatar.src = conversation.recipient_profile_image_url;
      button.append(avatar);
    } else {
      const avatar = document.createElement("span");
      avatar.className = "conversation-avatar-fallback";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = label.slice(0, 1).toUpperCase();
      button.append(avatar);
    }
    button.append(copy);
    if (unread) {
      const indicator = document.createElement("span");
      indicator.className = "unread-indicator";
      indicator.setAttribute("aria-label", "ยังไม่อ่าน");
      button.append(indicator);
    }
    button.addEventListener("click", () => {
      if (!canOpenConversation(conversation, state.myId) || id === state.conversationId) return;
      el("conversation-id").value = id;
      el("connect").click();
    });
    list.append(button);
    visibleCount += 1;
  }
  if (!visibleCount) {
    const empty = document.createElement("div");
    empty.className = "list-empty";
    empty.textContent =
      search || state.conversationFilter !== "all" ? "ไม่พบบทสนทนาที่ตรงกับตัวกรอง" : "ยังไม่มีบทสนทนา";
    list.append(empty);
  }
}

async function loadConversations() {
  const response = await gateway.conversations();
  state.conversations = mapConversationResponse(response, state.myId);
  renderConversationList();
  await saveCache();
}

function contactPermissionLabel(permission) {
  if (permission === "encrypted")
    return "สิทธิ์ข้อความเข้ารหัส: X API รายงานว่า encrypted (Closed Inbox/ข้อจำกัด X อาจยังปฏิเสธได้)";
  if (permission === "unencrypted") return "สิทธิ์ข้อความ: X API รายงานว่า unencrypted; แอปรองรับเฉพาะข้อความเข้ารหัส";
  if (permission === "none") return "สิทธิ์ข้อความ: X API รายงานว่า none";
  return "สิทธิ์ข้อความ: ไม่ทราบ";
}

function setContactLookupStatus(message, phase = "idle") {
  const status = el("contact-lookup-status");
  status.dataset.phase = phase;
  status.textContent = message;
}

function stopContactLookup() {
  contactLookupEpoch.invalidate();
  el("contact-search").disabled = false;
  el("contact-username").disabled = state.startingDirectChat;
  if (el("contact-lookup-status").dataset.phase === "loading") {
    setContactLookupStatus("ค้นหาครั้งก่อนถูกยกเลิก; กดค้นหาหรือ Enter อีกครั้ง", "idle");
  }
}

function existingRoomLabel(contact) {
  if (contact.existing.status === "found") return "สถานะห้องเดิม: พบบทสนทนา 1:1 ที่ยืนยันผู้เข้าร่วมแล้ว";
  if (contact.existing.status === "ambiguous") return "สถานะห้องเดิม: พบหลายห้องที่ตรงกัน จึงหยุดเพื่อป้องกันห้องซ้ำ";
  if (contact.conversationLookup === "error") {
    const failure = contact.conversationError;
    return `ตรวจรายการห้องเดิมไม่สำเร็จ (${failure?.category || "upstream"}, HTTP ${failure?.status || "?"})`;
  }
  if (contact.conversationLookup === "incomplete") return "รายการห้องเดิมยังไม่ครบ จึงยืนยันว่าไม่มีห้องเดิมไม่ได้";
  if (contact.conversationLookup !== "available") return "สถานะห้องเดิม: ไม่ทราบหรือยังยืนยันผู้เข้าร่วมไม่ได้";
  return "สถานะห้องเดิม: ไม่พบห้อง 1:1 ที่ตรงกัน";
}

function keyBindingLabel(contact) {
  if (contact.keyStatus === "verified") return "Public keys: ตรวจ key binding ของบัญชีทั้งสองแล้ว";
  if (contact.keyStatus === "error") return `Public keys: ${contact.keyError}`;
  if (contact.keyStatus === "locked") return "Public keys: ปลดล็อกกุญแจเดิมก่อนตรวจสอบผู้รับ";
  if (contact.keyStatus === "pending") return "Public keys: กำลังตรวจสอบ key binding...";
  return "Public keys: ไม่สามารถยืนยันได้";
}

function renderContactActions() {
  const contact = state.newChatContact;
  const liveCreateAvailable = state.mode === "live" || state.liveCreateSimulationEnabled;
  const preview = state.livePreviewResult;
  const previewMatchesContact =
    preview?.status === "ready" &&
    preview.oauthUserId === String(state.myId ?? "") &&
    preview.recipientUserId === String(contact?.user?.id ?? "") &&
    isCanonicalDirectConversationId(preview.conversationId, String(state.myId ?? ""), String(contact?.user?.id ?? ""));
  el("contact-selection-actions").hidden = !contact;
  el("contact-open-existing").hidden = !contact?.identityVerified || contact.existing.status !== "found";
  el("contact-live-preview").hidden = !contact || !liveCreateAvailable;
  el("contact-live-preview-button").disabled = state.livePreviewBusy || state.startingDirectChat || !contact;
  el("contact-live-preview-button").textContent = state.livePreviewBusy ? "กำลังตรวจสอบ…" : "Live Preview";
  el("contact-live-consent").disabled = state.startingDirectChat;
  el("contact-live-final-approval").disabled = state.startingDirectChat;
  el("contact-live-create-summary").hidden = !previewMatchesContact;
  el("contact-live-create-summary").textContent = previewMatchesContact
    ? `ผู้รับ @${contact.user.username} (${contact.user.id}) · บัญชี ${state.myId} · ห้อง ${preview.conversationId}`
    : "";
  el("contact-live-create-button").hidden = !contact || !liveCreateAvailable;
  el("contact-live-create-button").disabled =
    state.livePreviewBusy ||
    state.startingDirectChat ||
    state.liveCreateAttemptUsed ||
    !previewMatchesContact ||
    !el("contact-live-consent").checked ||
    !el("contact-live-final-approval").checked;
  el("contact-live-create-button").textContent =
    state.mode === "mock" ? "Simulate Live Create" : "Create encrypted chat";
  const canStart = canConfirmDirectChat(contact, state.mode, Boolean(state.chat && state.keyVersion), true);
  el("contact-start-confirmation").hidden = !canStart;
  el("contact-start-chat").disabled = state.startingDirectChat || !canStart || !el("contact-start-consent").checked;
  el("contact-start-chat").textContent = state.startingDirectChat ? "กำลังตรวจสอบ…" : "ยืนยันเริ่มแชท";
  if (canStart) {
    el("contact-start-confirmation-summary").textContent =
      `ยืนยันบัญชี @${contact.user.username} แล้ว · X รายงาน receives_your_chat = encrypted · ` +
      "ตรวจ key binding ของทั้งสองบัญชีแล้ว · ตรวจรายการห้องเดิมครบถ้วนและไม่พบห้อง 1:1 · ยังไม่มีการส่งข้อความ";
  }
}

function renderLivePreviewResult(preview) {
  const list = el("contact-live-preview-results");
  list.replaceChildren();
  for (const check of preview?.checks ?? []) {
    const row = document.createElement("li");
    row.className = `live-preview-check ${check.passed ? "is-passed" : "is-blocked"}`;
    const label = document.createElement("strong");
    label.textContent = check.label;
    const reason = document.createElement("span");
    reason.textContent = check.reason;
    row.append(label, reason);
    list.append(row);
  }
  const status = el("contact-live-preview-status");
  if (!preview) {
    status.dataset.phase = "idle";
    status.textContent = "ยังไม่มีผลการตรวจ";
    return;
  }
  status.dataset.phase = preview.status === "ready" ? "success" : "error";
  status.textContent =
    preview.status === "ready"
      ? "ผ่านทุกเงื่อนไขของ Live Preview แบบอ่านอย่างเดียว; ยังไม่มีการสร้างห้องหรือส่งข้อความ"
      : "ไม่พร้อมสำหรับ Live Preview; ตรวจเหตุผลที่ไม่ผ่านก่อนดำเนินการใด ๆ";
}

async function previewLiveCreateReadiness() {
  const contact = state.newChatContact;
  const mode = state.mode;
  if (state.livePreviewBusy || (mode !== "live" && !state.liveCreateSimulationEnabled) || !contact) return;
  el("contact-live-final-approval").checked = false;
  const requestId = ++state.directChatEpoch;
  const chat = state.chat;
  const expectedUserId = String(state.myId ?? "");
  const isCurrent = () =>
    requestId === state.directChatEpoch &&
    state.mode === mode &&
    state.newChatContact === contact &&
    state.chat === chat;

  state.livePreviewBusy = true;
  state.livePreviewResult = null;
  renderLivePreviewResult(null);
  renderContactActions();
  setContactLookupStatus("กำลังตรวจ Live readiness ตามคำสั่ง; ไม่มีการสร้างห้องหรือส่งข้อความ", "loading");
  try {
    const preview = await runLiveCreateReadinessPreview({
      expectedUserId,
      unlockedUserId: state.myId,
      recipient: contact.user,
      knownConversations: state.conversations,
      getOAuthIdentity: async () => getData(await gateway.me()),
      lookupRecipient: async (username) => (await gateway.lookupContact(username))?.data,
      getOwnKeys: trustedPublicKeysFor,
      getRecipientKeys: trustedPublicKeysFor,
      verifyOwnKeyBinding: (publicKeys) => unlockedIdentityBindingMatches(publicKeys),
      getLocalState: () => ({
        consentChecked: el("contact-live-consent").checked,
        pendingSend: Boolean(state.pendingSend),
        draft: Boolean(state.draft),
        retryBlocked: contact.retryBlocked === true,
      }),
      isCurrent,
    });
    if (!isCurrent()) return;
    const boundPreview = {
      ...preview,
      recipientUserId: String(contact.user.id),
      conversationId: canonicalDirectConversationId(expectedUserId, String(contact.user.id)),
    };
    state.livePreviewResult = boundPreview;
    renderLivePreviewResult(boundPreview);
    setContactLookupStatus(
      boundPreview.status === "ready" ? "Live readiness preview ผ่านทุก gate" : "Live readiness preview ถูกบล็อก",
      boundPreview.status === "ready" ? "success" : "error",
    );
  } catch (error) {
    if (!isCurrent()) return;
    const status = Number(error?.status || 0);
    const reason =
      status === 429
        ? "HTTP 429 ถูกจำกัดอัตรา; ไม่มีการลองซ้ำอัตโนมัติ กด Live Preview ใหม่เมื่อพร้อม"
        : status === 408 || status === 0
          ? "ตรวจสอบไม่สำเร็จหรือหมดเวลา; ไม่มีการลองซ้ำอัตโนมัติ"
          : `Live Preview ตรวจสอบไม่สำเร็จ${status ? ` (HTTP ${status})` : ""}`;
    renderLivePreviewResult(null);
    el("contact-live-preview-status").dataset.phase = "error";
    el("contact-live-preview-status").textContent = reason;
    setContactLookupStatus(reason, "error");
  } finally {
    if (isCurrent()) {
      state.livePreviewBusy = false;
      renderContactActions();
    }
  }
}

function renderContactResults() {
  const list = el("contact-results-list");
  list.replaceChildren();
  el("contact-results").hidden = state.contactResults.length === 0;
  for (const [index, result] of state.contactResults.entries()) {
    const card = document.createElement("article");
    card.className = "contact-result";
    if (result.contact) {
      const select = document.createElement("label");
      select.className = "contact-result-select";
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "contact-selection";
      radio.value = result.username;
      radio.checked = state.newChatContact === result.contact;
      radio.disabled = state.startingDirectChat;
      radio.addEventListener("change", () => {
        state.directChatEpoch += 1;
        state.livePreviewBusy = false;
        state.livePreviewResult = null;
        state.liveCreatePreparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
        state.liveCreateAttemptUsed = false;
        el("contact-live-final-approval").checked = false;
        renderLivePreviewResult(null);
        state.newChatContact = result.contact;
        renderContactActions();
      });
      const selectText = document.createElement("span");
      selectText.textContent = `เลือก @${result.username}`;
      select.append(radio, selectText);
      card.append(select);
    }

    const profile = document.createElement("div");
    profile.className = "contact-profile";
    const avatar = document.createElement("span");
    avatar.className = "contact-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "contact-profile-copy";
    const name = document.createElement("strong");
    const handle = document.createElement("span");
    const contact = result.contact;
    name.textContent = contact?.user.name || (contact ? `@${result.username}` : "ค้นหาไม่สำเร็จ");
    handle.textContent = `@${result.username}`;
    if (contact?.user.profile_image_url) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.src = contact.user.profile_image_url;
      avatar.append(image);
    } else {
      avatar.textContent = name.textContent.slice(0, 1).toUpperCase();
    }
    copy.append(name, handle);
    profile.append(avatar, copy);
    card.append(profile);

    if (contact) {
      const preflight = document.createElement("div");
      preflight.className = "contact-preflight";
      for (const text of [
        contactPermissionLabel(contact.permission),
        existingRoomLabel(contact),
        keyBindingLabel(contact),
      ]) {
        const row = document.createElement("p");
        row.className = "preflight-row";
        row.textContent = text;
        preflight.append(row);
      }
      card.append(preflight);
    }
    if (result.error) {
      const error = document.createElement("p");
      error.className = "contact-result-error";
      error.textContent = result.error;
      card.append(error);
    }
    list.append(card);
  }
  renderContactActions();
}

function verifyUnlockedIdentity(publicKeys, userId) {
  if (!unlockedIdentityBindingMatches(publicKeys)) {
    throw new Error(`กุญแจที่ปลดล็อกไม่ตรงกับ public key ของบัญชี ${userId}`);
  }
  const matches = publicKeys.signing.filter(
    (key) => key.publicKeyVersion === state.keyVersion && state.chat.matchesRegisteredKey(key.identityPublicKey),
  );
  state.chat.setIdentity({ userId, signingKeyVersion: matches[0].publicKeyVersion });
}

function unlockedIdentityBindingMatches(publicKeys) {
  if (!state.chat || !Array.isArray(publicKeys?.signing)) return false;
  const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let signature;
  try {
    signature = state.chat.sign(challenge);
    const matches = publicKeys.signing.filter(
      (key) =>
        key.publicKeyVersion === state.keyVersion &&
        state.chat.matchesRegisteredKey(key.identityPublicKey) &&
        state.chat.verify(key.publicKey, signature, challenge),
    );
    return matches.length === 1;
  } finally {
    challenge.fill(0);
    signature?.fill(0);
  }
}

function lookupErrorMessage(error, username) {
  const status = Number(error?.status || 0);
  if (status === 404) return `ไม่พบบัญชี @${username}`;
  if (status === 429) return error.message || "HTTP 429: คำขอถูกจำกัดอัตรา; ไม่มีการลองซ้ำอัตโนมัติ";
  return error?.message || `ค้นหา @${username} ไม่สำเร็จ`;
}

async function lookupContactForUsername(username, requestId) {
  const response = await gateway.lookupContact(username);
  if (!contactLookupEpoch.isCurrent(requestId)) return null;
  const data = response?.data;
  const authenticatedUserId = String(data?.authenticated_user_id ?? "");
  const user = data?.user;
  const returnedUsername = typeof user?.username === "string" ? normalizeUsername(user.username) : "";
  if (
    !/^\d{1,19}$/.test(authenticatedUserId) ||
    !user ||
    !/^\d{1,19}$/.test(String(user.id ?? "")) ||
    String(user.id) === authenticatedUserId ||
    returnedUsername !== username
  ) {
    throw new Error("ข้อมูล Username ผู้ติดต่อหรือบัญชีที่ยืนยันไม่ตรงกับคำค้นหา");
  }
  if (state.myId && state.myId !== authenticatedUserId) {
    throw new Error("บัญชี OAuth เปลี่ยนไป กรุณาตรวจสอบบัญชีและปลดล็อกใหม่");
  }
  state.myId = authenticatedUserId;
  let profileImageUrl = "";
  if (typeof user.profile_image_url === "string") {
    try {
      const imageUrl = new URL(user.profile_image_url);
      if (imageUrl.protocol === "https:" && imageUrl.hostname === "pbs.twimg.com") profileImageUrl = imageUrl.href;
    } catch {
      profileImageUrl = "";
    }
  }
  const conversations = mapConversationResponse(data.conversations, authenticatedUserId);
  const matchedConversation = resolveExistingDirectConversation(
    conversations,
    state.conversations,
    authenticatedUserId,
    String(user.id),
    data.conversation_lookup,
  );
  const conversationLookup =
    matchedConversation.status === "found" || matchedConversation.status === "ambiguous"
      ? "existing"
      : ["available", "incomplete", "error"].includes(data.conversation_lookup)
        ? data.conversation_lookup
        : "unknown";
  const contact = {
    user: {
      id: String(user.id),
      name: typeof user.name === "string" ? user.name.trim() : "",
      username: typeof user.username === "string" ? user.username.trim() : username,
      profile_image_url: profileImageUrl,
    },
    permission: permissionForEncryptedChat(user.receives_your_chat),
    conversationLookup,
    conversationError: data.conversation_error,
    existing: matchedConversation,
    identityVerified: false,
    keyStatus: state.chat && state.keyVersion ? "pending" : "locked",
    keyError: "",
    encryptionKeys: [],
    plan: null,
  };
  if (!state.chat || !state.keyVersion) return contact;

  try {
    const ownKeys = await trustedPublicKeysFor(authenticatedUserId);
    if (!contactLookupEpoch.isCurrent(requestId)) return null;
    verifyUnlockedIdentity(ownKeys, authenticatedUserId);
    contact.identityVerified = true;
    contact.encryptionKeys.push(...ownKeys.encryption);
  } catch (error) {
    if (!contactLookupEpoch.isCurrent(requestId)) return null;
    if (Number(error?.status || 0) === 429) throw error;
    contact.keyStatus = "error";
    contact.keyError = error.message;
    return contact;
  }
  try {
    const recipientKeys = await trustedPublicKeysFor(contact.user.id);
    if (!contactLookupEpoch.isCurrent(requestId)) return null;
    contact.encryptionKeys.push(...recipientKeys.encryption);
    contact.keyStatus = "verified";
  } catch (error) {
    if (!contactLookupEpoch.isCurrent(requestId)) return null;
    if (Number(error?.status || 0) === 429) throw error;
    contact.keyStatus = "error";
    contact.keyError = error.message;
  }
  return contact;
}

async function lookupContact(event) {
  event.preventDefault();
  state.directChatEpoch += 1;
  let usernames;
  try {
    usernames = parseContactUsernames(el("contact-username").value);
  } catch (error) {
    contactLookupEpoch.invalidate();
    state.contactResults = [];
    state.newChatContact = null;
    renderContactResults();
    setContactLookupStatus(error.message, "error");
    return;
  }

  const requestId = contactLookupEpoch.begin();
  el("contact-start-consent").checked = false;
  el("contact-live-consent").checked = false;
  el("contact-live-final-approval").checked = false;
  state.liveCreatePreparation = createLiveCreatePreparation({ liveCreateGateEnabled: true });
  state.liveCreateAttemptUsed = false;
  state.livePreviewBusy = false;
  state.livePreviewResult = null;
  renderLivePreviewResult(null);
  state.contactResults = [];
  state.newChatContact = null;
  renderContactResults();
  el("contact-search").disabled = true;
  el("contact-username").disabled = true;
  setContactLookupStatus(`กำลังค้นหา ${usernames.length} Username และตรวจสอบห้องเดิม…`, "loading");
  try {
    const results = await lookupContactsWithLimit(
      usernames,
      (username) => lookupContactForUsername(username, requestId),
      () => contactLookupEpoch.isCurrent(requestId),
    );
    if (!contactLookupEpoch.isCurrent(requestId)) return;
    state.contactResults = results.map(({ username, contact, error }) => ({
      username,
      contact,
      error: error ? lookupErrorMessage(error, username) : "",
    }));
    if (usernames.length === 1 && state.contactResults[0]?.contact) {
      state.newChatContact = state.contactResults[0].contact;
    }
    renderContactResults();
    const found = state.contactResults.filter((result) => result.contact).length;
    const failed = state.contactResults.length - found;
    const throttled = results.some((result) => Number(result.error?.status || 0) === 429);
    setContactLookupStatus(
      `ค้นหาเสร็จแล้ว: ${found} พบ, ${failed} มีข้อผิดพลาด${throttled ? "; ไม่มีการลองซ้ำหลัง HTTP 429" : ""}`,
      failed ? "error" : "idle",
    );
  } finally {
    if (contactLookupEpoch.isCurrent(requestId)) {
      el("contact-search").disabled = false;
      el("contact-username").disabled = false;
    }
  }
}

function clearUnlockedIdentity() {
  state.chat?.lock?.();
  state.chat = null;
  state.keyVersion = "";
  state.signingKeys.clear();
  state.missingSigningKeys.clear();
  for (const key of Object.values(state.keys)) key?.fill(0);
  state.keys = {};
  state.activeConversationKey?.fill(0);
  state.activeConversationKey = null;
  state.activeConversationKeyVersion = "";
  state.conversationId = "";
  state.currentConversation = null;
  state.conversations = [];
  state.pendingSend = null;
  state.draft = null;
  state.draftFile = null;
  state.juiceboxConfig = "";
  state.juiceboxRecords = [];
  state.juiceboxAccount = null;
  state.mockPeerId = "";
  state.realmTokens?.clear();
  state.realmTokens = null;
  state.pinPrepared = false;
  el("connect").disabled = true;
  el("create-group").disabled = true;
  el("account-unlock-controls").hidden = false;
  el("account-compact").hidden = true;
  el("prepare-juicebox").disabled = false;
  el("unlock-pin").disabled = true;
  el("unlock-key").disabled = true;
  el("message-text").value = "";
  el("message-text").disabled = true;
  el("image-file").value = "";
  el("image-file").disabled = true;
  el("messages").replaceChildren();
  el("refresh").disabled = true;
  el("send").disabled = true;
  el("create-draft").disabled = true;
  el("discard-draft").disabled = true;
  el("pin-account").textContent = "บัญชี OAuth เปลี่ยนแล้ว; ยืนยันและปลดล็อกใหม่";
  renderConversationList();
}

async function assertCurrentOAuthIdentity(expectedUserId) {
  const me = getData(await gateway.me());
  const currentUserId = String(me?.id ?? "");
  if (!/^\d{1,19}$/.test(currentUserId)) throw new Error("ยืนยัน OAuth identity ปัจจุบันไม่ได้");
  if (!isCurrentOAuthIdentity(expectedUserId, currentUserId, state.myId)) {
    clearUnlockedIdentity();
    state.myId = currentUserId;
    throw new Error("บัญชี OAuth เปลี่ยนไป; ล้างกุญแจในหน่วยความจำแล้ว กรุณายืนยันและปลดล็อกใหม่");
  }
  return currentUserId;
}

async function freshDirectChatPreflight(contact, expectedUserId) {
  await assertCurrentOAuthIdentity(expectedUserId);
  const response = await gateway.lookupContact(contact.user.username);
  const data = response?.data;
  const recipient = data?.user;
  if (
    String(data?.authenticated_user_id ?? "") !== expectedUserId ||
    !matchesDirectChatRecipient(contact.user, recipient)
  ) {
    throw new Error("ผลค้นหาผู้รับหรือ OAuth identity เปลี่ยนไป; หยุดก่อนสร้างห้อง");
  }
  const conversations = mapConversationResponse(data.conversations, expectedUserId);
  const existing = resolveExistingDirectConversation(
    conversations,
    state.conversations,
    expectedUserId,
    contact.user.id,
    data.conversation_lookup,
  );
  if (existing.status === "ambiguous") throw new Error("พบห้องเดิมหลายห้อง; หยุดเพื่อป้องกันการสร้างซ้ำ");
  if (existing.status === "found")
    return { existing, permission: permissionForEncryptedChat(recipient.receives_your_chat) };
  if (data.conversation_lookup !== "available") {
    throw new Error("ตรวจรายการห้องเดิมไม่ครบหรือไม่สำเร็จ; จึงไม่อนุญาตให้สร้างห้องใหม่");
  }
  return { existing, permission: permissionForEncryptedChat(recipient.receives_your_chat) };
}

function conversationFromContact(contact, conversationId, keyVersion = "") {
  return {
    id: conversationId,
    type: "direct",
    participant_ids: [state.myId, contact.user.id],
    recipient_id: contact.user.id,
    recipient_verified: true,
    recipient_name: contact.user.name,
    recipient_username: contact.user.username,
    recipient_profile_image_url: contact.user.profile_image_url,
    key_version: keyVersion,
    unread: false,
    updated_at: new Date().toISOString(),
  };
}

function closeNewChat() {
  state.directChatEpoch += 1;
  stopContactLookup();
  el("contact-start-consent").checked = false;
  el("contact-live-consent").checked = false;
  el("contact-live-final-approval").checked = false;
  state.livePreviewBusy = false;
  state.livePreviewResult = null;
  state.liveCreatePreparation = null;
  state.liveCreateAttemptUsed = false;
  renderLivePreviewResult(null);
  state.newChatContact = null;
  state.contactResults = [];
  renderContactResults();
  const dialog = el("new-chat-modal");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

async function startDirectChat() {
  const contact = state.newChatContact;
  if (state.startingDirectChat) return;
  if (
    !canConfirmDirectChat(
      contact,
      state.mode,
      Boolean(state.chat && state.keyVersion),
      el("contact-start-consent").checked,
    )
  ) {
    setContactLookupStatus("Preflight ไม่ผ่าน จึงไม่เริ่มแชท", "error");
    return;
  }
  if (state.pendingSend || state.draft) {
    setContactLookupStatus("มีข้อความหรือ draft ของห้องอื่นค้างอยู่; ส่งซ้ำหรือล้างก่อนเริ่มแชท", "error");
    return;
  }

  const requestId = ++state.directChatEpoch;
  const authenticatedUserId = state.myId;
  const chat = state.chat;
  let prepared = null;
  if (!claimDirectChatAttempt(state)) return;
  el("contact-search").disabled = true;
  el("contact-username").disabled = true;
  el("new-chat-close").disabled = true;
  renderContactResults();
  setContactLookupStatus("กำลังยืนยันบัญชี ผู้รับ และสิทธิ์อีกครั้ง…", "loading");
  try {
    const firstCheck = await freshDirectChatPreflight(contact, authenticatedUserId);
    if (requestId !== state.directChatEpoch) throw new Error("ยกเลิกการเริ่มแชทแล้ว");
    if (firstCheck.existing.status === "found") {
      const existing = firstCheck.existing.conversation;
      state.conversations = [
        existing,
        ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationIdOf(existing)),
      ];
      renderConversationList();
      closeNewChat();
      await openConversation(existing);
      return;
    }
    if (firstCheck.permission !== "encrypted") {
      throw new Error("ผู้รับไม่ได้เปิดรับแชทแบบเข้ารหัส หรือสิทธิ์ inbox ไม่ชัดเจน");
    }
    const ownKeys = await trustedPublicKeysFor(authenticatedUserId);
    if (requestId !== state.directChatEpoch) throw new Error("ยกเลิกการเริ่มแชทแล้ว");
    verifyUnlockedIdentity(ownKeys, authenticatedUserId);
    const recipientKeys = await trustedPublicKeysFor(contact.user.id);
    if (requestId !== state.directChatEpoch) throw new Error("ยกเลิกการเริ่มแชทแล้ว");
    const finalCheck = await freshDirectChatPreflight(contact, authenticatedUserId);
    if (requestId !== state.directChatEpoch || state.chat !== chat)
      throw new Error("ยกเลิกหรือเปลี่ยนบัญชีระหว่างเริ่มแชท");
    if (finalCheck.existing.status === "found") {
      const existing = finalCheck.existing.conversation;
      state.conversations = [
        existing,
        ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationIdOf(existing)),
      ];
      renderConversationList();
      closeNewChat();
      await openConversation(existing);
      return;
    }
    if (finalCheck.permission !== "encrypted") {
      throw new Error("สิทธิ์รับแชทเข้ารหัสเปลี่ยนไป; หยุดก่อนสร้างห้อง");
    }
    const finalOwnKeys = await trustedPublicKeysFor(authenticatedUserId);
    if (requestId !== state.directChatEpoch) throw new Error("ยกเลิกการเริ่มแชทแล้ว");
    verifyUnlockedIdentity(finalOwnKeys, authenticatedUserId);
    const finalRecipientKeys = await trustedPublicKeysFor(contact.user.id);
    if (requestId !== state.directChatEpoch) throw new Error("ยกเลิกการเริ่มแชทแล้ว");
    await assertCurrentOAuthIdentity(authenticatedUserId);
    const publicKeys = [...finalOwnKeys.encryption, ...finalRecipientKeys.encryption];
    prepared = prepareDirectConversationChange(chat, publicKeys, authenticatedUserId, contact.user.id);
    if (!isCanonicalDirectConversationId(prepared.conversationId, authenticatedUserId, contact.user.id)) {
      throw new Error("canonical conversation ID ไม่ตรงกับบัญชีที่ยืนยัน");
    }

    let response;
    try {
      response = validateDirectConversationInitialization(
        await gateway.initializeConversation({
          recipient_user_id: contact.user.id,
          conversation_id: prepared.conversationId,
          request_body: prepared.requestBody,
        }),
        prepared.conversationId,
        authenticatedUserId,
        contact.user.id,
      );
    } catch (error) {
      const status = Number(error.status || 0);
      if (requiresExplicitDirectLookup(status)) {
        contact.retryBlocked = true;
        renderContactResults();
        if (status === 429) throw error;
        const recheck = await freshDirectChatPreflight(contact, authenticatedUserId);
        if (requestId !== state.directChatEpoch || state.chat !== chat) {
          throw new Error("ยกเลิกหรือเปลี่ยนบัญชีระหว่างตรวจผลการเริ่มแชท");
        }
        if (recheck.existing.status === "found") {
          const existing = recheck.existing.conversation;
          const exactMockAcceptance =
            state.mode === "mock" &&
            conversationIdOf(existing) === prepared.conversationId &&
            existing.key_version === prepared.conversationKeyVersion;
          state.conversations = [
            existing,
            ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationIdOf(existing)),
          ];
          renderConversationList();
          if (exactMockAcceptance) {
            const key = prepared.conversationKey;
            const keyVersion = prepared.conversationKeyVersion;
            prepared = null;
            closeNewChat();
            await openConversation(existing, { conversationId: conversationIdOf(existing), key, keyVersion });
          } else {
            zeroizePreparedDirectChat(prepared);
            prepared = null;
            closeNewChat();
            await openConversation(existing);
          }
          return;
        }
        renderContactResults();
        throw new Error(
          "ผลการสร้างห้องยังไม่แน่ชัด; ล็อกการลองซ้ำแล้ว กดค้นหาผู้รับใหม่เพื่อตรวจ identity, keys และห้องเดิมอีกครั้ง",
        );
      }
      throw error;
    }

    const conversationId = response.conversation_id;
    await assertCurrentOAuthIdentity(authenticatedUserId);
    if (requestId !== state.directChatEpoch || state.chat !== chat)
      throw new Error("ยกเลิกหรือเปลี่ยนบัญชีหลังสร้างห้อง");

    const conversation = conversationFromContact(contact, conversationId, prepared.conversationKeyVersion);
    state.conversations = [
      conversation,
      ...state.conversations.filter((entry) => conversationIdOf(entry) !== conversationId),
    ];
    renderConversationList();
    const key = prepared.conversationKey;
    const keyVersion = prepared.conversationKeyVersion;
    prepared = null;
    closeNewChat();
    await openConversation(conversation, { conversationId, key, keyVersion });
    setContactLookupStatus("สร้างห้อง Mock เข้ารหัสแล้ว; เขียนข้อความและกดอนุมัติส่งเมื่อพร้อม", "success");
  } catch (error) {
    zeroizePreparedDirectChat(prepared);
    const status = Number(error.status || 0);
    const detail =
      status === 401
        ? "OAuth ไม่ได้รับอนุญาตหรือหมดอายุ; กรุณายืนยันบัญชีใหม่"
        : status === 403
          ? "X ปฏิเสธสิทธิ์ inbox หรือผู้รับไม่รับแชทเข้ารหัส"
          : status === 409
            ? "พบการสร้างห้องซ้ำ; ตรวจรายการห้องก่อนลองใหม่"
            : status === 429
              ? "คำขอถูกจำกัดอัตรา; รอสักครู่แล้วค้นหาและตรวจสถานะใหม่"
              : error.message;
    setContactLookupStatus(detail, "error");
  } finally {
    state.startingDirectChat = false;
    el("contact-search").disabled = false;
    el("contact-username").disabled = false;
    el("new-chat-close").disabled = false;
    if (state.newChatContact === contact) renderContactResults();
  }
}

function resetDraft({ clearInputs = true } = {}) {
  state.draft = null;
  state.draftFile = null;
  if (clearInputs) {
    el("message-text").value = "";
    el("image-file").value = "";
    el("file-name").textContent = "ไม่มีภาพแนบ";
  }
  el("create-draft").disabled = !state.conversationId;
  el("discard-draft").disabled = true;
  el("send").disabled = true;
  el("send-label").textContent = "อนุมัติและส่ง";
}

async function unlockCache() {
  const passphrase = el("cache-passphrase").value;
  state.cacheStore ??= createCacheStore();
  const envelope = await state.cacheStore.load();
  let document;
  try {
    document = envelope ? await decryptCacheDocument(envelope, passphrase) : cacheDocument();
  } catch (error) {
    throw new Error(
      /at least 12 characters/.test(error?.message ?? "")
        ? "passphrase ต้องยาวอย่างน้อย 12 ตัวอักษร"
        : "ปลดล็อก cache ไม่สำเร็จ: passphrase ไม่ถูกต้องหรือไฟล์เสียหาย",
    );
  }
  state.cachePassphrase = passphrase;
  state.cacheStale = false;
  watchCacheChanges();
  state.conversations = Array.isArray(document.conversations) ? document.conversations : [];
  state.cachedEvents = document.events && typeof document.events === "object" ? document.events : {};
  state.deliveryIds = new Set(Array.isArray(document.deliveryIds) ? document.deliveryIds : []);
  state.audits = Array.isArray(document.audits) ? document.audits : [];
  el("cache-passphrase").value = "";
  el("cache-status").textContent = envelope ? "ปลดล็อก cache แล้ว (อยู่เฉพาะหน้านี้)" : "cache ใหม่พร้อมใช้งาน";
  renderConversationList();
  if (!envelope) await saveCache();
}

async function clearCache() {
  if (!window.confirm("ลบ ciphertext metadata และ audit ในเครื่องทั้งหมดใช่หรือไม่? การลบย้อนกลับไม่ได้")) return;
  state.cacheStore ??= createCacheStore();
  await state.cacheStore.clear();
  state.cachePassphrase = "";
  state.cacheStale = false;
  state.conversations = [];
  state.cachedEvents = {};
  state.deliveryIds.clear();
  state.audits = [];
  renderConversationList();
  cacheSync.announce();
  el("cache-status").textContent = "ลบข้อมูล local แล้ว";
}

async function exportCache() {
  state.cacheStore ??= createCacheStore();
  const envelope = await state.cacheStore.load();
  if (!envelope) throw new Error("ยังไม่มี encrypted cache ให้ export");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([JSON.stringify(envelope)], { type: "application/json" }));
  anchor.download = "x-chat-ciphertext-cache.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

async function importCache(file) {
  if (!file) return;
  let envelope;
  try {
    envelope = validateCacheEnvelope(JSON.parse(await file.text()));
  } catch {
    throw new Error("ไฟล์ cache ไม่ใช่รูปแบบที่รองรับ");
  }
  state.cacheStore ??= createCacheStore();
  await state.cacheStore.save(envelope);
  state.cachePassphrase = "";
  state.cacheStale = false;
  watchCacheChanges();
  cacheSync.announce();
  el("cache-status").textContent = "นำเข้า ciphertext cache แล้ว; ปลดล็อกด้วย passphrase เพื่อใช้งาน";
}

async function syncMockDeliveries() {
  if (state.mode !== "mock") throw new Error("การจำลอง reconnect มีเฉพาะ Mock mode");
  const response = await gateway.deliveries(state.deliveryCursor);
  const deliveries = getData(response);
  const accepted = (Array.isArray(deliveries) ? deliveries : []).filter((entry) => {
    if (!entry.delivery_id || state.deliveryIds.has(entry.delivery_id)) return false;
    state.deliveryIds.add(entry.delivery_id);
    return true;
  });
  state.deliveryCursor = response.meta?.next_cursor ?? state.deliveryCursor;
  await saveCache();
  if (accepted.some((entry) => entry.conversation_id === state.conversationId)) await refresh();
  activity(`sync Mock รับ ${accepted.length} event ใหม่ (duplicate ถูกตัดทิ้ง)`);
}

function messageEncryptionParams(conversationId, text, extra = {}) {
  return {
    conversationId,
    text,
    ...(state.activeConversationKey && state.activeConversationKeyVersion
      ? {
          conversationKey: state.activeConversationKey,
          conversationKeyVersion: state.activeConversationKeyVersion,
        }
      : {}),
    ...extra,
  };
}

const api = (path, options) => gateway.request(path, options);
const post = (path, data) => gateway.post(path, data);

function mediaOf(event) {
  return (event.attachments ?? []).flatMap((item) =>
    item.attachmentType === "media" && item.mediaHashKey
      ? [{ hash: item.mediaHashKey, filename: item.filename || "ภาพ" }]
      : [],
  );
}

async function decryptMediaStream(response, entry, mediaHashKey) {
  const decryptor = state.chat.fileDecryptor({
    eventB64: entry.originalB64,
    conversationKeys: state.keys,
    mediaHashKey,
  });
  const { mimeType, plaintextChunks } = await decryptSupportedImageStream(response, decryptor);
  return new Blob(plaintextChunks, { type: mimeType });
}

function render(entry) {
  const event = entry.event;
  if (!claimRenderableEvent(state.shown, entry)) return;
  el("messages").querySelector(".empty")?.remove();
  const card = document.createElement("article");
  card.className = `message${String(event.senderId) === state.myId ? " mine" : ""}`;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    String(event.senderId) === state.myId ? "คุณ · ตรวจลายเซ็นแล้ว" : `${event.senderId} · ตรวจลายเซ็นแล้ว`;
  const content = document.createElement("div");
  content.className = "content";
  appendLinkedText(document, content, event.content?.text || "");
  card.append(meta, content);
  for (const media of mediaOf(event)) {
    const button = document.createElement("button");
    button.className = "image-action";
    button.textContent = `ถอดและเปิด ${media.filename}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(
          `/api/media/download?conversation_id=${encodeURIComponent(event.conversationId || state.conversationId)}&media_hash_key=${encodeURIComponent(media.hash)}`,
        );
        if (!response.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ: HTTP ${response.status}`);
        const imageBlob = await decryptMediaStream(response, entry, media.hash);
        const image = document.createElement("img");
        image.alt = media.filename;
        image.src = URL.createObjectURL(imageBlob);
        image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
        button.replaceWith(image);
      } catch (error) {
        activity(error.message);
        button.disabled = false;
      }
    });
    card.append(button);
  }
  el("messages").append(card);
}

function unverifiedEventCacheKey(event, eventB64) {
  const eventId = event?.id ?? event?.eventId;
  return `${state.conversationId}\u0000${typeof eventId === "string" && eventId ? eventId : eventB64}`;
}

function renderUnverifiedPlaceholder(event, eventB64, metadata, error) {
  const status = classifyUnverifiedEvent(metadata, error);
  const placeholder = unverifiedEventPlaceholder(status);
  const cacheKey = unverifiedEventCacheKey(event, eventB64);
  if (!claimUnverifiedEvent(state.shownUnverifiedEvents, cacheKey)) return;
  if (status === "unsigned") state.knownUnsignedEvents.add(cacheKey);

  el("messages").querySelector(".empty")?.remove();
  const card = document.createElement("article");
  card.className = "message unverified";
  card.dataset.verification = placeholder.status;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = placeholder.title;
  const content = document.createElement("div");
  content.className = "content";
  content.textContent = placeholder.description;
  card.append(meta, content);
  el("messages").append(card);
}

async function signingKeysFor(events) {
  const apiErrors = [];
  const ids = new Set([state.myId]);
  const participants = state.groupMemberIds.length
    ? state.groupMemberIds
    : state.conversationId.replaceAll("-", ":").split(":");
  if (participants.length === 2 && participants.every((id) => /^\d+$/.test(id))) {
    for (const id of participants) ids.add(id);
  }
  for (const event of events) {
    const id = event.senderId ?? event.sender_id;
    if (id) ids.add(String(id));
  }
  for (const id of ids) {
    if (state.signingKeys.has(id)) continue;
    const response = await api(`/api/public-keys?user_id=${encodeURIComponent(id)}`);
    if (Array.isArray(response?.errors)) apiErrors.push(...response.errors);
    const records = signingKeyRecords(id, response);
    if (!records.length) {
      state.missingSigningKeys.add(id);
      continue;
    }
    state.signingKeys.set(id, records);
  }
  state.chat.setSigningKeys([...state.signingKeys.values()].flat());
  return apiErrors;
}

function publicKeyRecords(userId, response) {
  const records = getData(response);
  const values = Array.isArray(records) ? records : [records];
  if (!values.length) throw new Error(`ไม่พบ public key ของ ${userId}`);
  const signing = [];
  const encryption = [];
  for (const key of values) {
    const publicKeyVersion = String(key.publicKeyVersion ?? key.public_key_version ?? "");
    const identityPublicKey = key.publicKey ?? key.public_key;
    const signingPublicKey = key.signingPublicKey ?? key.signing_public_key;
    const identityPublicKeySignature = key.identityPublicKeySignature ?? key.identity_public_key_signature;
    if (!publicKeyVersion || !identityPublicKey || !signingPublicKey || !identityPublicKeySignature) {
      throw new Error(`public key ของ ${userId} ไม่ครบถ้วน`);
    }
    if (!state.chat.verifyKeyBinding(identityPublicKey, signingPublicKey, identityPublicKeySignature)) {
      throw new Error(`ลายเซ็น public key ของ ${userId} ไม่ผ่านการตรวจ`);
    }
    signing.push({
      userId,
      publicKeyVersion,
      publicKey: signingPublicKey,
      identityPublicKey,
      identityPublicKeySignature,
    });
    encryption.push({ userId, publicKeyVersion, identityPublicKey });
  }
  return { signing, encryption };
}

async function trustedPublicKeysFor(userId) {
  return publicKeyRecords(userId, await api(`/api/public-keys?user_id=${encodeURIComponent(userId)}`));
}

function enteredMemberIds(value) {
  const ids = String(value)
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!ids.length || ids.some((id) => !/^\d{1,19}$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error("ระบุ X user ID ที่ถูกต้อง คั่นด้วยจุลภาคหรือขึ้นบรรทัดใหม่");
  }
  return ids;
}

async function mutateGroupMembers(operation) {
  try {
    if (state.mode !== "mock" || !state.conversationId.startsWith("g") || !state.activeConversationKeyVersion) {
      throw new Error("การแก้สมาชิกกลุ่มพร้อม key rotation มีใน Mock group ที่เปิดอยู่เท่านั้น");
    }
    const roster = getData(await gateway.groupRoster(state.conversationId));
    if (
      !roster ||
      roster.keyVersion !== state.activeConversationKeyVersion ||
      !Array.isArray(roster.memberIds) ||
      !Array.isArray(roster.adminIds)
    ) {
      throw new Error("roster หรือ key version ไม่ครบ/เปลี่ยนแล้ว จึงหยุด mutation เพื่อความปลอดภัย");
    }
    const changed = enteredMemberIds(el("group-change-members").value);
    const currentMembers = roster.memberIds.map(String);
    const nextMembers =
      operation === "add"
        ? [...new Set([...currentMembers, ...changed])]
        : currentMembers.filter((id) => !changed.includes(id));
    if (
      (operation === "add" && changed.some((id) => currentMembers.includes(id))) ||
      (operation === "remove" && (changed.includes(state.myId) || nextMembers.length < 2))
    ) {
      throw new Error("รายชื่อสมาชิกไม่สอดคล้องกับ roster ปัจจุบัน");
    }
    const publicKeys = [];
    state.signingKeys.clear();
    for (const userId of nextMembers) {
      const keys = await trustedPublicKeysFor(userId);
      state.signingKeys.set(userId, keys.signing);
      publicKeys.push(...keys.encryption);
    }
    state.chat.setSigningKeys([...state.signingKeys.values()].flat());
    const prepared =
      operation === "add"
        ? state.chat.prepareGroupMembersChange({
            publicKeys,
            conversationId: state.conversationId,
            newMemberIds: changed,
            currentMemberIds: currentMembers,
            currentAdminIds: roster.adminIds,
            currentPendingMemberIds: [],
            currentTitle: state.groupTitle || null,
          })
        : state.chat.prepareGroupMembersRemove({
            publicKeys,
            conversationId: state.conversationId,
            userIds: changed,
            title: state.groupTitle || null,
          });
    const request =
      operation === "add"
        ? groupMembersAddRequest(prepared, changed, roster.keyVersion)
        : groupMembersRemoveRequest(prepared, changed, roster.keyVersion);
    const changedRoster = getData(
      operation === "add" ? await gateway.addGroupMembers(request) : await gateway.removeGroupMembers(request),
    );
    if (!changedRoster || changedRoster.key_version !== prepared.conversationKeyVersion) {
      throw new Error("Mock group mutation ไม่คืน key version ที่คาดไว้");
    }
    state.activeConversationKey = prepared.conversationKey;
    state.activeConversationKeyVersion = prepared.conversationKeyVersion;
    state.keys[prepared.conversationKeyVersion] = prepared.conversationKey;
    state.groupMemberIds = changedRoster.member_ids.map(String);
    state.groupAdminIds = roster.adminIds.filter((id) => state.groupMemberIds.includes(String(id)));
    el("group-change-members").value = "";
    activity(
      `${operation === "add" ? "เพิ่ม" : "ลบ"}สมาชิกแล้วและหมุน key เป็น ${prepared.conversationKeyVersion}; key ใหม่ไม่ย้อนปกป้องข้อความเก่า`,
    );
    await loadConversations().catch(() => {});
  } catch (error) {
    activity(error.message);
  }
}

// Fail-closed offline fallback: decrypt only cached signed ciphertext, and render
// only events the SDK reports as verified. Without signing keys already loaded in
// this session nothing verifies, so an empty result is the expected safe outcome.
function renderCachedHistory() {
  const encoded = state.cachedEvents[state.conversationId];
  if (!state.chat || !Array.isArray(encoded) || !encoded.length) return 0;
  let result;
  try {
    result = state.chat.decryptEvents({ events: encoded });
  } catch {
    return 0;
  }
  state.keys = { ...state.keys, ...(result.conversationKeys?.keys ?? {}) };
  let rendered = 0;
  for (const entry of result.events ?? []) {
    if (entry?.event?.type !== "message" || entry.event.verified !== true) continue;
    render(entry);
    rendered += 1;
  }
  return rendered;
}

async function refresh(pageToken = null) {
  if (!state.conversationId || state.loadingPage) return;
  if (pageToken === null) state.seenPageTokens.clear();
  if (pageToken !== null && state.seenPageTokens.has(pageToken)) throw new Error("พบ pagination cursor ซ้ำ");
  state.loadingPage = true;
  el("refresh").disabled = true;
  el("load-more").disabled = true;
  const loadingMore = pageToken !== null;
  activity(loadingMore ? "กำลังโหลดประวัติเพิ่มและตรวจลายเซ็น…" : "กำลังโหลดและตรวจลายเซ็น…");
  try {
    const params = new URLSearchParams({ conversation_id: state.conversationId });
    if (pageToken !== null) params.set("pagination_token", pageToken);
    const response = await api(`/api/events?${params}`);
    if (pageToken !== null) state.seenPageTokens.add(pageToken);
    if (pageToken === null) state.missingSigningKeys.clear();
    const events = response.data ?? [];
    const signingKeyApiErrors = await signingKeysFor(events);
    const signingKeys = [...state.signingKeys.values()].flat();
    const eventMetadata = events.map((event) => inspectEventMetadata(event, signingKeys));
    const keyEventsValue = response.meta?.conversationKeyEvents ?? response.meta?.conversation_key_events ?? [];
    const keyEvents = Array.isArray(keyEventsValue) ? keyEventsValue : [];
    const eventRows = events
      .map((event, index) => ({
        event,
        index,
        eventB64: event.encodedEvent ?? event.encoded_event,
      }))
      .filter((entry) => typeof entry.eventB64 === "string" && entry.eventB64.length > 0);
    const candidates = eventRows.filter(
      (entry) => !isKnownUnsignedEvent(state.knownUnsignedEvents, unverifiedEventCacheKey(entry.event, entry.eventB64)),
    );
    const eventB64s = candidates.map((entry) => entry.eventB64);
    const encoded = [...keyEvents, ...eventB64s];
    const result = state.chat.decryptEvents({ events: encoded });
    state.keys = { ...state.keys, ...result.conversationKeys.keys };
    for (const entry of result.events) render(entry);
    // A just-created Mock group has its fresh key only in this browser session;
    // until a signed KeyChange arrives in history, decrypt the event against the
    // in-memory key map. decryptEvent still throws on any bad signature/key.
    let recovered = 0;
    const recoveredEventKeys = new Set();
    for (let index = 0; index < candidates.length; index += 1) {
      const { event, eventB64 } = candidates[index];
      const error = result.errors?.[keyEvents.length + index];
      if (!missingConversationKey(error)) continue;
      try {
        const decryptedEvent = state.chat.decryptEvent({ eventB64, conversationKeys: state.keys, signingKeys });
        if (decryptedEvent.verified && !state.shown.has(decryptedEvent.id)) {
          render({ event: decryptedEvent, originalB64: eventB64 });
          recoveredEventKeys.add(unverifiedEventCacheKey(event, eventB64));
          recovered += 1;
        }
      } catch {
        // Batch errors remain fail-closed. No unverified event reaches render or drafts.
      }
    }
    for (let index = 0; index < candidates.length; index += 1) {
      const entry = candidates[index];
      const error = result.errors?.[keyEvents.length + index];
      if (typeof error !== "string" || recoveredEventKeys.has(unverifiedEventCacheKey(entry.event, entry.eventB64))) {
        continue;
      }
      renderUnverifiedPlaceholder(entry.event, entry.eventB64, eventMetadata[entry.index], error);
    }
    for (const entry of eventRows) {
      if (!isKnownUnsignedEvent(state.knownUnsignedEvents, unverifiedEventCacheKey(entry.event, entry.eventB64))) {
        continue;
      }
      renderUnverifiedPlaceholder(entry.event, entry.eventB64, eventMetadata[entry.index], "");
    }
    const verifiedSigningKeyCount = signingKeys.reduce((count, key) => {
      try {
        return (
          count +
          Number(state.chat.verifyKeyBinding(key.identityPublicKey, key.publicKey, key.identityPublicKeySignature))
        );
      } catch {
        return count;
      }
    }, 0);
    const diagnostics = historyDiagnostics({
      httpStatus: 200,
      response,
      additionalApiErrors: signingKeyApiErrors,
      signingKeys,
      verifiedSigningKeyCount,
      eventMetadata,
      result,
      verifiedMessageCount:
        result.events.filter((entry) => entry.event?.type === "message" && entry.event.verified === true).length +
        recovered,
    });
    state.cachedEvents[state.conversationId] = [
      ...new Set([...(state.cachedEvents[state.conversationId] || []), ...encoded]),
    ].slice(-1000);
    const next = response.meta?.next_token ?? response.meta?.nextToken ?? null;
    state.nextPageToken = typeof next === "string" && next && !state.seenPageTokens.has(next) ? next : null;
    const missingSignerNote = state.missingSigningKeys.size
      ? ` | ไม่พบ public key ของผู้ส่ง/ผู้ดูแล ${state.missingSigningKeys.size} บัญชี (อาจถูกลบหรือไม่เคยเผยแพร่ key) — ข้อความและการเปลี่ยนรายชื่อที่ลงนามด้วย key นั้นถูกซ่อน`
      : "";
    activity(`${formatHistoryDiagnostics(diagnostics)}${missingSignerNote}`);
    await saveCache();
    if (state.mode === "mock" && pageToken === null && result.events.length) {
      await gateway.markRead(state.conversationId).catch(() => {});
      await loadConversations().catch(() => {});
    }
  } catch (error) {
    const httpStatus = httpStatusFromError(error);
    error.safeDiagnosticMessage = `HTTP=${httpStatus ?? "unknown"} | API=1[${httpFailureCategory(httpStatus)}] | HISTORY=unavailable`;
    const offlineCount = pageToken === null ? renderCachedHistory() : 0;
    if (offlineCount > 0) {
      activity(
        `โหลดประวัติจาก X ไม่สำเร็จ; แสดง ${offlineCount} ข้อความที่ตรวจลายเซ็นแล้วจาก ciphertext cache ในเครื่อง`,
      );
    }
    throw error;
  } finally {
    state.loadingPage = false;
    el("refresh").disabled = false;
    el("load-more").disabled = !state.nextPageToken;
  }
}

async function sendImage(conversationId, text, file) {
  const mimeType = supportedImageMime(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
  if (!mimeType || (file.type && file.type !== mimeType))
    throw new Error("รองรับเฉพาะ PNG/JPEG ที่ชนิดไฟล์ตรงกับข้อมูล");
  if (file.size > 10 * 1024 * 1024) throw new Error("ต้นแบบจำกัดภาพไม่เกิน 10 MB");
  const image = await createImageBitmap(file);
  const width = image.width;
  const height = image.height;
  image.close();
  const encryptedBytes = encryptedFileSize(file.size);
  setSendPhase("uploading");
  activity("กำลังเริ่มอัปโหลดภาพ…");
  const initialized = getData(
    await post("/api/media/initialize", { conversation_id: conversationId, total_bytes: encryptedBytes }),
  );
  const sessionId = initialized.sessionId ?? initialized.session_id;
  const mediaHashKey = initialized.mediaHashKey ?? initialized.media_hash_key;
  if (!sessionId || !mediaHashKey) throw new Error("X API ไม่คืนข้อมูลสำหรับอัปโหลดภาพ");
  const payload = state.chat.encryptMessage(
    messageEncryptionParams(conversationId, text, {
      attachments: [
        {
          attachment_type: "media",
          media_hash_key: mediaHashKey,
          width,
          height,
          filesize_bytes: file.size,
          filename: file.name,
          media_type: 1,
        },
      ],
    }),
  );
  const encryptor = state.chat.fileEncryptor({ eventB64: payload.eventB64, mediaHashKey });
  let parts = 0;
  let pending = new Uint8Array();
  let finished = false;

  async function appendPart(part) {
    activity(`กำลังอัปโหลดภาพส่วนที่ ${parts + 1}…`);
    await post("/api/media/append", {
      conversation_id: conversationId,
      session_id: sessionId,
      media_hash_key: mediaHashKey,
      segment_index: parts,
      media: bytesToBase64(part),
    });
    parts += 1;
  }

  async function queueEncrypted(encrypted) {
    let offset = 0;
    if (pending.length) {
      const take = Math.min(UPLOAD_PART_BYTES - pending.length, encrypted.length);
      const combined = new Uint8Array(pending.length + take);
      combined.set(pending);
      combined.set(encrypted.subarray(0, take), pending.length);
      offset = take;
      if (combined.length === UPLOAD_PART_BYTES) await appendPart(combined);
      else pending = combined;
      if (combined.length === UPLOAD_PART_BYTES) pending = new Uint8Array();
    }
    while (encrypted.length - offset >= UPLOAD_PART_BYTES) {
      await appendPart(encrypted.subarray(offset, offset + UPLOAD_PART_BYTES));
      offset += UPLOAD_PART_BYTES;
    }
    if (offset < encrypted.length) pending = encrypted.slice(offset);
  }

  try {
    for (let offset = 0; offset < file.size; offset += FILE_READ_BYTES) {
      const chunk = new Uint8Array(await file.slice(offset, offset + FILE_READ_BYTES).arrayBuffer());
      await queueEncrypted(encryptor.push(chunk));
    }
    const finalFrame = encryptor.finish();
    finished = true;
    await queueEncrypted(finalFrame);
    if (pending.length) await appendPart(pending);
  } finally {
    if (!finished) encryptor.free();
  }
  await post("/api/media/finalize", {
    conversation_id: conversationId,
    session_id: sessionId,
    media_hash_key: mediaHashKey,
    num_parts: parts,
  });
  return payload;
}

async function send(event) {
  event.preventDefault();
  if (state.busy || !state.conversationId) return;
  if (!state.pendingSend && !state.draft) {
    activity("สร้าง draft และตรวจ preview ก่อนอนุมัติส่ง");
    return;
  }
  state.busy = true;
  el("send").disabled = true;
  try {
    const conversationId = state.conversationId;
    if (state.pendingSend) {
      setSendPhase("sending");
      activity("กำลังตรวจประวัติก่อนส่งซ้ำ…");
      try {
        await refresh();
        if (isConfirmedMessage(state.shown, state.pendingSend.message_id)) {
          const sentId = state.pendingSend.message_id;
          state.pendingSend = null;
          resetDraft();
          el("message-text").disabled = false;
          el("image-file").disabled = false;
          setSendPhase("sent");
          activity(`ยืนยันการส่งแล้วจากประวัติ · message ID ${sentId}`);
          return;
        }
      } catch {
        activity("ตรวจประวัติไม่ได้ จึงจะส่งซ้ำด้วย payload และ message ID เดิม");
      }
    }
    if (!state.pendingSend) {
      state.draft = approveDraft(state.draft);
      state.audits.push(toDraftAudit(state.draft));
      await saveCache();
      const text = state.draft.text;
      const file = state.draftFile;
      setSendPhase("encrypting");
      const payload = file
        ? await sendImage(conversationId, text, file)
        : state.chat.encryptMessage(messageEncryptionParams(conversationId, text));
      state.pendingSend = pendingSendFromPayload(conversationId, payload, state.mode);
    }
    setSendPhase("sending");
    activity("กำลังส่งข้อความที่เข้ารหัส…");
    await post("/api/send", state.pendingSend);
    const sentId = state.pendingSend.message_id;
    state.pendingSend = null;
    resetDraft();
    el("message-text").disabled = false;
    el("image-file").disabled = false;
    setSendPhase("sent");
    activity(`ส่งแล้ว · message ID ${sentId}`);
    await loadConversations().catch(() => {});
    await refresh().catch((error) => activity(`ส่งแล้ว แต่โหลดประวัติไม่สำเร็จ: ${error.message}`));
  } catch (error) {
    if (state.pendingSend && retainPendingSend(error)) {
      el("message-text").disabled = true;
      el("image-file").disabled = true;
      el("send-label").textContent = "ลองส่งซ้ำด้วย ID เดิม";
      setSendPhase("unknown");
      activity(`ยังยืนยันการส่งไม่ได้: ${error.message} · กดซ้ำเพื่อใช้ message ID เดิม`);
    } else {
      state.pendingSend = null;
      state.draft = null;
      state.draftFile = null;
      setSendPhase("failed");
      activity(`ส่งไม่สำเร็จ: ${error.message}`);
    }
  } finally {
    state.busy = false;
    el("send").disabled = !state.pendingSend && !state.draft;
  }
}

async function queueDraft() {
  try {
    if (!state.conversationId) throw new Error("เลือกบทสนทนาก่อนสร้าง draft");
    if (state.pendingSend || state.draft) throw new Error("มี draft หรือข้อความที่กำลังรอผลอยู่แล้ว");
    const text = el("message-text").value.trim();
    const file = el("image-file").files[0];
    state.draft = createDraft({
      conversationId: state.conversationId,
      text: text || (file ? "[ภาพแนบ]" : ""),
      hasFile: Boolean(file),
      reason: el("draft-reason").value,
    });
    state.draftFile = file || null;
    el("create-draft").disabled = true;
    el("discard-draft").disabled = false;
    el("send").disabled = false;
    activity(
      `draft ${state.draft.id.slice(0, 8)} พร้อมอนุมัติ · ผู้รับ ${state.conversationId} · ไม่มีการส่งอัตโนมัติ`,
    );
  } catch (error) {
    activity(error.message);
  }
}

async function discardCurrentDraft() {
  try {
    if (!state.draft) throw new Error("ไม่มี draft ที่รอลบ");
    state.audits.push(toDraftAudit(discardDraft(state.draft)));
    await saveCache();
    resetDraft();
    activity("ล้าง draft ที่ยังไม่ส่งแล้ว");
  } catch (error) {
    activity(error.message);
  }
}

function setUnlockStatus(phase, message) {
  el("unlock-status").dataset.phase = phase;
  el("unlock-status").textContent = message;
}

async function prepareJuiceboxUnlock() {
  const button = el("prepare-juicebox");
  if (button.disabled || state.keyVersion) return;
  button.disabled = true;
  setUnlockStatus("loading", "กำลังยืนยันบัญชีและโหลดการตั้งค่ากุญแจ…");
  try {
    if (state.mode !== "live") throw new Error("PIN unlock ใช้ได้เฉพาะกับ X API จริง ไม่ใช้ใน Mock");
    const data = getData(await gateway.juiceboxConfig());
    if (!data?.account?.id || !Array.isArray(data.records) || !data.configJson) {
      throw new Error("Server ไม่คืนบัญชีหรือ Juicebox config ที่ยืนยันได้");
    }
    if (data.policyChanged) {
      setUnlockStatus("loading", "กำลังใช้ CSP allowlist ของ Juicebox realms ที่ยืนยันแล้ว…");
      window.setTimeout(() => window.location.reload(), 700);
      return;
    }

    const realmTokens = realmTokensFromConfig(data.configJson);
    const chat = await createChat({
      juiceboxConfig: data.configJson,
      getAuthToken: async (realmId) => realmTokens.get(String(realmId).toLowerCase()) ?? "",
    });
    state.chat = chat;
    state.myId = String(data.account.id);
    state.juiceboxConfig = data.configJson;
    state.juiceboxAccount = data.account;
    state.juiceboxRecords = data.records;
    state.realmTokens = realmTokens;
    state.pinPrepared = true;
    setAccountDisplay(data.account);
    el("unlock-pin").disabled = false;
    el("unlock-key").disabled = false;
    el("connection-status").textContent = "X API เชื่อมต่อแล้ว";
    setUnlockStatus("success", "บัญชียืนยันแล้ว · พร้อมรับ Passcode");
  } catch (error) {
    setUnlockStatus("error", error.message);
    button.disabled = false;
  }
}

async function unlockJuiceboxIdentity() {
  if (state.unlockBusy || !state.pinPrepared || !state.chat) return;
  const pinBytes = new TextEncoder().encode(el("unlock-pin").value);
  el("unlock-pin").value = "";
  state.unlockBusy = true;
  el("unlock-pin").disabled = true;
  el("unlock-key").disabled = true;
  setUnlockStatus("loading", "กำลังปลดล็อกกุญแจเดิม…");
  try {
    const version = await unlockExistingIdentity({
      chat: state.chat,
      pinBytes,
      account: state.juiceboxAccount,
      records: state.juiceboxRecords,
    });
    state.keyVersion = version;
    state.juiceboxConfig = "";
    state.juiceboxRecords = [];
    state.realmTokens?.clear();
    state.realmTokens = null;
    state.pinPrepared = false;
    el("connect").disabled = false;
    el("create-group").disabled = false;
    el("unlock-pin").disabled = true;
    setAccountDisplay(state.juiceboxAccount, true);
    setUnlockStatus("success", `ปลดล็อกกุญแจเดิมแล้ว · Signing key version ${version}`);
  } catch (error) {
    setUnlockStatus("error", error.message);
  } finally {
    el("unlock-pin").value = "";
    state.unlockBusy = false;
    el("unlock-key").disabled = !state.pinPrepared;
    el("unlock-pin").disabled = !state.pinPrepared;
  }
}

el("conversation-search").addEventListener("input", renderConversationList);
for (const button of document.querySelectorAll(".filter-chip")) {
  button.addEventListener("click", () => {
    state.conversationFilter = button.dataset.filter;
    for (const filter of document.querySelectorAll(".filter-chip")) {
      filter.setAttribute("aria-pressed", String(filter === button));
    }
    renderConversationList();
  });
}

el("settings-toggle").addEventListener("click", () => {
  const dialog = el("settings-panel");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
});
el("settings-close").addEventListener("click", () => {
  const dialog = el("settings-panel");
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
});
el("new-chat").addEventListener("click", () => {
  const dialog = el("new-chat-modal");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  el("contact-username").focus();
});
el("new-chat-close").addEventListener("click", () => {
  if (!state.startingDirectChat) closeNewChat();
});
el("new-chat-modal").addEventListener("cancel", (event) => {
  if (state.startingDirectChat) event.preventDefault();
  else closeNewChat();
});
el("contact-username").addEventListener("input", () => {
  contactLookupEpoch.invalidate();
  state.directChatEpoch += 1;
  state.livePreviewBusy = false;
  state.livePreviewResult = null;
  renderLivePreviewResult(null);
  state.contactResults = [];
  state.newChatContact = null;
  renderContactResults();
  el("contact-search").disabled = false;
  setContactLookupStatus("กดค้นหาหรือ Enter เพื่อค้นหา Username", "idle");
});
el("new-chat-form").addEventListener("submit", lookupContact);
el("contact-open-existing").addEventListener("click", () => {
  const contact = state.newChatContact;
  const conversation = contact?.existing?.conversation;
  const id = conversationIdOf(conversation);
  if (!contact?.identityVerified || !id || !canOpenConversation(conversation, state.myId)) {
    setContactLookupStatus("ยังยืนยันบัญชีหรือผู้เข้าร่วมของห้องเดิมไม่ได้", "error");
    return;
  }
  state.conversations = [conversation, ...state.conversations.filter((entry) => conversationIdOf(entry) !== id)];
  renderConversationList();
  el("conversation-id").value = id;
  closeNewChat();
  el("connect").click();
});
el("contact-start-chat").addEventListener("click", startDirectChat);
el("contact-live-create-button").addEventListener("click", startLiveDirectChat);
el("contact-start-consent").addEventListener("change", renderContactActions);
el("contact-live-preview-button").addEventListener("click", previewLiveCreateReadiness);
el("contact-live-consent").addEventListener("change", () => {
  el("contact-live-final-approval").checked = false;
  state.livePreviewResult = null;
  renderLivePreviewResult(null);
  renderContactActions();
  if (state.newChatContact) setContactLookupStatus("ความยินยอมเปลี่ยนแล้ว; ตรวจ Live Preview ใหม่เมื่อพร้อม", "idle");
});
el("contact-live-final-approval").addEventListener("change", () => {
  renderContactActions();
  if (state.newChatContact)
    setContactLookupStatus("การอนุมัติเปลี่ยนแล้ว; กด Create เพื่อดำเนินการอย่างชัดเจน", "idle");
});
el("mobile-back").addEventListener("click", () => setMobileView("inbox"));

el("prepare-juicebox").addEventListener("click", prepareJuiceboxUnlock);
el("unlock-key").addEventListener("click", unlockJuiceboxIdentity);

el("load-keys").addEventListener("click", async () => {
  try {
    const blob = base64ToBytes(el("key-blob").value.trim());
    const version = el("key-version").value.trim();
    if (!blob || !version) throw new Error("กรอก key blob และ signing key version ให้ครบ");
    const chat = await createChat();
    chat.importKeys({ keys: blob, signingKeyVersion: version });
    state.chat = chat;
    state.keyVersion = version;
    chat.setCacheKeys(true);
    el("key-blob").value = "";
    el("connect").disabled = false;
    el("create-group").disabled = false;
    setAccountDisplay(null, true);
    activity("โหลดกุญแจในเบราว์เซอร์แล้ว");
  } catch (error) {
    activity(error.safeDiagnosticMessage ?? error.message);
  }
});

el("create-mock-identity").addEventListener("click", async () => {
  try {
    if (state.mode !== "mock") throw new Error("สร้างตัวตนทดสอบได้เฉพาะ Mock mode");
    el("create-mock-identity").disabled = true;
    activity("กำลังสร้างกุญแจทดสอบในเบราว์เซอร์…");
    state.chat ??= await createChat();
    const me = getData(await api("/api/me"));
    state.myId = String(me.id);
    if (!/^\d{1,19}$/.test(state.myId)) throw new Error("Mock user ID ไม่ถูกต้อง");
    const peerId = state.myId === "1000000000000000002" ? "1000000000000000001" : "1000000000000000002";
    const peerId2 = "1000000000000000003";
    const ownRegistration = state.chat.generateKeypairs();
    const peer = await createChat();
    const peerRegistration = peer.generateKeypairs();
    const peer2 = await createChat();
    const peerRegistration2 = peer2.generateKeypairs();
    await post("/api/mock/identity", { user_id: state.myId, public_key: ownRegistration.publicKey });
    const peerIdentity = getData(
      await post("/api/mock/identity", { user_id: peerId, public_key: peerRegistration.publicKey }),
    );
    await post("/api/mock/identity", { user_id: peerId2, public_key: peerRegistration2.publicKey });
    const peerUsername = peerIdentity?.username;
    normalizeUsername(peerUsername);
    state.keyVersion = "1";
    state.mockPeerId = peerId;
    state.chat.setIdentity({ userId: state.myId, signingKeyVersion: state.keyVersion });
    state.chat.setCacheKeys(true);
    setAccountDisplay({ name: "บัญชี Mock" }, true);
    el("group-members").value = `${peerId}, ${peerId2}`;
    el("group-title").value ||= "ทีมทดสอบ Mock";
    el("connect").disabled = false;
    el("create-group").disabled = false;
    activity(`ตัวตน Mock พร้อมแล้ว · ค้นหา @${peerUsername} เพื่อทดสอบเริ่มแชท`);
  } catch (error) {
    activity(error.message);
    el("create-mock-identity").disabled = false;
  }
});

async function openConversation(selectedConversation, initialKey = null) {
  let opened = false;
  try {
    if (state.pendingSend) throw new Error("มีข้อความที่ยังยืนยันการส่งไม่ได้ กรุณาลองส่งซ้ำก่อนเปลี่ยนห้อง");
    if (state.draft && state.draft.conversationId !== conversationIdOf(selectedConversation)) {
      throw new Error("ยังมี draft ของห้องเดิม; อนุมัติหรือล้าง draft ก่อนเปลี่ยนห้อง");
    }
    const id = conversationIdOf(selectedConversation);
    if (!canOpenConversation(selectedConversation, state.myId)) {
      throw new Error("เลือกได้เฉพาะแชท 1:1 ที่มี Conversation ID และยืนยันผู้รับจาก X API แล้ว");
    }
    const me = getData(await api("/api/me"));
    const authenticatedUserId = String(me.id ?? "");
    if (authenticatedUserId !== state.myId) {
      clearUnlockedIdentity();
      state.myId = authenticatedUserId;
      throw new Error("บัญชี OAuth เปลี่ยนไป; ล้างกุญแจในหน่วยความจำแล้ว กรุณายืนยันและปลดล็อกใหม่");
    }
    if (!canOpenConversation(selectedConversation, authenticatedUserId)) {
      throw new Error("ผู้รับไม่ตรงกับบัญชี OAuth ที่ยืนยันแล้ว");
    }
    if (initialKey && (initialKey.conversationId !== id || !(initialKey.key instanceof Uint8Array))) {
      throw new Error("key ที่เตรียมไว้ไม่ตรงกับบทสนทนา");
    }
    if (state.mode !== "mock") {
      const ownKeys = getData(await api(`/api/public-keys?user_id=${encodeURIComponent(authenticatedUserId)}`));
      const records = Array.isArray(ownKeys) ? ownKeys : [ownKeys];
      const found = records.some(
        (key) => String(key.publicKeyVersion ?? key.public_key_version ?? "") === state.keyVersion,
      );
      if (!found) throw new Error("ไม่พบ signing key version นี้ใน public-key record ของบัญชี");
    }
    state.chat.setIdentity({ userId: state.myId, signingKeyVersion: state.keyVersion });
    if (state.conversationId !== id) {
      for (const key of Object.values(state.keys)) key?.fill(0);
      state.activeConversationKey?.fill(0);
    }
    state.conversationId = id;
    state.currentConversation = selectedConversation;
    state.shown.clear();
    state.shownUnverifiedEvents.clear();
    state.missingSigningKeys.clear();
    state.keys = initialKey ? { [initialKey.keyVersion]: initialKey.key } : {};
    state.activeConversationKey = initialKey?.key ?? null;
    state.activeConversationKeyVersion = initialKey?.keyVersion ?? "";
    state.groupMemberIds = [];
    state.groupAdminIds = [];
    state.groupTitle = "";
    updateChatHeader();
    el("add-group-members").disabled = true;
    el("remove-group-members").disabled = true;
    state.nextPageToken = null;
    state.seenPageTokens.clear();
    el("messages").replaceChildren();
    setMobileView("chat");
    el("refresh").disabled = false;
    el("message-text").disabled = false;
    el("image-file").disabled = false;
    el("create-draft").disabled = false;
    el("send").disabled = true;
    setSendPhase("draft");
    await refresh();
    await loadConversations().catch(() => {});
    opened = true;
  } catch (error) {
    activity(error.message);
    throw error;
  } finally {
    if (!opened && initialKey) {
      initialKey.key.fill(0);
      if (state.activeConversationKey === initialKey.key) {
        state.activeConversationKey = null;
        state.activeConversationKeyVersion = "";
        state.keys = {};
        el("message-text").disabled = true;
        el("image-file").disabled = true;
      }
    }
  }
}

el("connect").addEventListener("click", async () => {
  const id = el("conversation-id").value.trim();
  const selectedConversation = state.conversations.find((conversation) => conversationIdOf(conversation) === id);
  try {
    await openConversation(selectedConversation);
  } catch {
    // openConversation writes a user-facing, status-only error.
  }
});

el("create-group").addEventListener("click", async () => {
  try {
    if (state.pendingSend) throw new Error("มีข้อความที่ยังยืนยันการส่งไม่ได้ กรุณาลองส่งซ้ำก่อนเปลี่ยนห้อง");
    const title = el("group-title").value.trim();
    if (!title) throw new Error("กรอกชื่อกลุ่ม");
    if (
      state.mode !== "mock" &&
      !window.confirm("การสร้างกลุ่มจะส่งคำขอจริงไปยัง X และเพิ่มสมาชิกตามรายชื่อ ยืนยันหรือไม่?")
    ) {
      return;
    }
    const me = getData(await api("/api/me"));
    state.myId = String(me.id);
    const memberIds = groupMemberIds(el("group-members").value, state.myId);
    activity("กำลังโหลดและตรวจ public key ของสมาชิก…");
    const publicKeys = [];
    state.signingKeys.clear();
    for (const userId of memberIds) {
      const keys = await trustedPublicKeysFor(userId);
      state.signingKeys.set(userId, keys.signing);
      publicKeys.push(...keys.encryption);
    }
    const ownKeys = state.signingKeys.get(state.myId) ?? [];
    if (!ownKeys.some((key) => key.publicKeyVersion === state.keyVersion)) {
      throw new Error("ไม่พบ signing key version นี้ใน public-key record ของบัญชี");
    }
    state.chat.setSigningKeys([...state.signingKeys.values()].flat());
    state.chat.setIdentity({ userId: state.myId, signingKeyVersion: state.keyVersion });
    activity("กำลังเตรียม group key และลายเซ็นในเบราว์เซอร์…");
    const initialized = getData(await post("/api/group/initialize", {}));
    const conversationId = String(initialized.conversationId ?? initialized.conversation_id ?? "");
    if (!/^g[A-Za-z0-9_:.-]+$/.test(conversationId)) throw new Error("X API คืน group conversation ID ไม่ถูกต้อง");
    const prepared = state.chat.prepareGroupCreate({
      publicKeys,
      conversationId,
      memberIds,
      adminIds: [state.myId],
      title,
    });
    await post("/api/group/create", groupCreateRequest(prepared, memberIds, [state.myId]));
    state.conversationId = conversationId;
    state.currentConversation = null;
    state.keys = { [prepared.conversationKeyVersion]: prepared.conversationKey };
    state.activeConversationKey = prepared.conversationKey;
    state.activeConversationKeyVersion = prepared.conversationKeyVersion;
    state.groupMemberIds = memberIds;
    state.groupAdminIds = [state.myId];
    state.groupTitle = title;
    updateChatHeader();
    state.shown.clear();
    state.shownUnverifiedEvents.clear();
    state.missingSigningKeys.clear();
    state.nextPageToken = null;
    state.seenPageTokens.clear();
    el("messages").replaceChildren();
    setMobileView("chat");
    el("refresh").disabled = false;
    el("message-text").disabled = false;
    el("image-file").disabled = false;
    el("create-draft").disabled = false;
    el("send").disabled = true;
    el("add-group-members").disabled = false;
    el("remove-group-members").disabled = false;
    setSendPhase("draft");
    activity(`สร้างกลุ่มแล้ว · ${memberIds.length} สมาชิก · key version ${prepared.conversationKeyVersion}`);
    await loadConversations().catch(() => {});
  } catch (error) {
    activity(error.message);
  }
});

el("refresh").addEventListener("click", () =>
  refresh().catch((error) => activity(error.safeDiagnosticMessage ?? error.message)),
);
el("load-more").addEventListener("click", () => {
  if (state.nextPageToken)
    refresh(state.nextPageToken).catch((error) => activity(error.safeDiagnosticMessage ?? error.message));
});
el("image-file").addEventListener("change", () => {
  el("file-name").textContent = el("image-file").files[0]?.name || "ไม่มีภาพแนบ";
});
el("composer").addEventListener("submit", send);
el("create-draft").addEventListener("click", queueDraft);
el("discard-draft").addEventListener("click", discardCurrentDraft);
el("unlock-cache").addEventListener("click", () => unlockCache().catch((error) => activity(error.message)));
el("clear-cache").addEventListener("click", () => clearCache().catch((error) => activity(error.message)));
el("export-cache").addEventListener("click", () => exportCache().catch((error) => activity(error.message)));
el("import-cache").addEventListener("change", () => {
  importCache(el("import-cache").files[0]).catch((error) => activity(error.message));
});
el("load-conversations").addEventListener("click", () => loadConversations().catch((error) => activity(error.message)));
el("sync-mock").addEventListener("click", () => syncMockDeliveries().catch((error) => activity(error.message)));
el("add-group-members").addEventListener("click", () => mutateGroupMembers("add"));
el("remove-group-members").addEventListener("click", () => mutateGroupMembers("remove"));

try {
  const status = await api("/api/status");
  state.mode = status.mode;
  state.liveCreateSimulationEnabled = status.liveCreateSimulationEnabled === true;
  el("connection-status").textContent =
    status.mode === "mock"
      ? "SDK พร้อม · Mock API (ไม่ส่ง X จริง)"
      : status.tokenConfigured
        ? "Local server พร้อม · รอยืนยันบัญชี X"
        : "Local server พร้อม · รอ X token";
  el("load-keys").disabled = false;
  el("prepare-juicebox").disabled = status.mode !== "live" || !status.tokenConfigured;
  el("create-mock-identity").disabled = status.mode !== "mock";
  el("sync-mock").hidden = status.mode !== "mock";
  setSendPhase("idle");
  activity("Local inbox พร้อม; ยืนยันบัญชีหรือโหลด key blob เพื่อเริ่มต้น");
} catch (error) {
  el("connection-status").textContent = "SDK ยังไม่พร้อม";
  activity(`โหลด SDK ไม่สำเร็จ: ${error.message}`);
}
