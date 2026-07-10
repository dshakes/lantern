// Tests for the dislike → style-lesson flywheel.
//   cd packages/bridge-core && npx tsx --test src/dislike-consolidator.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consolidateDislikes,
  formatStyleLessonsBlock,
  type StyleLesson,
} from "./dislike-consolidator.ts";
import type { DislikeEntry } from "./dislike-memory.ts";
import { writeStyleLessons } from "./owner-profile-auto-update.ts";

// Minimal in-memory stand-in for DislikeMemory.all().
function fakeMemory(badReplies: string[]): { all: () => Promise<DislikeEntry[]> } {
  const entries: DislikeEntry[] = badReplies.map((badReply, i) => ({
    jid: `+1${i % 4}`, // spread across contacts so lessons are GENERAL
    inbound: "hi",
    badReply,
    ts: 1000 + i,
    channel: "whatsapp",
  }));
  return { all: async () => entries };
}

test("clusters recurring exclamation marks into a general lesson", async () => {
  const mem = fakeMemory([
    "Sure thing! I'll do that!",
    "Sounds great!!",
    "Awesome, on it!",
    "got it", // clean — no exclamation
  ]);
  const lessons = await consolidateDislikes(mem, { minSupport: 3, minFraction: 0.3 });
  const ex = lessons.find((l) => l.id === "no-exclamation");
  assert.ok(ex, "should detect exclamation-mark pattern");
  assert.equal(ex!.support, 3);
});

test("clusters over-long replies into a 'keep short' lesson", async () => {
  const long = "This is a very long reply. It has multiple sentences. It keeps going on and on. It really should have been shorter.";
  const mem = fakeMemory([long, long + " more", long + " even more", "ok"]);
  const lessons = await consolidateDislikes(mem, { minSupport: 3, minFraction: 0.3 });
  assert.ok(lessons.some((l) => l.id === "prefer-shorter"), "should detect long-reply pattern");
});

test("ignores one-off patterns below support threshold", async () => {
  const mem = fakeMemory(["Sure thing! one", "plain two", "plain three", "plain four"]);
  const lessons = await consolidateDislikes(mem, { minSupport: 3, minFraction: 0.34 });
  assert.equal(lessons.find((l) => l.id === "no-exclamation"), undefined);
  assert.equal(lessons.find((l) => l.id === "no-filler-opener"), undefined);
});

test("empty history yields no lessons", async () => {
  const lessons = await consolidateDislikes(fakeMemory([]));
  assert.deepEqual(lessons, []);
});

test("LLM novel-preference pass: runs by default, skipped only when disabled", async () => {
  // Phase 2b: the fuzzy-cluster pass is now default-ON (opt-out via =0), and the
  // bridges wire llmCall. Verify the gate: invoked when the flag is unset,
  // skipped when explicitly "0". A "[]" reply is a valid no-lessons result.
  const mem = fakeMemory(["a! one", "b! two", "c! three", "d! four"]);
  let calls = 0;
  const llmCall = async () => {
    calls++;
    return "[]";
  };
  const saved = process.env.LANTERN_DISLIKE_LLM_CLUSTER;
  try {
    delete process.env.LANTERN_DISLIKE_LLM_CLUSTER; // default → on
    await consolidateDislikes(mem, { minSupport: 3, minFraction: 0.3, llmCall });
    assert.ok(calls >= 1, "LLM cluster should run by default (flag unset)");

    calls = 0;
    process.env.LANTERN_DISLIKE_LLM_CLUSTER = "0"; // explicit opt-out
    await consolidateDislikes(mem, { minSupport: 3, minFraction: 0.3, llmCall });
    assert.equal(calls, 0, "LLM cluster must NOT run when explicitly disabled");
  } finally {
    if (saved === undefined) delete process.env.LANTERN_DISLIKE_LLM_CLUSTER;
    else process.env.LANTERN_DISLIKE_LLM_CLUSTER = saved;
  }
});

function tmpProfile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "style-lessons-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, content, "utf8");
  return path;
}

test("writeStyleLessons creates the managed section and dedups by id", async () => {
  const path = tmpProfile("# Owner profile\n\n## About me\nfounder.\n");
  const lessons: StyleLesson[] = [
    { id: "no-exclamation", text: "Avoid exclamation marks.", support: 4 },
    { id: "prefer-shorter", text: "Keep replies short.", support: 3 },
  ];

  let invalidated = 0;
  const r1 = await writeStyleLessons(lessons, { profilePath: path, invalidate: () => invalidated++ });
  assert.deepEqual(r1.added.sort(), ["no-exclamation", "prefer-shorter"]);
  assert.equal(invalidated, 1);
  let text = readFileSync(path, "utf8");
  assert.ok(text.includes("## Style lessons (managed)"));
  assert.ok(text.includes("Avoid exclamation marks. <!-- id:no-exclamation -->"));

  // Re-write identical lessons → no change, no dupes.
  const r2 = await writeStyleLessons(lessons, { profilePath: path });
  assert.equal(r2.added.length, 0);
  assert.equal(r2.updated.length, 0);
  text = readFileSync(path, "utf8");
  assert.equal(text.match(/id:no-exclamation/g)?.length, 1, "must not duplicate");

  // Update one lesson's text → in-place update, still one occurrence.
  const r3 = await writeStyleLessons(
    [{ id: "no-exclamation", text: "Never use exclamation marks.", support: 9 }],
    { profilePath: path },
  );
  assert.deepEqual(r3.updated, ["no-exclamation"]);
  text = readFileSync(path, "utf8");
  assert.equal(text.match(/id:no-exclamation/g)?.length, 1);
  assert.ok(text.includes("Never use exclamation marks."));
});

test("formatStyleLessonsBlock renders a compact prompt block", () => {
  const block = formatStyleLessonsBlock([
    { id: "a", text: "Avoid exclamation marks.", support: 5 },
    { id: "b", text: "Keep replies short.", support: 3 },
  ]);
  assert.ok(block.includes("Global style lessons"));
  assert.ok(block.includes("- Avoid exclamation marks."));
  assert.equal(formatStyleLessonsBlock([]), "");
});
