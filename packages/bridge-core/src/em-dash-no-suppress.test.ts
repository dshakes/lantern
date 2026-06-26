// Regression: an em-dash must NOT suppress the whole reply (that silently
// killed legitimate replies — e.g. the wife asking "who is he married to"
// got a generated reply that was dropped for containing "—"). Em-dashes are
// rewritten to commas in applyStyle; the reply still sends.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotTells, naturalize } from "./natural.ts";

test("em-dash does NOT trigger bot-tell suppression", () => {
  // ok:true means "send this reply". An em-dash must not flip it to ok:false.
  const v = detectBotTells("he's married to Sam — that's you 😄");
  assert.equal(v.ok, true, `em-dash must not suppress: ${JSON.stringify(v)}`);
});

test("naturalize rewrites the em-dash and still produces a non-empty reply", () => {
  const pieces = naturalize("he's married to Sam — that's you 😄", {
    inbound: "who is he married to",
    style: { mostlyLowercase: true, minimalPunctuation: true, usesAbbreviations: false, usesEmojis: true, formality: "casual", avgWordsPerMessage: 6 } as never,
  });
  const joined = pieces.map((p: { text: string }) => p.text).join(" ");
  assert.ok(joined.length > 0, "reply must not be empty");
  assert.ok(!joined.includes("—"), `em-dash must be stripped: ${joined}`);
  assert.match(joined, /married to sam/i);
});
