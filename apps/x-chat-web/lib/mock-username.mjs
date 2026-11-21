export function mockUsernameAlias(userId) {
  if (typeof userId !== "string" || !/^\d{1,19}$/.test(userId)) {
    throw new Error("Invalid mock user ID");
  }
  const alias = `m${userId.length.toString(36)}${BigInt(userId).toString(36)}`;
  if (alias.length > 15) throw new Error("Mock username alias is too long");
  return alias;
}
