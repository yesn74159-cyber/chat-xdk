import { normalizeUsername } from "./contact-lookup.mjs";

const MAX_USERNAMES = 10;
const LOOKUP_CONCURRENCY = 2;

export function parseContactUsernames(value) {
  if (typeof value !== "string") throw new Error("กรอก Username อย่างน้อยหนึ่งรายการ");
  const tokens = value.split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) throw new Error("กรอก Username อย่างน้อยหนึ่งรายการ");

  const usernames = [];
  const seen = new Set();
  for (const token of tokens) {
    const username = normalizeUsername(token);
    if (seen.has(username)) continue;
    seen.add(username);
    usernames.push(username);
    if (usernames.length > MAX_USERNAMES) throw new Error("ค้นหาได้ไม่เกิน 10 Username ต่อครั้ง");
  }
  return usernames;
}

export async function lookupContactsWithLimit(usernames, lookup, isCurrent = () => true) {
  if (!Array.isArray(usernames) || typeof lookup !== "function") {
    throw new Error("รายการ Username หรือฟังก์ชันค้นหาไม่ถูกต้อง");
  }
  const results = new Array(usernames.length);
  let nextIndex = 0;
  let rateLimited = false;

  async function worker() {
    while (isCurrent() && !rateLimited) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= usernames.length) return;
      const username = usernames[index];
      try {
        results[index] = { username, contact: await lookup(username), error: null };
      } catch (error) {
        const status = Number(error?.status || 0);
        results[index] = { username, contact: null, error };
        if (status === 429) rateLimited = true;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, usernames.length) }, worker));
  for (let index = 0; index < usernames.length; index += 1) {
    if (!results[index]) {
      results[index] = {
        username: usernames[index],
        contact: null,
        error: {
          status: rateLimited ? 429 : 0,
          message: rateLimited
            ? "ไม่ได้ค้นหารายการที่เหลือหลังได้รับ HTTP 429; กดค้นหาใหม่ภายหลัง"
            : "ยกเลิกการค้นหาก่อนส่งคำขอ",
        },
      };
    }
  }
  return results;
}
