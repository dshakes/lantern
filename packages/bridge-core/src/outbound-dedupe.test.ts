// Tests for the outbound duplicate-send backstop.
//   cd packages/bridge-core && npx tsx --test src/outbound-dedupe.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { isDuplicateSend, OutboundDedupe } from "./outbound-dedupe.ts";

const WINDOW = 90_000;

test("suppresses an exact duplicate inside the window", () => {
  const prev = { text: "can we chat after 6 PM today?", at: 1000 };
  assert.equal(isDuplicateSend(prev, "can we chat after 6 PM today?", 1000 + 5_000, WINDOW), true);
});

test("ignores whitespace/case differences", () => {
  const prev = { text: "Can we chat after 6 PM today?", at: 1000 };
  assert.equal(isDuplicateSend(prev, "can we   chat after 6 pm today?", 1000 + 1_000, WINDOW), true);
});

test("allows the same text again once the window has passed", () => {
  const prev = { text: "can we chat after 6 PM today?", at: 1000 };
  assert.equal(isDuplicateSend(prev, "can we chat after 6 PM today?", 1000 + WINDOW + 1, WINDOW), false);
});

test("never dedups trivial acks (humans repeat those)", () => {
  const prev = { text: "ok", at: 1000 };
  assert.equal(isDuplicateSend(prev, "ok", 1000 + 1_000, WINDOW), false);
  const prev2 = { text: "yeah", at: 1000 };
  assert.equal(isDuplicateSend(prev2, "yeah", 1000 + 1_000, WINDOW), false);
});

test("a different reply is not a duplicate", () => {
  const prev = { text: "can we chat after 6 PM today?", at: 1000 };
  assert.equal(isDuplicateSend(prev, "actually let's do tomorrow", 1000 + 1_000, WINDOW), false);
});

test("OutboundDedupe.check: first send passes, immediate repeat is suppressed", () => {
  const d = new OutboundDedupe(WINDOW);
  const jid = "1555@s.whatsapp.net";
  assert.equal(d.check(jid, "can we chat after 6 PM today?", 1000), false); // first → send
  assert.equal(d.check(jid, "can we chat after 6 PM today?", 1000 + 2_000), true); // dup → suppress
  // different contact, same text → allowed
  assert.equal(d.check("other@s.whatsapp.net", "can we chat after 6 PM today?", 1000 + 2_000), false);
});
