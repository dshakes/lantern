import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { rephraseNudge } from "./nudge-voice.ts";

describe("rephraseNudge — GA safety guards", () => {
  test("accepts a faithful rewrite that keeps the numbers + affordance", async () => {
    const det = "🏃 8k steps — 1.5k to your 8k goal, quick walk before dinner?";
    const out = await rephraseNudge(det, async () => "🏃 at 8k today, 1.5k short of your 8k goal — fancy a quick walk?");
    assert.notEqual(out, det); // it varied
    assert.match(out, /8k/);
  });

  test("rejects a rewrite that CHANGES a number → falls back to deterministic", async () => {
    const det = "😴 ~5.2h last night — want me to protect a focus block? reply yes";
    const out = await rephraseNudge(det, async () => "😴 ~6h last night, want me to guard a focus block? reply yes");
    assert.equal(out, det); // 6 ≠ 5.2 → unsafe → fallback
  });

  test("rejects a rewrite that INVENTS a number", async () => {
    const det = "🅿️ parked — all clear.";
    const out = await rephraseNudge(det, async () => "🅿️ parked, 3 things to handle.");
    assert.equal(out, det);
  });

  test("rejects a rewrite that drops the reply affordance", async () => {
    const det = "😴 ~5.2h last night — protect a focus block? reply yes";
    const out = await rephraseNudge(det, async () => "😴 rough ~5.2h last night, want me to guard your afternoon?");
    assert.equal(out, det);
  });

  test("rejects a meta-preamble that dropped all the facts", async () => {
    const det = "🏃 8k steps — 1.5k to your 8k goal";
    const out = await rephraseNudge(det, async () => "Here's my plan:");
    assert.equal(out, det); // no original number retained → fallback
  });

  test("LLM throwing / empty → deterministic, never throws", async () => {
    const det = "🏃 6k steps — 2k to your 8k goal";
    assert.equal(await rephraseNudge(det, async () => { throw new Error("x"); }), det);
    assert.equal(await rephraseNudge(det, async () => ""), det);
  });

  test("no llmCall → passthrough", async () => {
    const det = "🅿️ parked — all clear.";
    assert.equal(await rephraseNudge(det), det);
  });

  test("rejects an over-long rambling rewrite", async () => {
    const det = "🏃 8k steps — 2k to your 8k goal";
    const out = await rephraseNudge(det, async () => "8k ".repeat(60));
    assert.equal(out, det);
  });
});
