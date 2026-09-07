import { test } from "node:test";
import { strict as assert } from "node:assert";
import { strictRegenHint } from "./natural.ts";

test("the third-attempt hint carries both reasons, the shape rule, and real exemplars", () => {
  const h = strictRegenHint({ ownerName: "Shekhar", reasons: ["customer-service phrase", "repeat-skeleton: …"], exemplars: ["ha will check", "sare 👍", "on my way", "extra"] });
  assert.match(h, /customer-service phrase; then repeat-skeleton/);
  assert.match(h, /ONE short line/);
  assert.match(h, /> ha will check/);
  assert.doesNotMatch(h, /> extra/, "at most three exemplars");
  assert.match(h, /\[\[NO_REPLY\]\]/);
  assert.doesNotMatch(strictRegenHint({ ownerName: "S", reasons: ["x"], exemplars: [] }), /really writes/);
});
