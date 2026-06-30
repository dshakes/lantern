// Tests for the disclosure-deny overlay — the location-leak fix.
//   cd packages/bridge-core && npx tsx --test src/disclosure.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDisclosureDeny,
  recordDisclosureDeny,
  detectDisclosureDeny,
} from "./disclosure.ts";

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), "lantern-disc-")), "d.jsonl");
}

// ---- store round-trip -----------------------------------------------------

test("no record → not denied", () => {
  const path = tmp();
  assert.equal(resolveDisclosureDeny("+16303475128", { path }), false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("deny then re-allow (last write wins) + cross-channel canonicalization", () => {
  const path = tmp();
  assert.equal(recordDisclosureDeny("+16303475128", true, { path }), true);
  // a WhatsApp-suffixed form of the same number resolves to the same record
  assert.equal(resolveDisclosureDeny("16303475128@s.whatsapp.net", { path }), true);
  recordDisclosureDeny("+16303475128", false, { path }); // owner re-allows
  assert.equal(resolveDisclosureDeny("+16303475128", { path }), false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

test("rejects empty handle", () => {
  const path = tmp();
  assert.equal(recordDisclosureDeny("", true, { path }), false);
  rmSync(join(path, ".."), { recursive: true, force: true });
});

// ---- detection: deny ------------------------------------------------------

test("captures 'don't tell Ravi where I am'", () => {
  assert.deepEqual(detectDisclosureDeny("don't tell Ravi where I am"), {
    target: "Ravi",
    deny: true,
  });
});

test("captures 'don't share my location with Sam'", () => {
  assert.deepEqual(detectDisclosureDeny("don't share my location with Sam"), {
    target: "Sam",
    deny: true,
  });
});

test("captures 'keep my whereabouts private from Raju'", () => {
  assert.deepEqual(detectDisclosureDeny("keep my whereabouts private from Raju"), {
    target: "Raju",
    deny: true,
  });
});

test("captures 'don't let Manu know where I am'", () => {
  assert.deepEqual(detectDisclosureDeny("don't let Manu know where I am"), {
    target: "Manu",
    deny: true,
  });
});

// ---- detection: re-allow --------------------------------------------------

test("captures 'you can tell Ravi where I am'", () => {
  assert.deepEqual(detectDisclosureDeny("you can tell Ravi where I am"), {
    target: "Ravi",
    deny: false,
  });
});

test("captures 'stop hiding my location from Sam'", () => {
  assert.deepEqual(detectDisclosureDeny("stop hiding my location from Sam"), {
    target: "Sam",
    deny: false,
  });
});

// ---- negatives ------------------------------------------------------------

test("does NOT trip on a non-location secret ('don't tell Ravi I'm busy')", () => {
  assert.equal(detectDisclosureDeny("don't tell Ravi I'm busy"), null);
});

test("does NOT trip on unrelated text", () => {
  assert.equal(detectDisclosureDeny("where am I right now"), null);
  assert.equal(detectDisclosureDeny("tell Ravi I'll call him"), null);
});

test("round-trips through the store (detect → resolve)", () => {
  const path = tmp();
  const c = detectDisclosureDeny("don't tell Ravi where I am");
  assert.ok(c);
  // bridge resolves c.target ("Ravi") → a handle; simulate with a number
  recordDisclosureDeny("+16303475128", c.deny, { path });
  assert.equal(resolveDisclosureDeny("+16303475128", { path }), true);
  rmSync(join(path, ".."), { recursive: true, force: true });
});
