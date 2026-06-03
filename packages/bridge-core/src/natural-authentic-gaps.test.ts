// Tests for the four authentic-conversation gap fixes (A1, A4, A9) in
// natural.ts.
//   cd packages/bridge-core && npx tsx --test src/natural-authentic-gaps.test.ts
//
// All pure functions — no I/O, no LLM. naturalize() embeds jitter in its
// timing fields, so we assert on message TEXT and COUNT, never on delays.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  agentPersonaPrompt,
  detectBotTells,
  inferStyle,
  naturalize,
} from "./natural.ts";

const style = inferStyle([]);

// ── A1: full thread context ──

test("A1: short transcript is passed through verbatim", () => {
  const transcript = "them: hey\nyou: hi\nthem: what's up";
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    recentTranscript: transcript,
  });
  assert.ok(prompt.includes("them: what's up"), "tail present");
  assert.ok(prompt.includes("them: hey"), "head present (no truncation)");
  assert.ok(!prompt.includes("older message"), "no head note for short thread");
});

test("A1: long transcript keeps recent tail verbatim + a head note", () => {
  // ~50 lines, each ~30 chars → well over the 6000-char tail cap.
  const lines: string[] = [];
  for (let i = 0; i < 400; i++) {
    lines.push(`them: message number ${i} about the old topic here`);
  }
  lines.push("them: WHATABOUTTHEFRESHTOPIC right now");
  const transcript = lines.join("\n");
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    recentTranscript: transcript,
  });

  // The freshest message must survive verbatim.
  assert.ok(
    prompt.includes("WHATABOUTTHEFRESHTOPIC"),
    "most-recent line preserved",
  );
  // A compact head note must signal dropped context (topic-shift safety).
  assert.ok(
    /older messages? omitted/.test(prompt),
    "head note present for truncated thread",
  );
  // The very first old line must be gone (it was truncated).
  assert.ok(
    !prompt.includes("message number 0 about"),
    "earliest old line truncated",
  );
});

test("A1: tail is larger than the old 2000-char cap (more context kept)", () => {
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) lines.push(`you: line ${i} padding padding padding`);
  const transcript = lines.join("\n");
  const prompt = agentPersonaPrompt("Shekhar", style, false, {
    recentTranscript: transcript,
  });
  // Find the transcript region in the prompt and confirm it carries
  // meaningfully more than the legacy 2000-char slice.
  const marker = "Recent conversation on this thread";
  const region = prompt.slice(prompt.indexOf(marker));
  assert.ok(region.length > 3000, `kept ${region.length} chars, want > 3000`);
});

// ── A4: coherence guard (arrival/completion inbound → no future-plan reply) ──

test("A4: future-plan reply to an arrival message is flagged", () => {
  const cases: { inbound: string; draft: string }[] = [
    { inbound: "just reached home", draft: "great, see you tomorrow then!" },
    { inbound: "landed safely", draft: "awesome, let's meet at 6" },
    { inbound: "got home", draft: "cool, i'll bring the docs" },
    { inbound: "done with the meeting", draft: "nice, catch you later tonight" },
    { inbound: "all done, back home safe", draft: "perfect, see u at 7pm" },
  ];
  for (const { inbound, draft } of cases) {
    const v = detectBotTells(draft, inbound);
    assert.equal(
      v.ok,
      false,
      `should flag future-plan reply to "${inbound}": "${draft}"`,
    );
    assert.match(v.reason ?? "", /incoherent/);
  }
});

test("A4: legitimate reply to an arrival message is allowed", () => {
  const cases: { inbound: string; draft: string }[] = [
    { inbound: "just reached home", draft: "good, get some rest" },
    { inbound: "landed safely", draft: "glad you made it, that was a long flight" },
    { inbound: "done with the meeting", draft: "how'd it go?" },
    { inbound: "got home", draft: "nice, was traffic bad?" },
  ];
  for (const { inbound, draft } of cases) {
    const v = detectBotTells(draft, inbound);
    assert.equal(v.ok, true, `should allow "${draft}" for "${inbound}"`);
  }
});

test("A4: legitimate future plan when inbound is NOT arrival/completion", () => {
  // "let's meet at 6" is perfectly coherent in reply to a planning question.
  const v = detectBotTells("sure, let's meet at 6", "what time works for you?");
  assert.equal(v.ok, true);
});

test("A4: guard is no-op when inbound is omitted (backward compatible)", () => {
  const v = detectBotTells("see you tomorrow then!");
  assert.equal(v.ok, true, "draft-only call keeps prior behaviour");
});

// ── A9: long replies split instead of being silently suppressed ──

test("A9: a 400–800 char reply is allowed and split into a burst", () => {
  // ~500 chars of legitimate multi-sentence content.
  const draft =
    "Yeah so the plan is solid right now. " +
    "I checked the numbers this morning and we're well within budget for the whole quarter. " +
    "The vendor just confirmed they can ship by Friday which gives us a clean extra week of buffer. " +
    "I'll loop in the finance team today so they can sign off early without any drama. " +
    "We could even push the timeline up a bit if you want, totally doable on my end. " +
    "Otherwise we're good to lock it in and start tomorrow morning for sure.";
  assert.ok(
    draft.length > 400 && draft.length <= 800,
    `fixture is in 400-800 band (got ${draft.length})`,
  );

  const verdict = detectBotTells(draft, "hows the plan looking");
  assert.equal(verdict.ok, true, "400-800 char reply not suppressed");

  const burst = naturalize(draft, { inbound: "hows the plan looking", style });
  assert.ok(burst.length >= 2, `expected a multi-message burst, got ${burst.length}`);
  for (const m of burst) {
    assert.ok(!m.text.includes("\n"), "no raw line breaks in bubbles");
  }
});

test("A9: truly excessive (>800 char) output is still hard-suppressed", () => {
  const draft = "x ".repeat(500); // ~1000 chars
  const v = detectBotTells(draft, "hi");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /far too long/);
});

test("A9: multi-line draft is reformatted into bubbles, not suppressed", () => {
  const draft =
    "ok here's the rundown\n" +
    "first we ship the build\n" +
    "then we run the tests\n" +
    "then we deploy to staging\n" +
    "and finally to prod";
  const v = detectBotTells(draft, "whats the plan");
  assert.equal(v.ok, true, "4+ newlines no longer auto-suppressed");

  const burst = naturalize(draft, { inbound: "whats the plan", style });
  assert.ok(burst.length >= 1);
  for (const m of burst) {
    assert.ok(!m.text.includes("\n"), "newlines collapsed into separate bubbles");
  }
});

test("A9: a pasted document (long AND many newlines) is still suppressed", () => {
  const lines: string[] = [];
  for (let i = 0; i < 12; i++)
    lines.push(`section ${i}: some boilerplate content goes right here`);
  const draft = lines.join("\n"); // 400-800 chars + >8 newlines
  assert.ok(
    draft.length > 400 && draft.length <= 800,
    `fixture is in 400-800 band (got ${draft.length})`,
  );
  const v = detectBotTells(draft, "send me the doc");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /pasted document/);
});

test("A9: existing junk bot-tell suppression is unchanged", () => {
  // Customer-service phrasing must still be suppressed regardless of length.
  const v = detectBotTells("Of course! How can I help you today?", "hi");
  assert.equal(v.ok, false);
});

test("A9: a normal short reply is untouched", () => {
  const v = detectBotTells("yeah sounds good", "wanna grab lunch?");
  assert.equal(v.ok, true);
  const burst = naturalize("yeah sounds good", { inbound: "wanna grab lunch?", style });
  assert.equal(burst.length, 1);
});
