// Tests for the dislike → style-lesson flywheel runner.
//   cd packages/bridge-core && npx tsx --test src/dislike-flywheel.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDislikeConsolidation } from "./dislike-consolidator.ts";
import type { DislikeEntry } from "./dislike-memory.ts";

function fakeMemory(badReplies: string[]): { all: () => Promise<DislikeEntry[]> } {
  const entries = badReplies.map((badReply, i) => ({
    ts: i,
    contact: "+1555",
    inbound: "hey",
    badReply,
    goodReply: "",
  })) as unknown as DislikeEntry[];
  return { all: async () => entries };
}

async function tmpProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lantern-flywheel-"));
  return join(dir, "owner-profile.md");
}

test("flywheel consolidates and writes lessons into the profile", async () => {
  const profilePath = await tmpProfile();
  // 4 of 4 bad replies use exclamation marks → graduates a lesson.
  const memory = fakeMemory([
    "sounds great!",
    "yeah for sure!",
    "on it!",
    "perfect!",
  ]);
  let invalidated = 0;
  const res = await runDislikeConsolidation({
    memory,
    profilePath,
    invalidate: () => invalidated++,
  });
  assert.equal(res.ok, true);
  assert.ok(res.count >= 1);
  assert.ok(res.lessons.some((l) => l.id === "no-exclamation"));
  assert.ok(res.added.includes("no-exclamation"));
  assert.equal(invalidated, 1);

  const written = await readFile(profilePath, "utf8");
  assert.match(written, /## Style lessons \(managed\)/);
  assert.match(written, /id:no-exclamation/);

  await rm(join(profilePath, ".."), { recursive: true, force: true });
});

test("flywheel is idempotent — re-running adds nothing new", async () => {
  const profilePath = await tmpProfile();
  const memory = fakeMemory(["a!", "b!", "c!", "d!"]);
  const first = await runDislikeConsolidation({ memory, profilePath });
  assert.ok(first.added.length >= 1);
  const second = await runDislikeConsolidation({ memory, profilePath });
  assert.equal(second.ok, true);
  assert.equal(second.added.length, 0);
  assert.equal(second.updated.length, 0);
  await rm(join(profilePath, ".."), { recursive: true, force: true });
});

test("empty dislike log → ok with zero lessons, no write", async () => {
  const profilePath = await tmpProfile();
  const res = await runDislikeConsolidation({ memory: fakeMemory([]), profilePath });
  assert.equal(res.ok, true);
  assert.equal(res.count, 0);
  await rm(join(profilePath, ".."), { recursive: true, force: true });
});

test("flywheel never throws — bad memory yields ok:false", async () => {
  const profilePath = await tmpProfile();
  const memory = { all: async () => { throw new Error("disk gone"); } };
  const res = await runDislikeConsolidation({ memory, profilePath });
  assert.equal(res.ok, false);
  assert.equal(res.count, 0);
  await rm(join(profilePath, ".."), { recursive: true, force: true });
});
