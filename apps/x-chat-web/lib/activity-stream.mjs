export const ACTIVITY_STREAM_PATH = "/2/activity/stream";
export const ACTIVITY_SUBSCRIPTIONS_PATH = "/2/activity/subscriptions";
export const CHAT_EVENT_TYPES = Object.freeze(["chat.received", "chat.sent"]);
export const MAX_BACKFILL_MINUTES = 5;
export const SUBSCRIPTION_TAG = "x-chat-local";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15_000, 30_000];
const MAX_SEEN_EVENTS = 1000;
const MAX_ERROR_CHARS = 200;

function text(value) {
  return typeof value === "string" ? value : "";
}

/**
 * Keeps only delivery metadata the UI needs to refresh history. The encrypted
 * material and the conversation token stay out of the frame so the browser
 * still has to verify every message through the SDK.
 */
export function normalizeChatEvent(envelope) {
  if (!envelope || typeof envelope !== "object") return null;
  const data = envelope.data ?? envelope;
  if (!data || typeof data !== "object") return null;
  const eventType = text(data.event_type);
  if (!CHAT_EVENT_TYPES.includes(eventType)) return null;
  const payload = data.payload && typeof data.payload === "object" ? data.payload : {};
  const conversationId = text(payload.conversation_id);
  if (!conversationId) return null;
  return {
    eventUuid: text(data.event_uuid),
    eventType,
    createdAt: text(data.created_at),
    conversationId,
    messageId: text(payload.id),
    senderId: text(payload.sender_id),
    conversationKeyVersion: text(payload.conversation_key_version),
    createdAtMsec: text(payload.created_at_msec),
  };
}

export function chatSubscriptionBody(userId, eventType) {
  return {
    event_type: eventType,
    filter: { user_id: String(userId) },
    tag: SUBSCRIPTION_TAG,
  };
}

function sleepDefault(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function redactError(error) {
  const message = text(error?.message) || "activity stream failed";
  return message.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_ERROR_CHARS);
}

async function problemDetail(response, limit = 300) {
  try {
    const body = (await response.text())
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, limit);
    return body ? ` — ${body}` : "";
  } catch {
    // An unreadable body still leaves the status to identify the failure.
    return "";
  }
}

function isDuplicateSubscription(error) {
  if (error.status === 409) return true;
  // X can also answer a re-created subscription with 400; only a problem body
  // that says duplicate is safe to read as "already subscribed".
  return error.status === 400 && /duplicate|already/i.test(error.message);
}

/**
 * @typedef {{ kind: "chat", eventUuid: string, eventType: string, createdAt: string, conversationId: string, messageId: string, senderId: string, conversationKeyVersion: string, createdAtMsec: string }} ChatFrame
 * @typedef {{ kind: "status", state: string, attempt: number, delivered: number, error: string, updatedAt: string }} StatusFrame
 */

/**
 * @param {{
 *   request: (path: string, options?: { method?: string, body?: unknown, signal?: AbortSignal }) => Promise<Response>,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   onAuthRequired?: (error: Error) => void,
 * }} options
 */
export function createActivityStream({ request, sleep = sleepDefault, onAuthRequired = () => {} }) {
  /** @type {Map<string, string>} */
  const subscriptions = new Map();
  /** @type {Set<(frame: ChatFrame | StatusFrame) => void>} */
  const listeners = new Set();
  const seen = new Set();
  const seenOrder = [];
  let controller = null;
  let running = null;
  let status = { state: "idle", attempt: 0, delivered: 0, error: "", updatedAt: "" };

  function setStatus(state, attempt, error = "") {
    status = { ...status, state, attempt, error, updatedAt: new Date().toISOString() };
    for (const listener of listeners) {
      try {
        listener({ kind: "status", ...status });
      } catch {
        // A broken UI listener must not stop delivery for the others.
      }
    }
  }

  async function jsonCall(path, options = {}) {
    const response = await request(path, options);
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        return {};
      }
    }
    const error = Object.assign(new Error(`activity API HTTP ${response.status}${await problemDetail(response)}`), {
      status: response.status,
    });
    throw error;
  }

  // Listing subscriptions needs like.read under a user token, which a chat-only
  // app has no reason to request, so creation is POST-only here.
  async function ensureSubscriptions(ownerId) {
    if (!ownerId) throw new Error("activity subscriptions need a user id");
    for (const eventType of CHAT_EVENT_TYPES) {
      if (subscriptions.has(eventType)) continue;
      try {
        const body = await jsonCall(ACTIVITY_SUBSCRIPTIONS_PATH, {
          method: "POST",
          body: chatSubscriptionBody(ownerId, eventType),
        });
        const id = body?.data?.id ?? body?.id;
        subscriptions.set(eventType, id === undefined ? "created" : String(id));
      } catch (error) {
        if (!isDuplicateSubscription(error)) throw error;
        subscriptions.set(eventType, "existing");
      }
    }
    return Object.fromEntries(subscriptions);
  }

  function remember(eventUuid) {
    if (!eventUuid) return true;
    if (seen.has(eventUuid)) return false;
    seen.add(eventUuid);
    seenOrder.push(eventUuid);
    if (seenOrder.length > MAX_SEEN_EVENTS) {
      const oldest = seenOrder.shift();
      seen.delete(oldest);
    }
    return true;
  }

  function emit(envelope) {
    const event = normalizeChatEvent(envelope);
    if (!event || !remember(event.eventUuid)) return;
    status = { ...status, delivered: status.delivered + 1, updatedAt: new Date().toISOString() };
    for (const listener of listeners) {
      try {
        listener({ kind: "chat", ...event });
      } catch {
        // Ignore UI listener failures; the stream keeps running.
      }
    }
  }

  async function readStream(body, signal) {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let carry = "";
    const cancel = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        carry += decoder.decode(value, { stream: true });
        const lines = carry.split(/\r?\n/);
        carry = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          let envelope;
          try {
            envelope = JSON.parse(trimmed);
          } catch {
            continue;
          }
          emit(envelope);
        }
        if (carry.length > 1024 * 1024) carry = "";
      }
      const tail = carry.trim();
      if (tail && !tail.startsWith(":")) {
        try {
          emit(JSON.parse(tail));
        } catch {
          // Truncated tail from a dropped connection: backfill covers it.
        }
      }
    } finally {
      signal?.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
    }
  }

  async function run(signal) {
    let attempt = 0;
    setStatus(attempt === 0 ? "connecting" : "reconnecting", attempt);
    while (!signal.aborted) {
      try {
        const response = await request(`${ACTIVITY_STREAM_PATH}?backfill_minutes=${MAX_BACKFILL_MINUTES}`, {
          signal,
        });
        if (response.status === 401 || response.status === 403) {
          const error = Object.assign(
            new Error(`activity stream authentication expired${await problemDetail(response, 200)}`),
            { status: response.status, authRequired: true },
          );
          setStatus("auth-required", attempt, redactError(error));
          onAuthRequired(error);
          return;
        }
        if (!response.ok) throw new Error(`activity stream HTTP ${response.status}${await problemDetail(response)}`);
        attempt = 0;
        setStatus("connected", 0);
        await readStream(response.body, signal);
        if (signal.aborted) break;
        setStatus("reconnecting", 1, "stream closed");
      } catch (error) {
        if (signal.aborted) break;
        setStatus("reconnecting", attempt + 1, redactError(error));
      }
      attempt += 1;
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)];
      await sleep(delay, signal);
    }
    setStatus("stopped", 0);
  }

  return {
    ensureSubscriptions,
    subscriptions,
    status: () => ({ ...status }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(ownerId) {
      if (running) return { ...status };
      await ensureSubscriptions(String(ownerId));
      if (running) return { ...status };
      controller = new AbortController();
      running = run(controller.signal).finally(() => {
        running = null;
        controller = null;
      });
      return { ...status };
    },
    async stop() {
      controller?.abort();
      if (running) await running.catch(() => {});
    },
  };
}
