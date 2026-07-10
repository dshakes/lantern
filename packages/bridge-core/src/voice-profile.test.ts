// voice-profile.test.ts — unit tests for the LLM-reasoned owner voice profile.
//
// All tests are pure (no live LLM). The LLMCaller is mocked.
// Runs via: node --import=tsx/esm --test src/voice-profile.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isVoiceReasoningEnabled,
  buildVoiceProfilePrompt,
  parseVoiceProfile,
  voiceHintToInstruction,
  VoiceProfileCache,
  type VoiceHint,
} from "./voice-profile.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const GOOD_HINT: VoiceHint = {
  register: "casual",
  sentenceLength: "terse",
  languageMix: "English, occasional Telugu expressions",
  emojiUse: "rarely — 🙏 for warmth, 😂 for humor",
  warmth: "warm",
  patterns: ["jumps to the point", "no greetings", "short sentences"],
};

const GOOD_JSON = JSON.stringify(GOOD_HINT);

// ── Flag gate ─────────────────────────────────────────────────────────────────

describe("isVoiceReasoningEnabled", () => {
  it("returns false when env var is unset", () => {
    const saved = process.env["LANTERN_VOICE_REASONING"];
    delete process.env["LANTERN_VOICE_REASONING"];
    assert.equal(isVoiceReasoningEnabled(), false);
    if (saved !== undefined) process.env["LANTERN_VOICE_REASONING"] = saved;
  });

  it("returns false when env var is '0'", () => {
    process.env["LANTERN_VOICE_REASONING"] = "0";
    assert.equal(isVoiceReasoningEnabled(), false);
    delete process.env["LANTERN_VOICE_REASONING"];
  });

  it("returns true when env var is '1'", () => {
    process.env["LANTERN_VOICE_REASONING"] = "1";
    assert.equal(isVoiceReasoningEnabled(), true);
    delete process.env["LANTERN_VOICE_REASONING"];
  });

  it("returns true when env var is 'true'", () => {
    process.env["LANTERN_VOICE_REASONING"] = "true";
    assert.equal(isVoiceReasoningEnabled(), true);
    delete process.env["LANTERN_VOICE_REASONING"];
  });

  it("returns true when env var is 'on'", () => {
    process.env["LANTERN_VOICE_REASONING"] = "on";
    assert.equal(isVoiceReasoningEnabled(), true);
    delete process.env["LANTERN_VOICE_REASONING"];
  });
});

// ── buildVoiceProfilePrompt ───────────────────────────────────────────────────

describe("buildVoiceProfilePrompt", () => {
  const MESSAGES = ["hey", "lol ok sounds good", "nah i'm out"];

  it("includes the owner name", () => {
    const prompt = buildVoiceProfilePrompt(MESSAGES, "Shekhar");
    assert.ok(prompt.includes("Shekhar"));
  });

  it("includes the owner messages in the prompt", () => {
    const prompt = buildVoiceProfilePrompt(MESSAGES, "Shekhar");
    for (const m of MESSAGES) {
      assert.ok(prompt.includes(m), `expected "${m}" in prompt`);
    }
  });

  it("handles empty messages gracefully", () => {
    const prompt = buildVoiceProfilePrompt([], "Shekhar");
    assert.ok(prompt.includes("no messages available yet"));
  });

  it("caps at the last 60 messages", () => {
    const many = Array.from({ length: 80 }, (_, i) => `msg${i}`);
    const prompt = buildVoiceProfilePrompt(many, "Owner");
    // First 20 messages should NOT appear; last 60 should.
    assert.ok(!prompt.includes("msg0"));
    assert.ok(prompt.includes("msg79"));
  });

  it("requests JSON output", () => {
    const prompt = buildVoiceProfilePrompt(MESSAGES, "Shekhar");
    assert.ok(prompt.includes("valid JSON"));
  });
});

// ── parseVoiceProfile ────────────────────────────────────────────────────────

describe("parseVoiceProfile", () => {
  it("parses a valid JSON string into a VoiceHint", () => {
    const result = parseVoiceProfile(GOOD_JSON);
    assert.deepEqual(result, GOOD_HINT);
  });

  it("returns null for an empty string", () => {
    assert.equal(parseVoiceProfile(""), null);
  });

  it("returns null for whitespace-only input", () => {
    assert.equal(parseVoiceProfile("   \n  "), null);
  });

  it("returns null for invalid JSON", () => {
    assert.equal(parseVoiceProfile("{not valid json}"), null);
  });

  it("returns null when a required field is missing (languageMix)", () => {
    const obj = { ...GOOD_HINT, languageMix: "" };
    assert.equal(parseVoiceProfile(JSON.stringify(obj)), null);
  });

  it("returns null when register is not a valid enum value", () => {
    const obj = { ...GOOD_HINT, register: "extremely-casual" };
    assert.equal(parseVoiceProfile(JSON.stringify(obj)), null);
  });

  it("returns null when sentenceLength is not a valid enum value", () => {
    const obj = { ...GOOD_HINT, sentenceLength: "short" };
    assert.equal(parseVoiceProfile(JSON.stringify(obj)), null);
  });

  it("returns null when warmth is not a valid enum value", () => {
    const obj = { ...GOOD_HINT, warmth: "cold" };
    assert.equal(parseVoiceProfile(JSON.stringify(obj)), null);
  });

  it("extracts JSON embedded in prose (LLM preamble)", () => {
    const preamble = `Here is the analysis:\n${GOOD_JSON}\nDone.`;
    const result = parseVoiceProfile(preamble);
    assert.deepEqual(result, GOOD_HINT);
  });

  it("extracts JSON wrapped in backtick fences", () => {
    const fenced = "```json\n" + GOOD_JSON + "\n```";
    const result = parseVoiceProfile(fenced);
    assert.deepEqual(result, GOOD_HINT);
  });

  it("silently drops patterns beyond 5 and keeps the rest", () => {
    const obj = {
      ...GOOD_HINT,
      patterns: ["a", "b", "c", "d", "e", "f", "g"],
    };
    const result = parseVoiceProfile(JSON.stringify(obj));
    assert.ok(result !== null);
    assert.equal(result!.patterns.length, 5);
  });

  it("ignores unknown/extra fields from the LLM (tolerant parse)", () => {
    const obj = { ...GOOD_HINT, someExtraField: "the LLM added this" };
    const result = parseVoiceProfile(JSON.stringify(obj));
    assert.ok(result !== null);
    // Only the known fields survive; the extra one is dropped.
    assert.equal((result as Record<string, unknown>)["someExtraField"], undefined);
    assert.equal(result!.register, "casual");
  });
});

// ── voiceHintToInstruction ───────────────────────────────────────────────────

describe("voiceHintToInstruction", () => {
  it("includes the owner name", () => {
    const inst = voiceHintToInstruction(GOOD_HINT, "Shekhar");
    assert.ok(inst.includes("Shekhar"));
  });

  it("includes all key VoiceHint fields", () => {
    const inst = voiceHintToInstruction(GOOD_HINT, "Shekhar");
    assert.ok(inst.includes("casual"));
    assert.ok(inst.includes("terse"));
    assert.ok(inst.includes("English, occasional Telugu expressions"));
    assert.ok(inst.includes("warm"));
  });

  it("includes observed patterns when present", () => {
    const inst = voiceHintToInstruction(GOOD_HINT, "Shekhar");
    assert.ok(inst.includes("jumps to the point"));
  });

  it("omits patterns section when patterns is empty", () => {
    const hint = { ...GOOD_HINT, patterns: [] };
    const inst = voiceHintToInstruction(hint, "Shekhar");
    assert.ok(!inst.includes("Observed patterns"));
  });

  it("includes a directive line at the end", () => {
    const inst = voiceHintToInstruction(GOOD_HINT, "Shekhar");
    assert.ok(inst.includes("Write EXACTLY the way these patterns describe"));
  });
});

// ── VoiceProfileCache ─────────────────────────────────────────────────────────

describe("VoiceProfileCache", () => {
  const OWNER_MSGS = ["hey", "cool", "yeah sounds good"];

  it("returns null immediately when cache is cold (no prior hint)", () => {
    // Mock LLM that never resolves synchronously
    const llm = async (_: string) => await new Promise<null>(() => null);
    const cache = new VoiceProfileCache(llm, "Owner");
    assert.equal(cache.getInstruction(OWNER_MSGS), null);
  });

  it("returns cached instruction after a successful LLM call", async () => {
    let called = false;
    const llm = async (_: string) => {
      called = true;
      return GOOD_JSON;
    };
    const cache = new VoiceProfileCache(llm, "Shekhar");

    // First call: cold cache — triggers background refresh, returns null.
    const first = cache.getInstruction(OWNER_MSGS);
    assert.equal(first, null);

    // Wait a tick so the async refresh can complete.
    await new Promise((r) => setImmediate(r));
    assert.ok(called, "expected LLM to be called");

    // Second call: cache is now warm.
    const second = cache.getInstruction(OWNER_MSGS);
    assert.ok(second !== null);
    assert.ok(second!.includes("Shekhar"));
    assert.ok(second!.includes("casual"));
  });

  it("does not call the LLM a second time while a refresh is in-flight", async () => {
    let callCount = 0;
    // LLM that resolves after one tick
    const llm = async (_: string) => {
      callCount++;
      await new Promise((r) => setImmediate(r));
      return GOOD_JSON;
    };
    const cache = new VoiceProfileCache(llm, "Owner");
    cache.getInstruction(OWNER_MSGS); // starts first refresh
    cache.getInstruction(OWNER_MSGS); // should NOT start a second
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(callCount, 1);
  });

  it("is fail-safe: LLM error leaves cache as null, does not throw", async () => {
    const llm = async (_: string): Promise<string | null> => {
      throw new Error("LLM unavailable");
    };
    const cache = new VoiceProfileCache(llm, "Owner");
    cache.getInstruction(OWNER_MSGS); // kicks off refresh
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Still null — error was swallowed
    assert.equal(cache.getInstruction(OWNER_MSGS), null);
  });

  it("is fail-safe: LLM returns unparseable JSON, cache stays null", async () => {
    const llm = async (_: string) => "not json at all";
    const cache = new VoiceProfileCache(llm, "Owner");
    cache.getInstruction(OWNER_MSGS);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(cache.getInstruction(OWNER_MSGS), null);
  });

  it("respects TTL: does not refresh until the cache is stale", async () => {
    let callCount = 0;
    const llm = async (_: string) => {
      callCount++;
      return GOOD_JSON;
    };
    // Very long TTL — should not refresh after the first successful load
    const cache = new VoiceProfileCache(llm, "Owner", { ttlMs: 60 * 60 * 1000 });
    cache.getInstruction(OWNER_MSGS); // first refresh
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    cache.getInstruction(OWNER_MSGS); // not stale, no second call
    assert.equal(callCount, 1);
  });

  it("flag-off proof: when LANTERN_VOICE_REASONING is unset, isVoiceReasoningEnabled() is false and the cache is never needed", () => {
    const saved = process.env["LANTERN_VOICE_REASONING"];
    delete process.env["LANTERN_VOICE_REASONING"];
    // The bridge checks isVoiceReasoningEnabled() before calling the cache.
    // Proving the flag is false is sufficient — the bridge test would confirm
    // the cache is never instantiated, but here we confirm the gate works.
    assert.equal(isVoiceReasoningEnabled(), false);
    if (saved !== undefined) process.env["LANTERN_VOICE_REASONING"] = saved;
  });
});
