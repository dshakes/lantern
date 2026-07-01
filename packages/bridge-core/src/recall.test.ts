// Unit tests for assembleRelevantRecall.
// Run: node --import=tsx/esm --test src/recall.test.ts

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleRelevantRecall, type RecallSources } from "./recall.js";
import type { Episode } from "./episodic-memory.js";

function ep(topic: string, outcome: string, ts = Date.now()): Episode {
  return { jid: "test@s.whatsapp.net", date: "2026-06-28", topic, outcome, ts };
}

describe("assembleRelevantRecall", () => {
  test("relevant inbound picks on-topic episode", () => {
    const sources: RecallSources = {
      episodes: [
        ep("house refi", "gave Sarah's number"),
        ep("japan trip", "said would join next time"),
      ],
    };
    // "house" and "refi" both appear in the episode — they must overlap.
    const result = assembleRelevantRecall("any update on the house refi?", sources);
    assert.ok(result !== null, "should return a block");
    assert.ok(
      (result ?? "").includes("Sarah") || (result ?? "").includes("house refi"),
      "should mention the refi episode",
    );
    assert.ok(!(result ?? "").includes("japan"), "should not include unrelated episode");
  });

  test("irrelevant inbound (greeting) returns null", () => {
    const sources: RecallSources = {
      episodes: [
        ep("house refi", "gave Sarah's number"),
        ep("japan trip", "said would join next time"),
      ],
    };
    const result = assembleRelevantRecall("hey how are you", sources);
    assert.strictEqual(result, null, "generic greeting → no recall block");
  });

  test("returns null when sources are empty", () => {
    assert.strictEqual(assembleRelevantRecall("what about the deal?", {}), null);
  });

  test("caps at maxItems across episodes", () => {
    const sources: RecallSources = {
      episodes: [
        ep("deal alpha", "sent contract"),
        ep("deal beta", "confirmed deal amount"),
        ep("deal gamma", "follow up on deal terms"),
        ep("deal delta", "asked about deal status"),
      ],
    };
    const result = assembleRelevantRecall("what is the deal status?", sources, { maxItems: 2 });
    assert.ok(result !== null, "should return a block");
    const bullets = (result ?? "").split("\n").filter((l) => l.startsWith("- ")).length;
    assert.ok(bullets <= 2, `expected ≤2 bullets, got ${bullets}`);
  });

  test("cross-source ranking: high-overlap episode beats low-overlap topic", () => {
    const sources: RecallSources = {
      episodes: [ep("refund", "got refund confirmed")],
      topics: [
        { text: "random chat about the weather today", ts: Date.now() },
      ],
    };
    const result = assembleRelevantRecall("did you get the refund sorted?", sources, { maxItems: 1 });
    assert.ok(result !== null, "should return a block");
    assert.ok((result ?? "").includes("refund"), "should pick the refund episode");
    assert.ok(!(result ?? "").includes("weather"), "should not pick unrelated weather topic");
  });

  test("threshold respected: no overlapping tokens → null", () => {
    const sources: RecallSources = {
      episodes: [ep("wedding", "sent rsvp for ceremony")],
    };
    // "deal" shares no tokens with "wedding" or "sent rsvp for ceremony".
    const result = assembleRelevantRecall("deal done?", sources);
    assert.strictEqual(result, null, "no token overlap → null");
  });

  test("cross-thread topics included when relevant", () => {
    const sources: RecallSources = {
      topics: [
        {
          text: "Sujith mentioned the pitch went really well",
          ts: Date.now(),
          contactName: "Sujith",
          fromMe: false,
        },
      ],
    };
    const result = assembleRelevantRecall("how did the pitch go?", sources);
    assert.ok(result !== null, "should return a block");
    assert.ok(
      (result ?? "").includes("pitch") || (result ?? "").includes("Sujith"),
      "should mention the pitch topic",
    );
  });

  test("commitments included when title overlaps inbound", () => {
    const sources: RecallSources = {
      commitments: [{ title: "send Raju the deck" }, { title: "book dentist appointment" }],
    };
    const result = assembleRelevantRecall("did you send Raju that deck?", sources);
    assert.ok(result !== null, "should return a block");
    assert.ok((result ?? "").includes("deck"), "should surface the deck commitment");
    assert.ok(!(result ?? "").includes("dentist"), "should not surface unrelated dentist item");
  });

  test("episode outcome hedged when confidence absent, plain when confident", () => {
    const unverified = assembleRelevantRecall("any update on the loan?", {
      episodes: [ep("loan", "referred to mortgage broker")], // no confidence
    });
    assert.ok((unverified ?? "").includes("[unverified — from an earlier note]"), "absent confidence → hedged");

    const confident: RecallSources = {
      episodes: [{ ...ep("loan", "referred to mortgage broker"), confidence: 0.9 }],
    };
    const verified = assembleRelevantRecall("any update on the loan?", confident);
    assert.ok(!(verified ?? "").includes("[unverified"), "high confidence → not hedged");
    assert.ok((verified ?? "").includes("mortgage broker"), "outcome still surfaced");
  });

  test("block format: header + bullets", () => {
    const sources: RecallSources = {
      episodes: [ep("loan", "referred to mortgage broker")],
    };
    const result = assembleRelevantRecall("any update on the loan?", sources);
    assert.ok(result !== null);
    const lines = (result ?? "").split("\n");
    assert.ok(lines[0].startsWith("## Relevant context"), "first line is the header");
    assert.ok(lines.some((l) => l.startsWith("- ")), "at least one bullet");
  });
});
