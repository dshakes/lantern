// Last-pass guard against template placeholders reaching a real person.
//   cd packages/bridge-core && node --import=tsx/esm --test src/template-leakage.test.ts
//
// Regression origin: a codeless OTP interpolated a missing field and the bot
// texted the owner "🔑 your code is undefined — (i won't share this with
// anyone)." 11 times over 36 days. The source template is fixed, but the
// source fix only covers the ONE template that burned us; detectBotTells is
// the last pass before every send, so the net belongs there too.
//
// The risk of a guard like this is over-suppression — silencing a real reply
// is worse than the bug it prevents (see the "never silent" rule). So the
// negative cases below matter as much as the positive ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBotTells } from "./natural.js";

const INBOUND = "hey what's the code";

function suppressed(draft: string) {
  return detectBotTells(draft, INBOUND, { audience: "contact" });
}

test("REGRESSION: the exact string shipped to the owner 11x is suppressed", () => {
  const r = suppressed("🔑 your code is undefined — (i won't share this with anyone).");
  assert.equal(r.ok, false, "codeless OTP must never reach a human");
  assert.match(String(r.reason), /template placeholder/i);
});

test("other placeholder shapes are caught too", () => {
  for (const draft of [
    "your package arrives NaN",
    "hey [object Object] just landed",
    "meeting at ${time} tomorrow",
    "undefined",
  ]) {
    assert.equal(suppressed(draft).ok, false, `should suppress: ${draft}`);
  }
});

// The guard must not fire on ordinary human sentences that merely contain
// these words. A false positive here means a real reply is dropped.
test("legitimate prose containing the words is NOT suppressed", () => {
  for (const draft of [
    "that behavior is undefined in the spec, ask the vendor",
    "the object was left on the table",
    "nan is coming over on saturday",
    "we should define the scope first",
  ]) {
    const r = suppressed(draft);
    assert.notEqual(
      r.reason,
      "template placeholder leaked into draft (undefined/NaN/${})",
      `must NOT suppress as template leakage: ${draft}`,
    );
  }
});

test("word-boundary: 'undefined' inside a larger token is not a placeholder", () => {
  const r = suppressed("check the undefined_field column when you get a sec");
  assert.notEqual(r.reason, "template placeholder leaked into draft (undefined/NaN/${})");
});
