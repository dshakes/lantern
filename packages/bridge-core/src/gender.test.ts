import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGender, recordGender, detectGenderStatement } from "./gender.ts";

function tmp(): string { return join(mkdtempSync(join(tmpdir(), "lantern-g-")), "g.jsonl"); }

test("record + resolve (first-name keyed, last wins)", () => {
  const path = tmp();
  assert.equal(recordGender("Prithvi", "m", { path }), true);
  assert.equal(resolveGender("Prithvi", { path }), "m");
  assert.equal(resolveGender("prithvi sharma", { path }), "m"); // first-name match
  recordGender("Prithvi", "f", { path }); // owner re-corrects
  assert.equal(resolveGender("Prithvi", { path }), "f");
  assert.equal(resolveGender("Unknown", { path }), null);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("detectGenderStatement — the owner's exact phrasing", () => {
  assert.deepEqual(detectGenderStatement("prithvi is a boy not girl"), { name: "prithvi", gender: "m" });
  assert.deepEqual(detectGenderStatement("Raju is a man"), { name: "Raju", gender: "m" });
  assert.deepEqual(detectGenderStatement("Mae is female"), { name: "Mae", gender: "f" });
  assert.deepEqual(detectGenderStatement("Anvitha is a woman"), { name: "Anvitha", gender: "f" });
});

test("detect — negatives", () => {
  assert.equal(detectGenderStatement("the meeting is at noon"), null);
  assert.equal(detectGenderStatement("what did prithvi say"), null);
  assert.equal(detectGenderStatement(""), null);
});
