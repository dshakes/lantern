// Tests for the GLOBAL owner-voice corpus.
//   cd packages/bridge-core && npx tsx --test src/owner-voice.test.ts
//
// Covers: dedup, recency ordering, length gating, bot-self exclusion,
// the Telugu language filter, and the persona-block formatter.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  ownerVoiceExemplars,
  isTeluguSample,
  formatOwnerVoiceBlock,
  dedupeKey,
  type OwnerVoiceSample,
} from "./owner-voice.ts";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";

test("ownerVoiceExemplars: dedupes near-identical messages", () => {
  const samples: OwnerVoiceSample[] = [
    { text: "ok cool" },
    { text: "Ok cool" },
    { text: "ok cool 👍" },
    { text: "yeah for sure" },
  ];
  const out = ownerVoiceExemplars(samples);
  assert.deepEqual(
    out.sort(),
    ["ok cool", "yeah for sure"].sort(),
    "ok-cool variants collapse to one",
  );
});

test("ownerVoiceExemplars: most-recent first by timestamp", () => {
  const samples: OwnerVoiceSample[] = [
    { text: "oldest line here", ts: 1000 },
    { text: "newest line here", ts: 3000 },
    { text: "middle line here", ts: 2000 },
  ];
  const out = ownerVoiceExemplars(samples);
  assert.equal(out[0], "newest line here");
  assert.equal(out[2], "oldest line here");
});

test("ownerVoiceExemplars: undated samples sort after dated ones", () => {
  const out = ownerVoiceExemplars([
    { text: "undated message line" },
    { text: "dated recent message", ts: 5000 },
  ]);
  assert.equal(out[0], "dated recent message");
});

test("ownerVoiceExemplars: drops too-short acks and too-long paragraphs", () => {
  const longPara = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const out = ownerVoiceExemplars([
    { text: "ok" }, // 1 word — dropped
    { text: "k" }, // dropped
    { text: longPara }, // > maxWords — dropped
    { text: "lemme check and get back" }, // kept
  ]);
  assert.deepEqual(out, ["lemme check and get back"]);
});

test("ownerVoiceExemplars: excludes bot-self output", () => {
  const out = ownerVoiceExemplars([
    { text: "📅 added to calendar: lunch with srinivas" },
    { text: "🧠 thinking…" },
    { text: "haha sounds like a plan honestly" },
  ]);
  assert.deepEqual(out, ["haha sounds like a plan honestly"]);
});

test("ownerVoiceExemplars: respects max cap", () => {
  const samples: OwnerVoiceSample[] = Array.from({ length: 30 }, (_, i) => ({
    text: `distinct owner line number ${i}`,
    ts: i,
  }));
  assert.equal(ownerVoiceExemplars(samples, { max: 5 }).length, 5);
});

// ── Telugu language filter ────────────────────────────────────────────

test("isTeluguSample: romanized + native script detected, English not", () => {
  assert.equal(isTeluguSample("repu vasta, cheptha"), true); // romanized
  assert.equal(isTeluguSample("ఎలా ఉన్నావు"), true); // native script
  assert.equal(isTeluguSample("ela undi nuvvu"), true);
  assert.equal(isTeluguSample("on my way, see you soon"), false); // English
  assert.equal(isTeluguSample("from the library card"), false); // stray letters, no token
});

test("ownerVoiceExemplars: lang:telugu returns ONLY the owner's Telugu voice", () => {
  const samples: OwnerVoiceSample[] = [
    { text: "yeah for sure, see you then", ts: 3 },
    { text: "repu vasta ra, cheptha", ts: 2 },
    { text: "ఎలా ఉన్నావు anna", ts: 1 },
    { text: "on my way now", ts: 4 },
  ];
  const out = ownerVoiceExemplars(samples, { lang: "telugu" });
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => isTeluguSample(s)), `all should be Telugu: ${JSON.stringify(out)}`);
  assert.ok(!out.includes("on my way now"));
});

// ── Formatter + persona integration ───────────────────────────────────

test("formatOwnerVoiceBlock: empty when no exemplars", () => {
  assert.equal(formatOwnerVoiceBlock("Shekhar", [], []), "");
});

test("formatOwnerVoiceBlock: includes general + a prominent Telugu sub-block", () => {
  const block = formatOwnerVoiceBlock(
    "Shekhar",
    ["yeah for sure", "lemme check"],
    ["repu vasta", "cheptha ra"],
  );
  assert.match(block, /HOW SHEKHAR ACTUALLY WRITES/);
  assert.match(block, /> yeah for sure/);
  assert.match(block, /When replying in Telugu/);
  assert.match(block, /> repu vasta/);
});

test("persona prompt includes the global owner-voice block", () => {
  const block = formatOwnerVoiceBlock("Shekhar", ["yeah for sure", "lemme check"]);
  const prompt = agentPersonaPrompt("Shekhar", inferStyle([]), false, {
    ownerVoiceBlock: block,
  });
  assert.match(prompt, /HOW SHEKHAR ACTUALLY WRITES/);
  assert.match(prompt, /> lemme check/);
});

// ── dedupeKey (shared collapse rule used by the corpus miners) ────────

test("dedupeKey: collapses case/emoji/punctuation variants to one key", () => {
  assert.equal(dedupeKey("ok!"), dedupeKey("Ok"));
  assert.equal(dedupeKey("ok 👍"), dedupeKey("ok"));
  assert.equal(dedupeKey("on my way!!"), dedupeKey("On My Way"));
  assert.notEqual(dedupeKey("yes"), dedupeKey("no"));
});

// ── Corpus miner pure pipeline (length gate + dedupe-by-key) ──────────
// Mirrors ChatDB.ownerVoiceCorpus / WA seedOwnerSentFromHistory in-memory
// logic: drop <2 or >280 chars, collapse near-dupes, cap at `limit`.
function corpusFilter(rows: string[], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of rows) {
    const text = raw.trim();
    if (text.length < 2 || text.length > 280) continue;
    const key = dedupeKey(text);
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

test("corpus filter: drops too-short and too-long, dedupes, respects limit", () => {
  const long = "x".repeat(281);
  const rows = [
    "k",                 // too short (1 char) → dropped
    "ok cool",           // kept
    "Ok cool!",          // dup of "ok cool" → dropped
    "lemme check",       // kept
    long,                // too long → dropped
    "see you at 6",      // kept
    "  on my way  ",     // kept (trimmed)
    "On my way",         // dup → dropped
  ];
  const out = corpusFilter(rows, 600);
  assert.deepEqual(out, ["ok cool", "lemme check", "see you at 6", "on my way"]);
});

test("corpus filter: caps at limit, newest-first preserved by caller order", () => {
  const rows = ["one two", "three four", "five six", "seven eight"];
  const out = corpusFilter(rows, 2);
  assert.deepEqual(out, ["one two", "three four"]);
});

test("persona prompt: anti-repetition forbids reusing the same offer", () => {
  const prompt = agentPersonaPrompt("Shekhar", inferStyle([]), false, {
    recentBotReplies: ["want me to pass a specific message along?"],
  });
  assert.match(prompt, /do NOT reuse the same OPENER or the same concierge OFFER/i);
});
