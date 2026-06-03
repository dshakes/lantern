// Regression tests for voice-note transcription language biasing +
// garbled-output detection (bridge-core/language.ts).
//
// BUG these guard against: Whisper auto-detect mis-decodes Telangana Telugu
// speech into KANNADA script. The bridges now pass an explicit `language` +
// script-priming `prompt`, and degrade gracefully (human ack, never a
// "garbled transcription" meta-reply) when the output is still mis-decoded.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  voiceTranscriptionLangHint,
  looksGarbledTranscript,
  shouldShortCircuitVoiceNote,
  degradedVoiceAck,
} from "./language.ts";

// ---------------------------------------------------------------------------
// voiceTranscriptionLangHint — env / nativity / default precedence
// ---------------------------------------------------------------------------

test("defaults to AUTO-detect + Telugu prompt when no env + no nativity", () => {
  // Out of the box we must NOT force `language=te` (Whisper 400s on it).
  // Auto-detect (iso="") + a Telugu-script prompt biases the decoder
  // without risking an unsupported_language rejection.
  delete process.env.LANTERN_VOICE_LANG;
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "", "must auto-detect, not force an unsupported ISO");
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

test("empty env falls through to the default (auto-detect + Telugu prompt)", () => {
  process.env.LANTERN_VOICE_LANG = "";
  const h = voiceTranscriptionLangHint({});
  assert.equal(h.iso, "");
  assert.equal(h.lang, "telugu");
  assert.ok(h.prompt.length > 0);
  delete process.env.LANTERN_VOICE_LANG;
});

test("owner nativity drives the prompt (auto-detect iso) when env is unset", () => {
  delete process.env.LANTERN_VOICE_LANG;
  const h = voiceTranscriptionLangHint({ nativity: "Mumbai — Marathi & Hindi" });
  // First known language name in the nativity line wins for the prompt/lang;
  // iso stays auto-detect (no forced, possibly-unsupported, language).
  assert.equal(h.iso, "", "nativity-driven hint must auto-detect");
  assert.ok(h.lang === "marathi" || h.lang === "hindi", `expected marathi/hindi, got ${h.lang}`);
  assert.ok(h.prompt.length > 0);
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

// ---------------------------------------------------------------------------
// shouldShortCircuitVoiceNote — degraded/empty/placeholder decision (BUG 2b).
//
// A voice note that can't be understood must NEVER reach the LLM (which would
// emit a "transcription garbled" meta-reply that the bot-tell filter then
// suppresses → dead silence). These cases short-circuit to a human ack.
// ---------------------------------------------------------------------------

test("short-circuits an explicitly degraded voice note", () => {
  assert.equal(
    shouldShortCircuitVoiceNote({ ok: false, kind: "voice", degraded: true, syntheticText: "" }),
    true,
  );
});

test("short-circuits an empty-transcript voice note", () => {
  assert.equal(shouldShortCircuitVoiceNote({ ok: false, kind: "voice", syntheticText: "" }), true);
  assert.equal(shouldShortCircuitVoiceNote({ ok: false, kind: "voice", syntheticText: "   " }), true);
});

test("short-circuits a bracketed placeholder voice note", () => {
  assert.equal(
    shouldShortCircuitVoiceNote({
      ok: false,
      kind: "voice",
      syntheticText: "[voice note — transcription unavailable (400). Add an OpenAI key in Settings.]",
    }),
    true,
  );
  assert.equal(
    shouldShortCircuitVoiceNote({ ok: false, kind: "voice", syntheticText: "[voice note — empty transcription]" }),
    true,
  );
});

test("does NOT short-circuit a clean transcript", () => {
  assert.equal(
    shouldShortCircuitVoiceNote({
      ok: true,
      kind: "voice",
      syntheticText: "[voice note transcribed] nenu repu vasta",
    }),
    false,
  );
});

test("does NOT short-circuit non-voice media", () => {
  assert.equal(shouldShortCircuitVoiceNote({ ok: false, kind: "image", syntheticText: "" }), false);
  assert.equal(shouldShortCircuitVoiceNote({ ok: true, kind: "image", syntheticText: "[image — looks like: a cat]" }), false);
});

// ---------------------------------------------------------------------------
// degradedVoiceAck — never silent; Telugu for Telugu-writing contacts.
// ---------------------------------------------------------------------------

test("owner self-chat ack nudges to re-type", () => {
  const ack = degradedVoiceAck({ isOwner: true });
  assert.ok(ack.length > 0);
  assert.match(ack, /typing|re-record/i);
});

test("contact ack is warm + reassuring (English default)", () => {
  const ack = degradedVoiceAck({ isOwner: false, contactWritesTelugu: false });
  assert.ok(ack.length > 0);
  assert.match(ack, /voice note/i);
});

test("Telugu-writing contact gets a Telugu ack", () => {
  const ack = degradedVoiceAck({ isOwner: false, contactWritesTelugu: true });
  assert.ok(ack.length > 0);
  assert.match(ack, /vini|call chesta|🙏/);
});
