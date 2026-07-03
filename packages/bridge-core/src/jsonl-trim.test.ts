// jsonl-trim: on-disk cap for append-only JSONL state files (episodes /
// topic-index / auto-actions). The check that fails if the logic breaks:
// files past 2× the cap get truncated to the cap on a line boundary;
// files under it are left alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trimJsonlBytes } from "./jsonl-trim.js";
import { recordAutoAction, loadAutoActions } from "./auto-actions-store.js";

test("trimJsonlBytes truncates an oversized file to whole lines under the cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-trim-"));
  const p = join(dir, "episodes.jsonl");
  const line = JSON.stringify({ jid: "x@s.whatsapp.net", topic: "t", pad: "y".repeat(80) }) + "\n";
  writeFileSync(p, line.repeat(100)); // ~12KB
  await trimJsonlBytes(p, 2_000); // cap 2KB, file > 2× cap → trim

  const out = readFileSync(p, "utf8");
  assert.ok(out.length <= 2_000, `expected <= 2000 bytes, got ${out.length}`);
  assert.ok(out.endsWith("\n"));
  // Every surviving line is intact JSON (trim aligned to line boundary).
  for (const l of out.split("\n").filter(Boolean)) JSON.parse(l);
  rmSync(dir, { recursive: true, force: true });
});

test("trimJsonlBytes leaves files under 2x the cap untouched and never throws on missing files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsonl-trim-"));
  const p = join(dir, "small.jsonl");
  writeFileSync(p, '{"a":1}\n');
  await trimJsonlBytes(p, 2_000);
  assert.equal(readFileSync(p, "utf8"), '{"a":1}\n');
  await trimJsonlBytes(join(dir, "does-not-exist.jsonl"), 2_000); // must not throw
  rmSync(dir, { recursive: true, force: true });
});

test("recordAutoAction caps the on-disk file at MAX_LINES and keeps the newest entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-actions-"));
  for (let i = 0; i < 450; i++) recordAutoAction(dir, `action ${i}`);

  const lines = readFileSync(join(dir, "auto-actions.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length <= 401, `expected <= 401 lines on disk, got ${lines.length}`);
  // Newest entries survive the trim (recap still answers correctly).
  const loaded = loadAutoActions(dir);
  assert.equal(loaded[loaded.length - 1]?.text, "action 449");
  rmSync(dir, { recursive: true, force: true });
});
