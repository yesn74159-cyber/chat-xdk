import assert from "node:assert/strict";
import test from "node:test";
import { lookupDirectConversations } from "../lib/direct-conversation-lookup.mjs";
import { UpstreamError } from "../lib/upstream.mjs";

const OWNER = "1000000000000000001";
const PEER = "1000000000000000002";
const OTHER = "1000000000000000003";
const PEER_USER = { id: PEER, username: "peer" };

function page(data, meta = { has_more: false }, users = []) {
  return { data, includes: { users }, meta };
}

test("an existing canonical direct conversation is reported once", async () => {
  const result = await lookupDirectConversations(
    async () =>
      page([{ id: `${OWNER}-${PEER}`, type: "direct", participant_ids: [OWNER, PEER], unread: false }], undefined, [
        PEER_USER,
      ]),
    OWNER,
    PEER,
  );
  assert.equal(result.lookup, "existing");
  assert.equal(result.conversations.data[0].id, `${OWNER}-${PEER}`);
  assert.equal(result.conversations.includes.users[0].username, "peer");
});

test("two matching conversations are ambiguous, not silently picked", async () => {
  const result = await lookupDirectConversations(
    async () =>
      page([
        { id: `${OWNER}-${PEER}`, type: "direct", participant_ids: [OWNER, PEER] },
        { id: `${PEER}-${OWNER}`, type: "direct", participant_ids: [PEER, OWNER] },
      ]),
    OWNER,
    PEER,
  );
  assert.equal(result.lookup, "ambiguous");
  assert.equal(result.conversations.data.length, 2);
});

test("unexpected participant shapes downgrade the answer to incomplete", async () => {
  const result = await lookupDirectConversations(
    async () => page([{ id: `${OWNER}-${PEER}`, type: "direct", participant_ids: [OWNER] }]),
    OWNER,
    PEER,
  );
  assert.equal(result.lookup, "incomplete");
  assert.deepEqual(result.conversations.data, []);
});

test("conversations with other recipients are not offered as available", async () => {
  const result = await lookupDirectConversations(
    async () => page([{ id: `${OWNER}-${OTHER}`, type: "direct", participant_ids: [OWNER, OTHER] }]),
    OWNER,
    PEER,
  );
  assert.equal(result.lookup, "available");
  assert.deepEqual(result.conversations.data, []);
});

test("pagination follows next_token and merges users", async () => {
  const calls = [];
  const result = await lookupDirectConversations(
    async (path) => {
      calls.push(path);
      if (calls.length === 1) {
        return page([{ id: `${OWNER}-${OTHER}`, type: "direct", participant_ids: [OWNER, OTHER] }], {
          has_more: true,
          next_token: "page-2",
        });
      }
      return page([{ id: `${OWNER}-${PEER}`, type: "direct", participant_ids: [OWNER, PEER] }], undefined, [PEER_USER]);
    },
    OWNER,
    PEER,
  );
  assert.equal(calls.length, 2);
  assert.match(calls[1], /pagination_token=page-2/);
  assert.equal(result.lookup, "existing");
  assert.equal(result.conversations.includes.users[0].id, PEER);
});

test("an upstream rate limit is reported with its category and status", async () => {
  const result = await lookupDirectConversations(
    async () => {
      throw new UpstreamError("rate limited", { status: 429, retryable: true });
    },
    OWNER,
    PEER,
  );
  assert.equal(result.lookup, "error");
  assert.deepEqual(result.error, { category: "rate_limited", status: 429 });
});

test("non-upstream errors still propagate", async () => {
  await assert.rejects(
    () =>
      lookupDirectConversations(
        async () => {
          throw new TypeError("boom");
        },
        OWNER,
        PEER,
      ),
    /boom/,
  );
});
