import assert from "node:assert/strict";
import test from "node:test";
import { findingsForText } from "../scripts/scan-secrets.mjs";

test("secret guard detects credential markers without exposing their values", () => {
  assert.deepEqual(findingsForText("const key = process.env.X_ACCESS_TOKEN;\n"), []);
  assert.deepEqual(findingsForText(["const token = ", "'gh", "p_abcdefghijklmnopqrstuv';"].join("")), [1]);
  assert.deepEqual(findingsForText(["-----BEGIN", " PRIVATE KEY-----\n"].join("")), [1]);
});
