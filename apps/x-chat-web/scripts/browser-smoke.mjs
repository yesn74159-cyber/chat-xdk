// Leak-free browser smoke test: drives the built mock server with the
// system Chrome/Edge through playwright-core. No browser binary is downloaded.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const PASSPHRASE = "correct horse battery staple";
const CACHE_DATABASE = "x-chat-local-cache-v1";

function which(binary) {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [binary], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    return "";
  }
}

function findBrowser() {
  if (process.env.X_CHAT_BROWSER_PATH) return process.env.X_CHAT_BROWSER_PATH;
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    resolve(programFiles, "Google/Chrome/Application/chrome.exe"),
    resolve(programFilesX86, "Google/Chrome/Application/chrome.exe"),
    localAppData && resolve(localAppData, "Google/Chrome/Application/chrome.exe"),
    resolve(programFiles, "Microsoft/Edge/Application/msedge.exe"),
    resolve(programFilesX86, "Microsoft/Edge/Application/msedge.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const installed = candidates.find((candidate) => candidate && existsSync(candidate));
  if (installed) return installed;
  for (const binary of ["google-chrome", "chromium", "microsoft-edge"]) {
    const found = which(binary);
    if (found) return found;
  }
  return "";
}

const browserPath = findBrowser();
if (!browserPath) {
  if (process.env.X_CHAT_BROWSER_REQUIRED === "1") {
    console.error("browser-smoke: FAIL — no Chrome/Edge found (set X_CHAT_BROWSER_PATH)");
    process.exit(1);
  }
  console.log("browser-smoke: SKIP — no Chrome/Edge found (set X_CHAT_BROWSER_PATH to run)");
  process.exit(0);
}

const { chromium } = await import("playwright-core");

function startServer() {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: appRoot,
    env: { ...process.env, X_CHAT_API_MODE: "mock", PORT: "0", X_ACCESS_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
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
  return { child, ready };
}

function collectErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if ((message.location()?.url || "").endsWith("/favicon.ico")) return;
    errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function waitForApp(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.querySelector("#connection-status")?.textContent?.includes("กำลังตรวจ"),
    null,
    { timeout: 20000 },
  );
}

async function openCacheSection(page) {
  await page.click("#settings-toggle");
  await page.waitForSelector("#settings-panel[open]", { timeout: 10000 });
  const section = page.locator("details", { has: page.locator("#cache-passphrase") });
  await section.evaluate((node) => {
    node.open = true;
  });
}

async function unlockCache(page, expectedText) {
  await page.fill("#cache-passphrase", PASSPHRASE);
  await page.click("#unlock-cache");
  await page.waitForFunction(
    (expected) => document.querySelector("#cache-status")?.textContent?.includes(expected),
    expectedText,
    { timeout: 20000 },
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(scrollWidth <= innerWidth + 1, `${label}: horizontal overflow ${scrollWidth}px > ${innerWidth}px`);
}

async function readStoredEnvelope(page) {
  return page.evaluate(
    (database) =>
      new Promise((resolveRead, reject) => {
        const open = indexedDB.open(database, 1);
        open.onerror = () => reject(new Error("Unable to open cache database"));
        open.onsuccess = () => {
          const request = open.result.transaction("cache", "readonly").objectStore("cache").get("current");
          request.onsuccess = () => {
            open.result.close();
            resolveRead(request.result);
          };
          request.onerror = () => reject(new Error("Unable to read cache record"));
        };
      }),
    CACHE_DATABASE,
  );
}

// unlockCache() reports success before saveCache() settles, so poll briefly.
async function waitForStoredEnvelope(page, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const envelope = await readStoredEnvelope(page);
    if (envelope) return envelope;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("encrypted cache record was not persisted");
}

async function waitForMissingEnvelope(page, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await readStoredEnvelope(page))) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("encrypted cache record was not deleted");
}

const server = startServer();
const scenarios = [];
const failures = [];

async function scenario(name, run) {
  try {
    await run();
    scenarios.push(name);
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

let browser;
try {
  const baseUrl = await server.ready;
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  console.log(`browser-smoke: ${browserPath} (${browser.version()}) against ${baseUrl}`);

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "th-TH" });
  const page = await desktop.newPage();
  const desktopErrors = collectErrors(page);

  await scenario("desktop load and unread filter wiring", async () => {
    await waitForApp(page, baseUrl);
    const status = await page.textContent("#connection-status");
    assert.match(status, /Mock API/);
    await page.click('button[data-filter="unread"]');
    assert.equal(await page.getAttribute('button[data-filter="unread"]', "aria-pressed"), "true");
    assert.equal(await page.getAttribute('button[data-filter="all"]', "aria-pressed"), "false");
    await page.click('button[data-filter="all"]');
    assert.equal(await page.getAttribute('button[data-filter="all"]', "aria-pressed"), "true");
    await assertNoHorizontalOverflow(page, "desktop");
  });

  await scenario("desktop settings open and cache unlock stores ciphertext only", async () => {
    await openCacheSection(page);
    await unlockCache(page, "cache ใหม่พร้อมใช้งาน");
    const envelope = await waitForStoredEnvelope(page);
    assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "iv", "salt", "version"]);
    assert.equal(envelope.version, 1);
    await page.click("#settings-close");
  });

  await scenario("desktop restart reopens the persisted cache", async () => {
    await waitForApp(page, baseUrl);
    await assertNoHorizontalOverflow(page, "desktop restart");
    await openCacheSection(page);
    await unlockCache(page, "ปลดล็อก cache แล้ว");
    await page.click("#settings-close");
  });

  await scenario("desktop export, clear and restore round trip", async () => {
    await openCacheSection(page);
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#export-cache")]);
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.deepEqual(Object.keys(exported).sort(), ["ciphertext", "iv", "salt", "version"]);
    assert.deepEqual(await waitForStoredEnvelope(page), exported);

    const scratch = await mkdtemp(join(tmpdir(), "x-chat-smoke-"));
    try {
      const oversized = join(scratch, "oversized.json");
      await writeFile(oversized, Buffer.alloc(20 * 1024 * 1024 + 1, 0x20));
      await page.setInputFiles("#import-cache", oversized);
      await page.waitForFunction(
        () => document.querySelector("#activity")?.textContent?.includes("ใหญ่เกินขีดจำกัด"),
        null,
        { timeout: 10000 },
      );
      assert.deepEqual(await readStoredEnvelope(page), exported);

      const rejected = join(scratch, "rejected.json");
      await writeFile(rejected, JSON.stringify({ version: 1, salt: "", iv: "aXY=", ciphertext: "Y3Q=" }));
      await page.setInputFiles("#import-cache", rejected);
      await page.waitForFunction(
        () => document.querySelector("#activity")?.textContent?.includes("ไม่ใช่รูปแบบที่รองรับ"),
        null,
        { timeout: 10000 },
      );
      assert.deepEqual(await readStoredEnvelope(page), exported);

      page.once("dialog", (dialog) => dialog.accept());
      await page.click("#clear-cache");
      await page.waitForFunction(
        () => document.querySelector("#cache-status")?.textContent === "ลบข้อมูล local แล้ว",
        null,
        { timeout: 10000 },
      );
      await waitForMissingEnvelope(page);

      const restored = join(scratch, "cache.json");
      await writeFile(restored, JSON.stringify(exported));
      await page.setInputFiles("#import-cache", restored);
      await page.waitForFunction(
        () => document.querySelector("#cache-status")?.textContent?.includes("นำเข้า ciphertext cache แล้ว"),
        null,
        { timeout: 10000 },
      );
      assert.deepEqual(await waitForStoredEnvelope(page), exported);
      await unlockCache(page, "ปลดล็อก cache แล้ว");
      await page.click("#settings-close");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  await scenario("desktop conversation list renders and filters the created group", async () => {
    await page.click("#settings-toggle");
    await page.waitForSelector("#settings-panel[open]", { timeout: 10000 });
    const diagnostics = page.locator("details", { has: page.locator("#create-mock-identity") });
    await diagnostics.evaluate((node) => {
      node.open = true;
    });
    await page.click("#create-mock-identity");
    await page.waitForFunction(
      () => document.querySelector("#activity")?.textContent?.includes("ตัวตน Mock พร้อมแล้ว"),
      null,
      { timeout: 30000 },
    );
    const groupSection = page.locator("details", { has: page.locator("#create-group") });
    await groupSection.evaluate((node) => {
      node.open = true;
    });
    await page.click("#create-group");
    await page.waitForFunction(
      () => document.querySelector("#activity")?.textContent?.includes("สร้างกลุ่มแล้ว"),
      null,
      {
        timeout: 30000,
      },
    );
    const groupItem = page.locator('#conversation-list .conversation-item[data-kind="group"]');
    await groupItem.first().waitFor({ state: "visible", timeout: 20000 });
    assert.equal(await groupItem.first().locator(".conversation-name").textContent(), "กลุ่ม");
    await page.click("#settings-close");
    await page.click('button[data-filter="unread"]');
    await page.waitForSelector("#conversation-list .list-empty", { timeout: 10000 });
    await page.click('button[data-filter="all"]');
    await groupItem.first().waitFor({ state: "visible", timeout: 10000 });
    await page.fill("#conversation-search", "ไม่มีบทสนทนานี้");
    await page.waitForSelector("#conversation-list .list-empty", { timeout: 10000 });
    await page.fill("#conversation-search", "");
    await groupItem.first().waitFor({ state: "visible", timeout: 10000 });
  });

  await scenario("desktop offline keeps the shell usable", async () => {
    const offlinePage = await desktop.newPage();
    const pageErrors = [];
    offlinePage.on("pageerror", (error) => pageErrors.push(error.message));
    await offlinePage.route("**/api/**", (route) => route.abort());
    await offlinePage.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await offlinePage.waitForFunction(
      () => document.querySelector("#connection-status")?.textContent === "SDK ยังไม่พร้อม",
      null,
      { timeout: 20000 },
    );
    assert.equal(await offlinePage.isVisible("#settings-toggle"), true);
    assert.equal(await offlinePage.isVisible("#conversation-list"), true);
    assert.deepEqual(pageErrors, []);
    await offlinePage.close();
  });

  await scenario("desktop accessible names, dialog focus and live regions", async () => {
    const unnamed = await page.evaluate(() => {
      const nameFor = (element) => {
        const labelledBy = element.getAttribute("aria-labelledby");
        const labelledText = labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent || "")
              .join(" ")
          : "";
        const labels = element.labels ? [...element.labels].map((label) => label.textContent || "").join(" ") : "";
        return (
          element.getAttribute("aria-label") ||
          labelledText ||
          labels ||
          element.textContent ||
          element.getAttribute("title") ||
          ""
        ).trim();
      };
      return [...document.querySelectorAll("button, input, select, textarea, a[href]")]
        .filter((element) => element.getClientRects().length > 0 && element.type !== "hidden")
        .filter((element) => !nameFor(element))
        .map((element) => element.outerHTML.slice(0, 120));
    });
    assert.deepEqual(unnamed, [], `controls without an accessible name: ${unnamed.join(" | ")}`);

    for (const id of ["unlock-status", "messages", "send-state", "activity", "conversation-list"]) {
      const live = await page.getAttribute(`#${id}`, "aria-live");
      const role = await page.getAttribute(`#${id}`, "role");
      assert.ok(live === "polite" || role === "status", `#${id} is not a polite live region`);
    }

    await page.click("#settings-toggle");
    await page.waitForSelector("#settings-panel[open]", { timeout: 10000 });
    assert.equal(
      await page.evaluate(() => document.querySelector("#settings-panel").contains(document.activeElement)),
      true,
      "focus did not move into the settings dialog",
    );
    assert.equal(await page.getAttribute("#settings-panel", "aria-labelledby"), "settings-title");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#settings-panel[open]"), null, { timeout: 10000 });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "settings-toggle",
      "focus did not return to the settings trigger after Escape",
    );
  });

  await scenario("desktop console is clean", async () => {
    assert.deepEqual(desktopErrors, []);
  });

  const mobile = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mobilePage = await mobile.newPage();
  const mobileErrors = collectErrors(mobilePage);

  await scenario("mobile 375px load, settings and cache unlock", async () => {
    await waitForApp(mobilePage, baseUrl);
    await assertNoHorizontalOverflow(mobilePage, "mobile");
    await openCacheSection(mobilePage);
    await unlockCache(mobilePage, "cache ใหม่พร้อมใช้งาน");
    await mobilePage.click("#settings-close");
    await assertNoHorizontalOverflow(mobilePage, "mobile after settings");
    assert.deepEqual(mobileErrors, []);
  });

  await desktop.close();
  await mobile.close();

  const zoomProxy = await browser.newContext({ viewport: { width: 640, height: 450 }, locale: "th-TH" });
  const zoomPage = await zoomProxy.newPage();
  await scenario("1280x900 at 200% zoom reflow proxy (640x450)", async () => {
    await waitForApp(zoomPage, baseUrl);
    await assertNoHorizontalOverflow(zoomPage, "640x450");
    await openCacheSection(zoomPage);
    await assertNoHorizontalOverflow(zoomPage, "640x450 with settings");
  });
  await zoomProxy.close();
} finally {
  if (browser) await browser.close();
  server.child.kill();
}

console.log(`browser-smoke: ${scenarios.length} scenario(s) passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
