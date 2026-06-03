// Regression tests for voice-note transcription language biasing +
// garbled-output detection (bridge-core/language.ts).
//
// BUG these guard against: Whisper auto-detect mis-decodes Telangana Telugu
// speech into KANNADA script. The bridges now pass an explicit `language` +
// script-priming `prompt`, and degrade gracefully (human ack, never a
// "garbled transcription" meta-reply) when the output is still mis-decoded.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { voiceTranscriptionLangHint, looksGarbledTranscript } from "./language.ts";

// ---------------------------------------------------------------------------
// voiceTranscriptionLangHint — env / nativity / default precedence
// ---------------------------------------------------------------------------

test("defaults to Telugu when no env + no nativity", () => {
  delete process.env.LANTERN_VOICE_LANG;
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "te");
  assert.equal(h.lang, "telugu");
  assert.ok(h.prompt.length > 0, "should carry a script-priming prompt");
});

test("LANTERN_VOICE_LANG ISO code wins", () => {
  process.env.LANTERN_VOICE_LANG = "hi";
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "hi");
  assert.equal(h.lang, "hindi");
  delete process.env.LANTERN_VOICE_LANG;
});

test("LANTERN_VOICE_LANG language name wins (case-insensitive)", () => {
  process.env.LANTERN_VOICE_LANG = "Tamil";
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "ta");
  delete process.env.LANTERN_VOICE_LANG;
});

test('LANTERN_VOICE_LANG="auto" disables biasing', () => {
  process.env.LANTERN_VOICE_LANG = "auto";
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "");
  assert.equal(h.prompt, "");
  delete process.env.LANTERN_VOICE_LANG;
});

test("empty env falls through to the default (not auto)", () => {
  process.env.LANTERN_VOICE_LANG = "";
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "te");
  delete process.env.LANTERN_VOICE_LANG;
});

test("owner nativity drives the hint when env is unset", () => {
  delete process.env.LANTERN_VOICE_LANG;
  const h = voiceTranscriptionLangHint({ nativity: "Mumbai — Marathi & Hindi" });
  // First known language name in the nativity line wins.
  assert.ok(h.iso === "mr" || h.iso === "hi", `expected mr/hi, got ${h.iso}`);
});

// ---------------------------------------------------------------------------
// looksGarbledTranscript — the Telugu→Kannada mis-decode + noise
// ---------------------------------------------------------------------------

test("flags Kannada-script output for a Telugu speaker (the bug)", () => {
  // Real-world garbled sample shape: Kannada glyphs where Telugu was spoken.
  assert.equal(
    looksGarbledTranscript("ಚಿತಾ 10-15 ನಿಮಚಾಲಲ ಮಾಟಲಾಗಾಲಲಇ", "telugu"),
    true,
  );
});

test("does NOT flag clean Telugu-script output", () => {
  assert.equal(looksGarbledTranscript("నేను రేపు వస్తాను మాట్లాడదాం", "telugu"), false);
});

test("does NOT flag Romanized Telugu output", () => {
  assert.equal(looksGarbledTranscript("nenu repu vasta matladtham", "telugu"), false);
});

test("does NOT flag plain English output", () => {
  assert.equal(looksGarbledTranscript("hey can you call me back later today", "telugu"), false);
});

test("flags noise / mostly-punctuation output (low alpha ratio)", () => {
  assert.equal(looksGarbledTranscript("... -- ?? !! 123 456 78", "telugu"), true);
});

test("does not flag empty / too-short transcripts (handled separately)", () => {
  assert.equal(looksGarbledTranscript("", "telugu"), false);
  assert.equal(looksGarbledTranscript("a", "telugu"), false);
});

test("treats Devanagari as compatible for Hindi/Marathi (shared script)", () => {
  assert.equal(looksGarbledTranscript("मी उद्या येतो", "hindi"), false);
  assert.equal(looksGarbledTranscript("मी उद्या येतो", "marathi"), false);
});
