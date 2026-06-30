// Tests for identity overlay — the entity-resolution / correction fix.
//   cd packages/bridge-core && npx tsx --test src/identity.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveName, recordIdentityCorrection } from "./identity.ts";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "lantern-id-")), "id.jsonl");
}

test("no override → null (caller must NOT guess a name)", () => {
  const path = tmp();
  assert.equal(resolveName("+16303475128", { path }), null);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("REGRESSION: owner correction is authoritative and last-write-wins (the Arun→Manasa flip fix)", () => {
  const path = tmp();
  // bot earlier guessed "Arun" from the area code (a guess, not stored here);
  // owner corrects: "that number is Manasa's"
  assert.equal(recordIdentityCorrection("+16303475128", "Manasa", { path }), true);
  assert.equal(resolveName("+16303475128", { path }), "Manasa");
  // owner re-corrects later → last write wins, no flip-back
  recordIdentityCorrection("+16303475128", "Manu", { path });
  assert.equal(resolveName("+16303475128", { path }), "Manu");
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("resolves across handle forms via canonicalization", () => {
  const path = tmp();
  recordIdentityCorrection("+16303475128", "Manasa", { path });
  // a WhatsApp-suffixed form of the same number should hit the same record
  assert.equal(resolveName("16303475128@s.whatsapp.net", { path }), "Manasa");
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("rejects empty handle/name", () => {
  const path = tmp();
  assert.equal(recordIdentityCorrection("", "X", { path }), false);
  assert.equal(recordIdentityCorrection("+1555", "  ", { path }), false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});
