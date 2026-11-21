import { access, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { normalizeUsername } from "../public/contact-lookup.mjs";
import { canonicalDirectConversationId } from "../public/direct-conversation-id.mjs";

const MAX_PERMIT_LIFETIME_MS = 10 * 60 * 1000;
const EXPIRY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const USER_ID_PATTERN = /^\d{1,19}$/;

/**
 * The approved Live Create target comes from the operator's environment so test
 * account identifiers never live in source. Any missing or malformed value
 * leaves Live Create disabled.
 */
export function liveCreateTargetFromEnv(env = process.env) {
  const ownerUserId = String(env.X_CHAT_LIVE_OWNER_USER_ID ?? "").trim();
  const recipientUserId = String(env.X_CHAT_LIVE_RECIPIENT_USER_ID ?? "").trim();
  if (!USER_ID_PATTERN.test(ownerUserId) || !USER_ID_PATTERN.test(recipientUserId) || ownerUserId === recipientUserId) {
    return null;
  }
  let ownerUsername;
  let recipientUsername;
  try {
    ownerUsername = normalizeUsername(env.X_CHAT_LIVE_OWNER_USERNAME);
    recipientUsername = normalizeUsername(env.X_CHAT_LIVE_RECIPIENT_USERNAME);
  } catch {
    return null;
  }
  return Object.freeze({
    ownerUsername,
    ownerUserId,
    recipientUsername,
    recipientUserId,
    conversationId: canonicalDirectConversationId(ownerUserId, recipientUserId),
  });
}

function error(message, status) {
  return Object.assign(new Error(message), { status });
}

function isExactTarget(input, target) {
  if (!target) return false;
  try {
    return (
      input?.owner_user_id === target.ownerUserId &&
      input?.recipient_user_id === target.recipientUserId &&
      normalizeUsername(input?.recipient_username) === target.recipientUsername &&
      input?.conversation_id === target.conversationId
    );
  } catch {
    return false;
  }
}

function defaultDirectory() {
  const userData = process.env.LOCALAPPDATA || join(homedir(), ".local", "share");
  return join(userData, "X Chat");
}

/** @param {{ directory?: string, permitPath?: string, consumedPath?: string, now?: () => number, env?: Record<string, string | undefined>, target?: object | null }} [options] */
export function createLiveCreatePermit({ directory, permitPath, consumedPath, now = Date.now, env, target } = {}) {
  const stateDirectory = directory || defaultDirectory();
  const activePermitPath = permitPath || join(stateDirectory, "live-create-permit.json");
  const durableClaimPath = consumedPath || join(stateDirectory, "live-create-consumed");
  const activeTarget = target === undefined ? liveCreateTargetFromEnv(env) : target;

  async function hasActivePermit() {
    let permit;
    try {
      permit = JSON.parse(await readFile(activePermitPath, "utf8"));
    } catch {
      return false;
    }
    if (
      !permit ||
      typeof permit !== "object" ||
      Array.isArray(permit) ||
      Object.keys(permit).length !== 1 ||
      typeof permit.expiresAt !== "string" ||
      !EXPIRY_PATTERN.test(permit.expiresAt)
    ) {
      return false;
    }
    const expiresAt = Date.parse(permit.expiresAt);
    const remaining = expiresAt - now();
    if (!Number.isFinite(expiresAt) || remaining <= 0 || remaining > MAX_PERMIT_LIFETIME_MS) return false;
    try {
      await access(durableClaimPath);
      return false;
    } catch (caught) {
      if (caught?.code !== "ENOENT") return false;
    }
    return true;
  }

  return {
    isTargetConfigured: () => activeTarget !== null,
    isEnabled: hasActivePermit,
    async isAuthorized(input) {
      return isExactTarget(input, activeTarget) && (await hasActivePermit());
    },
    async claim(input) {
      if (!activeTarget) throw error("Live Create target is not configured", 501);
      if (!isExactTarget(input, activeTarget)) throw error("Live Create target is not authorized", 403);
      if (!(await hasActivePermit())) throw error("One-shot Live Create permit is disabled or expired", 501);
      await mkdir(dirname(durableClaimPath), { recursive: true });
      let claim;
      try {
        claim = await open(durableClaimPath, "wx", 0o600);
      } catch (caught) {
        if (caught?.code === "EEXIST") throw error("One-shot Live Create permit is already claimed", 409);
        throw caught;
      }
      try {
        await claim.writeFile("consumed\n");
        await claim.sync();
      } finally {
        await claim.close();
      }
    },
  };
}
