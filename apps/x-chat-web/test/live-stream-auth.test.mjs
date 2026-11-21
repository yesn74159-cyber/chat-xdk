import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

const appRoot = new URL("../", import.meta.url);
const userToken = "test-only-user-token-placeholder";
const appBearer = "test-only-app-bearer-placeholder";
const ownerId = "1111111111111111111";
const peerId = "2222222222222222222";

function startFakeX(seen) {
  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    seen.push({ method: req.method, path, auth: req.headers.authorization ?? "" });
    if (path === "/2/users/me") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: { id: ownerId } }));
    }
    if (path === "/2/activity/subscriptions") {
      for await (const _ of req);
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: { id: `sub-${seen.length}` } }));
    }
    if (path === "/2/activity/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `${JSON.stringify({
          data: {
            event_uuid: "evt-1",
            event_type: "chat.received",
            created_at: "2026-11-21T10:00:00.000Z",
            payload: {
              id: "m-1",
              conversation_id: `${peerId}:${ownerId}`,
              sender_id: peerId,
              conversation_key_version: "1",
            },
          },
        })}\n`,
      );
      setTimeout(() => res.end(), 500);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return server;
}

function startServer(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, X_CHAT_API_MODE: "live", PORT: "0", ...env },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const ready = new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("server did not start")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, ready };
}

function readStreamUntilChat(base) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const request = httpRequest(`${base}/api/stream`, (response) => {
      const status = response.statusCode;
      response.setEncoding("utf8");
      let buffer = "";
      response.on("data", (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (!block.trim() || block.startsWith(":")) continue;
          frames.push(block);
          if (block.startsWith("event: chat")) {
            request.destroy();
            resolve({ status, frames });
          }
        }
      });
      response.on("end", () => resolve({ status, frames }));
    });
    request.once("error", reject);
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`no chat frame: ${frames.join(" | ")}`));
    }, 8000);
    request.once("close", () => clearTimeout(timeout));
    request.end();
  });
}

test("the activity stream authenticates with the app-only bearer token", { timeout: 25_000 }, async () => {
  const seen = [];
  const upstream = startFakeX(seen);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  const upstreamPort = typeof address === "object" && address ? address.port : 0;
  const { child, ready } = startServer({
    X_ACCESS_TOKEN: userToken,
    X_APP_BEARER_TOKEN: appBearer,
    X_API_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  });
  try {
    const base = await ready;
    const { status, frames } = await readStreamUntilChat(base);
    assert.equal(status, 200);
    assert.ok(frames.some((frame) => frame.startsWith("event: chat")));
    const streamCall = seen.find((call) => call.path === "/2/activity/stream");
    const subscribeCalls = seen.filter((call) => call.path === "/2/activity/subscriptions");
    assert.equal(streamCall.auth, `Bearer ${appBearer}`);
    assert.ok(subscribeCalls.length >= 1);
    for (const call of subscribeCalls) assert.equal(call.auth, `Bearer ${userToken}`);
    assert.equal(
      seen.filter((call) => call.auth === `Bearer ${appBearer}`).length,
      1,
      "the app-only bearer must not be sent to subscription routes",
    );
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    upstream.close();
  }
});
