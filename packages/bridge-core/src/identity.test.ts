// Tests for identity overlay — the entity-resolution / correction fix.
//   cd packages/bridge-core && npx tsx --test src/identity.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveName, recordIdentityCorrection, detectIdentityCorrection } from "./identity.ts";

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

// --- detectIdentityCorrection (capture side) ------------------------------

test("captures handle-first correction", () => {
  assert.deepEqual(detectIdentityCorrection("+15125551234 is Manasa"), {
    handle: "+15125551234",
    name: "Manasa",
  });
});

test("captures possessive + formatted number", () => {
  assert.deepEqual(detectIdentityCorrection("+1 (512) 555-1234 is Manasa's"), {
    handle: "+1 (512) 555-1234",
    name: "Manasa",
  });
});

test("captures name-first form", () => {
  assert.deepEqual(detectIdentityCorrection("Sam's number is 5125551234"), {
    handle: "5125551234",
    name: "Sam",
  });
});

test("captures 'that number <handle> is <name>'", () => {
  assert.deepEqual(detectIdentityCorrection("that number 5125551234 is sam"), {
    handle: "5125551234",
    name: "sam",
  });
});

test("captures email handle", () => {
  assert.deepEqual(detectIdentityCorrection("shiva@example.com is Shiva"), {
    handle: "shiva@example.com",
    name: "Shiva",
  });
});

test("round-trips through the overlay (capture → resolve)", () => {
  const path = tmp();
  const c = detectIdentityCorrection("+16303475128 is Manasa");
  assert.ok(c);
  recordIdentityCorrection(c.handle, c.name, { path });
  assert.equal(resolveName("16303475128@s.whatsapp.net", { path }), "Manasa");
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("does NOT capture the owner's own number ('my number is …')", () => {
  assert.equal(detectIdentityCorrection("my number is 5125551234"), null);
});

test("does NOT capture non-name verdicts ('… is wrong')", () => {
  assert.equal(detectIdentityCorrection("5125551234 is wrong"), null);
});

test("does NOT capture a handle-less message", () => {
  assert.equal(detectIdentityCorrection("that's Manasa"), null);
  assert.equal(detectIdentityCorrection("call 5125551234"), null);
});

// REGRESSION (audit): adverb/hedge/verdict-prefixed sentences must NOT be
// stored as a name — they'd become a permanent, highest-precedence mislabel.
test("does NOT capture hedge/verdict annotations about a number", () => {
  // These exercise the NON_NAMES / article guards — the digit string is an
  // arbitrary synthetic placeholder, NOT an assumption about any real number.
  for (const s of [
    "5550000000 is probably Riya",
    "5550000000 is still calling me",
    "5550000000 is definitely wrong",
    "5550000000 is clearly not Riya",
    "5550000000 is a great number",
  ]) {
    assert.equal(detectIdentityCorrection(s), null, s);
  }
});

test("does NOT capture a negation ('512 is not Sam')", () => {
  assert.equal(detectIdentityCorrection("5125551234 is not Sam"), null);
});

test("captures 'belongs to' with a relationship-prefixed name", () => {
  // "my boss Raju" → leading "my" stripped → first two tokens kept.
  const c = detectIdentityCorrection("5125551234 belongs to my boss Raju");
  assert.ok(c);
  assert.equal(c.handle, "5125551234");
});

test("captures a foreign / two-word name", () => {
  assert.deepEqual(detectIdentityCorrection("+15125551234 is Anjali Rao"), {
    handle: "+15125551234",
    name: "Anjali Rao",
  });
});
