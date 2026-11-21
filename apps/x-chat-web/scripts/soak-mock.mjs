// Load/soak probe for the local mock server. It measures latency, heap
// growth, request accounting, the bounded Mock delivery queue and the
// offline (503/retryable) path. No fixtures, tokens or plaintext are used.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Agent, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const seconds = clampNumber("SOAK_SECONDS", 8, 1, 300);
const concurrency = clampNumber("SOAK_CONCURRENCY", 8, 1, 64);
const maxP95 = clampNumber("SOAK_MAX_P95_MS", 1000, 50, 60000);
const maxHeapGrowth = clampNumber("SOAK_MAX_HEAP_GROWTH_MIB", 64, 1, 4096);
const SEND_BURST = 12;

function clampNumber(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, X_CHAT_API_MODE: "mock", PORT: "0", X_ACCESS_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`mock server did not start in time\n${log}`)), 20000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
      const match = log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`mock server exited (${code})\n${log}`));
    });
  });
  return { child, ready, log: () => log };
}

const agent = new Agent({ keepAlive: true, maxSockets: Math.max(concurrency, SEND_BURST) + 4 });
let issued = 0;

function call(base, path, { method = "GET", body } = {}) {
  const url = new URL(path, base);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  issued += 1;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method,
        agent,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          ...(method === "POST" ? { "x-chat-local": "1" } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, ms: performance.now() - started });
        });
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error(`timeout on ${method} ${path}`)));
    req.on("error", reject);
    req.end(payload ?? undefined);
  });
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

const server = startServer();
try {
  const base = await server.ready;
  const statusCounts = new Map();
  const latencies = [];

  const warm = await call(base, "/api/me");
  if (warm.status !== 200 || !/^\d{1,19}$/.test(String(warm.body?.data?.id ?? ""))) {
    throw new Error(`warmup /api/me failed (${warm.status})`);
  }
  const selfId = String(warm.body.data.id);
  const before = (await call(base, "/api/metrics")).body;
  if (!before?.memory) throw new Error("could not read /api/metrics before the load");

  const routes = [
    "/api/status",
    "/api/health",
    "/api/metrics",
    "/api/me",
    `/api/public-keys?user_id=${selfId}`,
    "/api/conversations",
    "/api/events?conversation_id=1000000000000000001-1000000000000000002",
    "/api/mock/deliveries",
    "/api/contacts/lookup?username=soak_probe",
  ];
  const deadline = Date.now() + seconds * 1000;

  async function worker(offset) {
    let index = offset;
    while (Date.now() < deadline) {
      const path = routes[index++ % routes.length];
      try {
        const result = await call(base, path);
        statusCounts.set(result.status, (statusCounts.get(result.status) || 0) + 1);
        latencies.push(result.ms);
      } catch (error) {
        failures.push(`load request failed: ${error.message}`);
      }
    }
  }

  const startedLoad = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, index) => worker(index)));
  const loadSeconds = (Date.now() - startedLoad) / 1000;

  for (let index = 0; index < SEND_BURST; index += 1) {
    const sent = await call(base, "/api/send", {
      method: "POST",
      body: {
        conversation_id: "1000000000000000001-1000000000000000002",
        message_id: `soak-${index}`,
        encoded_message_create_event: "c29hay1ldmVudA==",
        encoded_message_event_signature: "c29hay1zaWc=",
        xdk_version: "0.7.1",
        event_b64: "c29hay1ldmVudA==",
      },
    });
    expect(sent.status === 200, `send burst entry ${index} returned ${sent.status}`);
    latencies.push(sent.ms);
  }
  const deliveries = await call(base, "/api/mock/deliveries");
  expect(
    Array.isArray(deliveries.body?.data) && deliveries.body.data.length >= SEND_BURST,
    "delivery queue did not record the send burst",
  );

  const offlineOn = await call(base, "/api/mock/network", {
    method: "POST",
    body: { offline: true, order: "normal", duplicate: false },
  });
  expect(offlineOn.status === 200, "could not enable mock offline mode");
  const offlineRead = await call(base, "/api/conversations");
  expect(offlineRead.status === 503, `offline read returned ${offlineRead.status} instead of 503`);
  expect(offlineRead.body?.retryable === true, "offline read was not marked retryable");
  const offlineOff = await call(base, "/api/mock/network", {
    method: "POST",
    body: { offline: false, order: "normal", duplicate: false },
  });
  expect(offlineOff.status === 200, "could not disable mock offline mode");
  const restored = await call(base, "/api/conversations");
  expect(restored.status === 200, `online read returned ${restored.status} after restore`);

  const malformed = await call(base, "/api/mock/identity", { method: "POST", body: {} });
  expect(malformed.status === 400, `malformed identity returned ${malformed.status} instead of 400`);

  await new Promise((resolve) => setTimeout(resolve, 750));
  const firstSample = (await call(base, "/api/metrics")).body;
  await new Promise((resolve) => setTimeout(resolve, 750));
  const secondSample = (await call(base, "/api/metrics")).body;
  if (!firstSample?.memory || !secondSample?.memory) throw new Error("could not read /api/metrics after the load");
  const after = secondSample;

  const heapStart = before.memory.heapUsedMiB;
  const heapEnd = Math.min(firstSample.memory.heapUsedMiB, secondSample.memory.heapUsedMiB);
  const heapGrowth = heapEnd - heapStart;
  const servedDelta = after.requests - before.requests;
  const expectedServerErrors = 1; // the offline probe deliberately returns one 503
  const unexpectedServerErrors = after.serverErrors - before.serverErrors - expectedServerErrors;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const pMax = sorted[sorted.length - 1] ?? 0;
  const statusSummary = [...statusCounts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, count]) => `${code}:${count}`)
    .join(" ");

  console.log(
    `soak-mock: ${seconds}s x ${concurrency} workers, ${latencies.length} requests, ${loadSeconds.toFixed(2)}s wall`,
  );
  console.log(`soak-mock: statuses ${statusSummary || "none"}`);
  console.log(`soak-mock: latency p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${pMax.toFixed(1)}ms`);
  console.log(
    `soak-mock: heap ${heapStart}MiB -> ${heapEnd}MiB (delta ${heapGrowth.toFixed(0)}MiB), requests delta ${servedDelta}`,
  );
  console.log(
    `soak-mock: offline read 503/retryable, send burst ${SEND_BURST}, deliveries ${deliveries.body?.data?.length ?? 0}`,
  );

  expect(unexpectedServerErrors === 0, `${unexpectedServerErrors} unexpected 5xx beyond the intentional offline 503`);
  for (const [code, count] of statusCounts) {
    expect(code < 500, `${count} load responses returned ${code}`);
  }
  expect(p95 <= maxP95, `p95 ${p95.toFixed(1)}ms exceeds ${maxP95}ms`);
  expect(heapGrowth <= maxHeapGrowth, `heap grew ${heapGrowth}MiB (limit ${maxHeapGrowth}MiB)`);
  expect(servedDelta >= issued - 3, `metrics.requests only advanced ${servedDelta} for ${issued} calls`);

  if (failures.length) {
    console.error(`soak-mock: FAIL\n- ${failures.join("\n- ")}`);
    if (server.log()) console.error(`soak-mock: server log tail\n${server.log().slice(-2000)}`);
    process.exitCode = 1;
  } else {
    console.log("soak-mock: PASS — no 5xx, bounded heap, offline path retryable");
  }
} catch (error) {
  console.error(`soak-mock: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  agent.destroy();
  server.child.kill();
  await Promise.race([once(server.child, "exit").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
