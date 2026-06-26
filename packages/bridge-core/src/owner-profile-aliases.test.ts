// Tests for contact aliases / re-identification (B6).
//   cd packages/bridge-core && npx tsx --test src/owner-profile-aliases.test.ts
//
// A contact reaching the owner from a second/new number must resolve to
// the SAME canonical person — name + relationship + address rule — so the
// thread isn't cold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { parseProfile, OwnerProfileStore } from "./owner-profile.js";

const silentLogger = pino({ level: "silent" });

function storeFrom(content: string): OwnerProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "owner-aliases-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, content, "utf8");
  return new OwnerProfileStore(silentLogger, path);
}

const SAMPLE = `# Owner profile

## About me
I'm Ada.

## Relationships
- Sujith Penchala: brother-in-law | also: +15551234567, +15559876543
- Madhu: close friend | address as: Madhu | never: bro | also: +19998887777
- Shiva: friend
`;

test("parse: alias numbers index the same relationship", () => {
  const p = parseProfile(SAMPLE);
  // Primary still resolves.
  assert.equal(p.relationships.get("sujith penchala"), "brother-in-law");
  // Both alias numbers map to the same relationship (canonicalized digits).
  assert.equal(p.relationships.get("15551234567"), "brother-in-law");
  assert.equal(p.relationships.get("15559876543"), "brother-in-law");
});

test("parse: aliases map records alias → primary display name", () => {
  const p = parseProfile(SAMPLE);
  assert.equal(p.aliases.get("15551234567"), "Sujith Penchala");
  assert.equal(p.aliases.get("15559876543"), "Sujith Penchala");
  assert.equal(p.aliases.get("19998887777"), "Madhu");
});

test("parse: plain relationships without 'also:' add no aliases", () => {
  const p = parseProfile(SAMPLE);
  // Shiva has no alias.
  assert.equal(p.aliases.has("shiva"), false);
});

test("relationshipFor resolves an alias number to the primary relationship", () => {
  const store = storeFrom(SAMPLE);
  // Reached from the second number (as a WhatsApp jid).
  assert.equal(
    store.relationshipFor("15551234567@s.whatsapp.net"),
    "brother-in-law",
  );
  // And from a +-prefixed / spaced form.
  assert.equal(store.relationshipFor("+1 555 987 6543"), "brother-in-law");
});

test("canonicalNameFor re-identifies the primary contact from an alias", () => {
  const store = storeFrom(SAMPLE);
  assert.equal(
    store.canonicalNameFor("15551234567@s.whatsapp.net"),
    "Sujith Penchala",
  );
  assert.equal(store.canonicalNameFor("+19998887777"), "Madhu");
  // A handle that isn't a known alias → undefined.
  assert.equal(store.canonicalNameFor("+10000000000"), undefined);
  // The PRIMARY number isn't itself an alias (no entry) — fine.
  assert.equal(store.canonicalNameFor("nobody"), undefined);
});

test("addressRuleFor resolves through an alias number", () => {
  const store = storeFrom(SAMPLE);
  const rule = store.addressRuleFor("19998887777@s.whatsapp.net");
  assert.ok(rule, "address rule should resolve via alias");
  assert.equal(rule!.addressAs, "Madhu");
  assert.deepEqual(rule!.neverCall, ["bro"]);
});

test("backward compatible: a profile with no aliases yields an empty aliases map", () => {
  const p = parseProfile(`## About me\nI'm Ada.\n\n## Relationships\n- Shiva: friend\n`);
  assert.equal(p.aliases.size, 0);
  assert.equal(p.relationships.get("shiva"), "friend");
});

test("email alias is lowercased + resolvable", () => {
  const store = storeFrom(
    `## About me\nx\n\n## Relationships\n- Raju: friend | also: Raju.Work@Example.COM\n`,
  );
  assert.equal(store.relationshipFor("raju.work@example.com"), "friend");
  assert.equal(store.canonicalNameFor("raju.work@example.com"), "Raju");
});
