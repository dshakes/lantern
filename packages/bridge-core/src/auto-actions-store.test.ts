import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAutoAction, loadAutoActions, autoActionsToDid } from "./auto-actions-store.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "aa-store-"));
}

describe("auto-actions-store", () => {
  test("records and reads back within the 24h window", () => {
    const dir = freshDir();
    try {
      const now = 1_000_000_000_000;
      recordAutoAction(dir, "📦 logged delivery — UPS · reply 'undo' to remove", now);
      recordAutoAction(dir, "📅 added to your calendar — Appointment · reply 'undo' to remove", now);
      const got = loadAutoActions(dir, now);
      assert.equal(got.length, 2);
      assert.match(got[0].text, /UPS/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("drops entries older than 24h", () => {
    const dir = freshDir();
    try {
      const now = 1_000_000_000_000;
      recordAutoAction(dir, "old action", now - 25 * 3_600_000);
      recordAutoAction(dir, "fresh action", now - 1 * 3_600_000);
      const got = loadAutoActions(dir, now);
      assert.equal(got.length, 1);
      assert.equal(got[0].text, "fresh action");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing file → empty, never throws", () => {
    assert.deepEqual(loadAutoActions(join(tmpdir(), "does-not-exist-xyz")), []);
  });

  test("autoActionsToDid strips the undo tail + flags undoable", () => {
    const acts = autoActionsToDid([
      { text: "📦 logged delivery — UPS · reply 'undo' to remove", ts: 1 },
      { text: "noted something reversible-free", ts: 2 },
    ]);
    assert.equal(acts[0].label, "📦 logged delivery — UPS");
    assert.equal(acts[0].undoable, true);
    assert.equal(acts[1].undoable, false);
    assert.equal(acts[0].id, "1");
  });
});
