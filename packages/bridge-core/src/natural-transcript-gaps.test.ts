// Tests for gap-aware transcript rendering.
// Regression: a dormant thread (silent for months) surfaced the owner's stale
// last "you:" line as live context, and the model regurgitated it — a sister's
// "Ritesh my frd" drew a dump of family names the owner had listed months
// earlier. formatTranscriptWithGaps inserts an "earlier conversation" divider
// so the stale block reads as background, not the current topic.
//   cd packages/bridge-core && npx tsx --test src/natural-transcript-gaps.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { formatTranscriptWithGaps, type TranscriptMsg } from "./natural.ts";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test("inserts a divider across a long silence; none within a live back-and-forth", () => {
  const base = 1_700_000_000_000;
  // The real incident: a Mar-22 family-name exchange, then months of silence,
  // then a fresh "Hi" / "Ritesh my frd" today.
  const msgs: TranscriptMsg[] = [
    { fromMe: false, text: "Archana and meedi full names , kids", ts: base },
    { fromMe: true, text: "ChandraShekhar Mudarapu Manasa Sesham Ved Mudarapu Rajeswarrao Penchala Archana Karne Sarayu Penchala Sahana Penchala", ts: base + 60_000 },
    { fromMe: false, text: "Ok", ts: base + 120_000 },
    // ~116 days later — a brand new conversation:
    { fromMe: false, text: "Hi", ts: base + 116 * DAY },
    { fromMe: false, text: "Ritesh my frd", ts: base + 116 * DAY + 30_000 },
  ];
  const out = formatTranscriptWithGaps(msgs);

  // The stale family-name block is fenced off as an earlier conversation…
  assert.match(out, /──── earlier conversation \(4mo earlier\) ────/);
  // …and it appears BEFORE the live "Hi", not after.
  const dividerIdx = out.indexOf("earlier conversation");
  assert.ok(dividerIdx > out.indexOf("Archana Karne"), "name list precedes the divider");
  assert.ok(dividerIdx < out.indexOf("them: Hi"), "divider precedes the fresh greeting");
  // Exactly one divider — the three Mar-22 lines are a single contiguous block.
  assert.equal(out.match(/earlier conversation/g)?.length, 1);
  // The live message is the last line.
  assert.match(out.trimEnd().split("\n").at(-1)!, /them: Ritesh my frd/);
});

test("no divider when the whole thread is within the gap window", () => {
  const base = 1_700_000_000_000;
  const msgs: TranscriptMsg[] = [
    { fromMe: false, text: "you free later?", ts: base },
    { fromMe: true, text: "yeah after 6", ts: base + 2 * HOUR }, // 2h < 6h threshold
    { fromMe: false, text: "cool", ts: base + 2 * HOUR + 60_000 },
  ];
  const out = formatTranscriptWithGaps(msgs);
  assert.doesNotMatch(out, /earlier conversation/);
  assert.equal(out.split("\n").length, 3);
});

test("empty/whitespace lines are dropped; speaker prefixes correct; missing ts never crashes", () => {
  const base = 1_700_000_000_000;
  const msgs: TranscriptMsg[] = [
    { fromMe: true, text: "  ", ts: base },
    { fromMe: false, text: "hey", ts: base + DAY },        // gap vs the dropped blank → no divider (blank not kept)
    { fromMe: true, text: "hi", ts: Number.NaN },          // non-finite ts: gap check skipped, no crash
  ];
  const out = formatTranscriptWithGaps(msgs);
  assert.equal(out, "them: hey\nyou: hi");
});

test("custom gapMs threshold is honored", () => {
  const base = 1_700_000_000_000;
  const msgs: TranscriptMsg[] = [
    { fromMe: false, text: "a", ts: base },
    { fromMe: false, text: "b", ts: base + 90 * 60_000 }, // 90 min
  ];
  assert.doesNotMatch(formatTranscriptWithGaps(msgs), /earlier/); // default 6h → no divider
  assert.match(formatTranscriptWithGaps(msgs, { gapMs: HOUR }), /earlier conversation \(2h earlier\)/); // 90m ≥ 1h → divider, rounds to 2h
});
