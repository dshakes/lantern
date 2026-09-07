// ADR 0024 W3.1 / W3.2: the two bot-tells the audit saw most.
//   cd packages/bridge-core && npx tsx --test src/repeat-skeleton.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { detectBotTells, findRepeatSkeleton } from "./natural.ts";
import { humanizeWithOffer, humanizeReply } from "./humanize.ts";

test("the same shaped reply to the same contact is suppressed, with the prior quoted", () => {
  const recent = ["ha, will check and let you know 👍", "sare, cheptha"];
  const v = detectBotTells("Ha! Will check and let you know.", "did you see it?", { recentReplies: recent });
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /repeat-skeleton/);
  assert.match(v.reason ?? "", /will check and let you know/);
});

test("a genuinely different reply, or a short ack, is fine", () => {
  const recent = ["ha, will check and let you know 👍", "sare 👍"];
  assert.equal(findRepeatSkeleton("saw it, that place looks great. saturday works?", recent), null);
  assert.equal(findRepeatSkeleton("sare 👍", recent), null, "1–2 word acks repeat naturally");
  assert.equal(findRepeatSkeleton("ok will check", []), null, "no history → nothing to repeat");
  assert.equal(detectBotTells("saw it, that place looks great. saturday works?", "look", { recentReplies: recent }).ok, true);
});

test("no offer is appended any more; the model's own offer is still armed", () => {
  const plain = "your passport number is B0123456";
  assert.equal(humanizeReply(plain), plain, "no 'want me to save this as a note?' bolted on");
  assert.equal(humanizeWithOffer(plain).offer, null);
  const own = humanizeWithOffer("your passport number is B0123456. want me to save this as a note?");
  assert.ok(own.offer, "an offer the model chose to make is detected and cached");
  assert.equal(own.reply, "your passport number is B0123456. want me to save this as a note?");
});
