// Tests for working-memory — the live-session synthesis fix.
//   cd packages/bridge-core && npx tsx --test src/working-memory.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAction, recentActions, workingMemoryBlock } from "./working-memory.ts";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "lantern-wm-")), "wm.jsonl");
}

test("records actions and surfaces them newest-first within the window", () => {
  const path = tmp();
  const now = 2_000_000_000_000;
  recordAction({ kind: "status_set", summary: "status set: driving", ts: now - 30 * 60_000 }, { path });
  recordAction({ kind: "list_made", summary: "built grocery list from Manasa (Indian store)", ts: now - 10 * 60_000 }, { path });
  recordAction({ kind: "note_saved", summary: "old note", ts: now - 7 * 3_600_000 }, { path }); // outside 6h window
  const acts = recentActions({ path, nowMs: now });
  assert.equal(acts.length, 2, "7h-old action excluded by window");
  assert.equal(acts[0].kind, "list_made", "newest first");
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("REGRESSION: block carries recent actions + the SYNTHESIZE mandate (the 'where did I go' fix)", () => {
  const path = tmp();
  const now = 2_000_000_000_000;
  recordAction({ kind: "status_set", summary: "status set: driving", ts: now - 20 * 60_000 }, { path });
  recordAction({ kind: "list_made", summary: "built grocery list from Manasa (Indian store run)", ts: now - 5 * 60_000 }, { path });
  const block = workingMemoryBlock({ path, nowMs: now });
  assert.match(block, /What just happened/);
  assert.match(block, /driving/);
  assert.match(block, /grocery list from Manasa/);
  // the load-bearing directive that stops "I can't tell"
  assert.match(block, /SYNTHESIZE/);
  assert.match(block, /can't tell/i);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("empty when nothing recent", () => {
  const path = tmp();
  assert.equal(workingMemoryBlock({ path, nowMs: Date.now() }), "");
  rmSync(join(path, ".."), { recursive: true, force: true });
});
