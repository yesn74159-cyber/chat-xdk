#!/usr/bin/env node
/**
 * Live-mode launcher for operators who prefer to paste the access token after
 * starting instead of exporting it first. The token is read from the terminal
 * with echo disabled and is only ever held in process memory — never written to
 * disk, logs, shell history, or the browser. Prefer OAuth (X_OAUTH_CLIENT_ID)
 * when available: then no token is needed at all.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const port = process.env.PORT || "8787";
const dryRun = process.env.X_CHAT_START_LIVE_DRY_RUN === "1";

function promptSecret(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY) {
      reject(new Error("ต้องรันใน terminal แบบ interactive; หรือตั้ง X_ACCESS_TOKEN ใน environment แทน"));
      return;
    }
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (result, error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(result);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish("", new Error("ยกเลิกโดยผู้ใช้"));
        if (character === "\r" || character === "\n") return finish(value.trim(), null);
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    stdin.on("data", onData);
  });
}

const hasToken = Boolean(process.env.X_ACCESS_TOKEN);
const oauthConfigured = Boolean(process.env.X_OAUTH_CLIENT_ID);

if (dryRun) {
  if (hasToken) console.log("dry-run: will start with X_ACCESS_TOKEN from the environment");
  else if (oauthConfigured) console.log("dry-run: OAuth mode; sign in at /api/auth/login after start");
  else {
    console.error("start:live: ต้องมี X_ACCESS_TOKEN หรือ X_OAUTH_CLIENT_ID");
    process.exit(2);
  }
  process.exit(0);
}

const build = spawnSync(npmCommand, ["run", "build"], { cwd: appRoot, stdio: "inherit", env: process.env });
if (build.status !== 0) {
  console.error("start:live: build ไม่สำเร็จ");
  process.exit(build.status ?? 1);
}

if (!hasToken && !oauthConfigured) {
  let token = "";
  try {
    token = await promptSecret("วาง X access token (จะไม่แสดงบนจอ): ");
  } catch (error) {
    console.error(`start:live: ${error.message}`);
    process.exit(2);
  }
  if (!token) {
    console.error(
      "start:live: ไม่มี token — ตั้ง X_OAUTH_CLIENT_ID แล้วเข้า /api/auth/login หรือรันคำสั่งนี้ใหม่แล้ววาง token",
    );
    process.exit(2);
  }
  process.env.X_ACCESS_TOKEN = token;
}

if (process.env.X_ACCESS_TOKEN) {
  console.log("start:live: token ถูกโหลดเข้า process แล้ว (ซ่อนอยู่ ไม่ถูกบันทึกที่ไหน)");
} else {
  console.log(`start:live: โหมด OAuth — เปิด http://127.0.0.1:${port}/api/auth/login เพื่อเชื่อมต่อบัญชี X`);
}

const server = spawn(process.execPath, ["server.mjs"], { cwd: appRoot, stdio: "inherit", env: process.env });
server.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.kill(signal));
}
