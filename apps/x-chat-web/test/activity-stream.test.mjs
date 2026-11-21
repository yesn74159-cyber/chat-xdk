import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_STREAM_PATH,
  ACTIVITY_SUBSCRIPTIONS_PATH,
  MAX_BACKFILL_MINUTES,
  chatSubscriptionBody,
  createActivityStream,
  normalizeChatEvent,
} from "../lib/activity-stream.mjs";

const ownerId = "1111111111111111111";
const peerId = "2222222222222222222";
const conversationId = `${peerId}:${ownerId}`;

function chatEnvelope(overrides = {}) {
  return {
    data: {
      event_uuid: "8511582263942905822",
      created_at: "2026-10-07T19:17:36.304Z",
      filter: { user_id: ownerId },
      event_type: "chat.received",
      tag: "x-chat-local",
      payload: {
        conversation_token: "must-not-leak",
        id: "e4f4d3fc-8bbf-4928-92eb-e5058d6bb6f6",
        created_at_msec: "1784841183370",
        sender_id: peerId,
        conversation_id: conversationId,
        conversation_key_version: "1768236281331",
        encoded_event: "opaque-encoded-event",
        conversation_key_change_event: "opaque-key-change",
        message_event_signature: { signature: "opaque-signature" },
      },
      ...overrides,
    },
  };
}

function streamResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET" });
    const handler = routes[path.split("?")[0]];
    if (!handler) return jsonResponse({ error: "not found" }, 404);
    return handler(options);
  };
  return { fetchImpl, calls };
}

// An instantly resolving sleep turns the reconnect loop into a microtask spin
// that starves timers. Tests need a sleep that yields to the macrotask queue.
function testSleep(sleeps = []) {
  return (ms, signal) =>
    new Promise((resolve) => {
      sleeps.push(ms);
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, 5);
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
}

function waitFor(predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out waiting for condition"));
      }
    }, 10);
  });
}

test("normalized chat events keep only delivery metadata", () => {
  const event = normalizeChatEvent(chatEnvelope());
  assert.deepEqual(event, {
    eventUuid: "8511582263942905822",
    eventType: "chat.received",
    createdAt: "2026-10-07T19:17:36.304Z",
    conversationId,
    messageId: "e4f4d3fc-8bbf-4928-92eb-e5058d6bb6f6",
    senderId: peerId,
    conversationKeyVersion: "1768236281331",
    createdAtMsec: "1784841183370",
  });
  assert.equal(JSON.stringify(event).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(event).includes("opaque"), false);
  assert.equal(normalizeChatEvent(chatEnvelope({ event_type: "like.create" })), null);
  assert.equal(normalizeChatEvent(chatEnvelope({ payload: { id: "x" } })), null);
});

test("subscription bodies pin the user filter for both chat event types", () => {
  assert.deepEqual(chatSubscriptionBody(ownerId, "chat.sent"), {
    event_type: "chat.sent",
    filter: { user_id: ownerId },
    tag: "x-chat-local",
  });
});

test("subscription creation stays off the like.read-gated list route", async () => {
  const created = [];
  const { fetchImpl, calls } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: (options) => {
      if (options.method === "POST") {
        created.push(options.body);
        if (options.body.event_type === "chat.received") {
          return jsonResponse({ detail: "DuplicateSubscription" }, 409);
        }
        return jsonResponse({ data: { id: `sub-${created.length}` } }, 201);
      }
      return jsonResponse({ detail: "Missing required scope like.read" }, 403);
    },
  });
  const activity = createActivityStream({ request: fetchImpl });
  const ids = await activity.ensureSubscriptions(ownerId);
  assert.deepEqual(ids, { "chat.received": "existing", "chat.sent": "sub-2" });
  assert.deepEqual(
    created.map((body) => body.event_type),
    ["chat.received", "chat.sent"],
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 0);
  assert.equal(created[1].filter.user_id, ownerId);
});

test("a permanent subscription failure surfaces the upstream detail", async () => {
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({ title: "Forbidden", detail: "Not authorized for this endpoint" }, 403),
  });
  const activity = createActivityStream({ request: fetchImpl });
  await assert.rejects(activity.ensureSubscriptions(ownerId), (error) => {
    const failure = /** @type {Error & { status: number }} */ (error);
    assert.equal(failure.status, 403);
    assert.match(failure.message, /HTTP 403 — .*Not authorized/);
    return true;
  });
});

test("stream frames are parsed across chunks, deduplicated, and filtered to chat", async () => {
  const first = JSON.stringify(chatEnvelope());
  const duplicate = JSON.stringify(chatEnvelope());
  const other = JSON.stringify(chatEnvelope({ event_type: "like.create" }));
  const sent = JSON.stringify(
    chatEnvelope({ event_uuid: "42", event_type: "chat.sent", payload: chatEnvelope().data.payload }),
  );
  const { fetchImpl, calls } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({
        data: [
          { id: "a", event_type: "chat.received", filter: { user_id: ownerId } },
          { id: "b", event_type: "chat.sent", filter: { user_id: ownerId } },
        ],
      }),
    [ACTIVITY_STREAM_PATH]: () =>
      streamResponse([
        ": keep-alive\n",
        first.slice(0, 40),
        `${first.slice(40)}\n{broken\n`,
        duplicate + "\n",
        other + "\n",
        sent + "\n",
      ]),
  });
  const activity = createActivityStream({ request: fetchImpl, sleep: testSleep() });
  const states = [];
  const events = [];
  activity.subscribe((frame) => {
    if (frame.kind === "status") states.push(frame.state);
    else events.push(frame);
  });
  await activity.start(ownerId);
  await waitFor(() => events.length >= 2);
  await activity.stop();

  assert.deepEqual(
    events.map((event) => [event.eventType, event.messageId]),
    [
      ["chat.received", "e4f4d3fc-8bbf-4928-92eb-e5058d6bb6f6"],
      ["chat.sent", "e4f4d3fc-8bbf-4928-92eb-e5058d6bb6f6"],
    ],
  );
  assert.ok(states.includes("connected"));
  assert.ok(states.includes("stopped"));
  const streamCall = calls.find((call) => call.path.startsWith(ACTIVITY_STREAM_PATH));
  assert.equal(streamCall.path, `${ACTIVITY_STREAM_PATH}?backfill_minutes=${MAX_BACKFILL_MINUTES}`);
});

test("a dropped stream reconnects with backoff before delivering again", async () => {
  let streams = 0;
  const sleeps = [];
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({
        data: [
          { id: "a", event_type: "chat.received", filter: { user_id: ownerId } },
          { id: "b", event_type: "chat.sent", filter: { user_id: ownerId } },
        ],
      }),
    [ACTIVITY_STREAM_PATH]: () => {
      streams += 1;
      if (streams > 1) return new Response(new ReadableStream({ start() {} }), { status: 200 });
      return streamResponse([`${JSON.stringify(chatEnvelope())}\n`]);
    },
  });
  const activity = createActivityStream({ request: fetchImpl, sleep: testSleep(sleeps) });
  const events = [];
  activity.subscribe((frame) => {
    if (frame.kind === "chat") events.push(frame);
  });
  await activity.start(ownerId);
  await waitFor(() => streams >= 2);
  await waitFor(() => events.length >= 1);
  assert.equal(streams, 2);
  assert.deepEqual(sleeps.slice(0, 1), [500]);
  await activity.stop();
});

test("an expired session stops the stream and asks for reconnection", async () => {
  let reconnects = 0;
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({
        data: [
          { id: "a", event_type: "chat.received", filter: { user_id: ownerId } },
          { id: "b", event_type: "chat.sent", filter: { user_id: ownerId } },
        ],
      }),
    [ACTIVITY_STREAM_PATH]: () => {
      reconnects += 1;
      return jsonResponse({ error: "Unauthorized" }, 401);
    },
  });
  let authRequired = 0;
  const activity = createActivityStream({
    request: fetchImpl,
    sleep: testSleep(),
    onAuthRequired: () => {
      authRequired += 1;
    },
  });
  const states = [];
  activity.subscribe((frame) => {
    if (frame.kind === "status") states.push(frame.state);
  });
  await activity.start(ownerId);
  await waitFor(() => states.includes("auth-required"));
  await activity.stop();
  assert.equal(authRequired, 1);
  assert.equal(reconnects, 1);
  assert.equal(activity.status().state, "auth-required");
});

test("a rejected subscription creation is not read as already existing", async () => {
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({ title: "Invalid Request", detail: "event_type is not enabled for this client" }, 400),
  });
  const activity = createActivityStream({ request: fetchImpl });
  await assert.rejects(activity.ensureSubscriptions(ownerId), (error) => {
    const failure = /** @type {Error & { status: number }} */ (error);
    assert.equal(failure.status, 400);
    assert.match(failure.message, /event_type is not enabled/);
    return true;
  });
});

test("a duplicate subscription answer still counts as subscribed", async () => {
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () =>
      jsonResponse({ title: "Conflict", detail: "DuplicateSubscription: already subscribed" }, 400),
  });
  const activity = createActivityStream({ request: fetchImpl });
  assert.deepEqual(await activity.ensureSubscriptions(ownerId), {
    "chat.received": "existing",
    "chat.sent": "existing",
  });
});

test("a refused stream carries X's problem text into the status frame", async () => {
  const { fetchImpl } = fakeFetch({
    [ACTIVITY_SUBSCRIPTIONS_PATH]: () => jsonResponse({ data: { id: "sub-1" } }, 201),
    [ACTIVITY_STREAM_PATH]: () =>
      jsonResponse({ title: "Invalid Request", detail: "no subscriptions are active" }, 400),
  });
  const activity = createActivityStream({ request: fetchImpl, sleep: testSleep() });
  const failures = [];
  activity.subscribe((frame) => {
    if (frame.kind === "status" && frame.error) failures.push(frame.error);
  });
  await activity.start(ownerId);
  await waitFor(() => failures.some((error) => error.includes("no subscriptions are active")));
  await activity.stop();
});
