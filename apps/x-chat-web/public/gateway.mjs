function errorFromResponse(response, body) {
  /** @type {Error & { retryable?: boolean; status?: number; authRequired?: boolean }} */
  const error = new Error(body.error || `HTTP ${response.status}`);
  error.retryable = body.retryable === true;
  error.status = response.status;
  return error;
}

const AUTH_REQUIRED_MESSAGE = "เซสชัน X หมดอายุหรือไม่ได้รับอนุญาต — เชื่อมต่อบัญชีใหม่";

/** Browser-facing gateway: UI code never needs to know whether the server is Mock or Live. */
export function createGateway(fetchImpl = fetch) {
  /** @type {(error: Error) => void} */
  let notifyAuthRequired = () => {};
  async function request(path, options) {
    let response;
    try {
      response = await fetchImpl(path, options);
    } catch {
      /** @type {Error & { retryable?: boolean }} */
      const error = new Error("เชื่อมต่อ local server ไม่สำเร็จ");
      error.retryable = true;
      throw error;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = errorFromResponse(response, body);
      if (response.status === 401) {
        error.authRequired = true;
        error.message = AUTH_REQUIRED_MESSAGE;
        notifyAuthRequired(error);
      }
      throw error;
    }
    return body;
  }
  const post = (path, data) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-chat-local": "1" },
      body: JSON.stringify(data),
    });
  return {
    request,
    post,
    onAuthRequired: (handler) => {
      notifyAuthRequired = typeof handler === "function" ? handler : () => {};
    },
    status: () => request("/api/status"),
    me: () => request("/api/me"),
    juiceboxConfig: () => request("/api/juicebox/config"),
    publicKeys: (userId) => request(`/api/public-keys?user_id=${encodeURIComponent(userId)}`),
    conversations: () => request("/api/conversations"),
    lookupContact: (username) => request(`/api/contacts/lookup?username=${encodeURIComponent(username)}`),
    initializeConversation: (payload) => post("/api/conversations/initialize", payload),
    simulateLiveCreate: (payload) => post("/api/mock/live-create", payload),
    markRead: (conversationId) => post("/api/conversations/read", { conversation_id: conversationId }),
    events: (conversationId, page) => {
      const params = new URLSearchParams({ conversation_id: conversationId });
      if (page) params.set("pagination_token", page);
      return request(`/api/events?${params}`);
    },
    deliveries: (cursor) => request(`/api/mock/deliveries?after=${encodeURIComponent(cursor || "0")}`),
    mockNetwork: (settings) => post("/api/mock/network", settings),
    groupRoster: (conversationId) => request(`/api/group/roster?conversation_id=${encodeURIComponent(conversationId)}`),
    addGroupMembers: (payload) => post("/api/group/members/add", payload),
    removeGroupMembers: (payload) => post("/api/group/members/remove", payload),
  };
}
