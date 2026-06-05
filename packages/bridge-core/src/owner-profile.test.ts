// Regression tests for the owner-profile parser. Run with:
//   cd packages/bridge-core && npx tsx --test src/owner-profile.test.ts
//
// These exist because the profile shapes the bot's voice + identity in
// every reply — a silent parse regression would make the bot sound wrong
// or leak template/instruction text into messages. Zero tolerance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { parseProfile, humanizeDate, OwnerProfileStore } from "./owner-profile.js";

const silentLogger = pino({ level: "silent" });

function storeFrom(content: string): OwnerProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "owner-profile-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, content, "utf8");
  return new OwnerProfileStore(silentLogger, path);
}

// A realistic profile that mirrors the structure the template produces,
// including the gotchas: "# ..." comment lines inside the relationships
// section, angle-bracket values the user forgot to strip, a parenthetical
// alias, multi-word values with commas, and an instructional preamble.
const SAMPLE = `# Owner profile

This shapes how the bot sounds. Do NOT put secrets here (passwords).
Edit freely; reloads within 30 seconds.

## About me
I'm Shekhar. I'm a founder building Lantern.

## How I text
- lowercase mostly, short
- never "certainly" or "sounds good!"

## My world
- Chantilly, VA / EST

## Relationships
# Format: "- Name: relationship"
# The bot uses this to match tone — warm for family, measured for work.
- Shiva: <friend>
- Maya(Mae): <Spouse>
- Arin Sharma: <son>
- Srinivas Merugu: <brother-in-law, Harika's spouse>
- +1 (512) 555-1234: college roommate
`;

test("prose excludes title + preamble + relationships + secrets warning", () => {
  const p = parseProfile(SAMPLE);
  assert.ok(!p.prose.includes("# Owner profile"), "title leaked into prose");
  assert.ok(!p.prose.includes("Do NOT put secrets"), "preamble leaked into prose");
  assert.ok(!p.prose.includes("Shiva"), "relationships leaked into prose");
  assert.ok(p.prose.includes("I'm Shekhar"), "About me missing from prose");
  assert.ok(p.prose.includes("never \"certainly\""), "How I text missing");
  assert.ok(p.prose.includes("Chantilly"), "My world missing");
});

test("comment lines inside relationships do not end the section", () => {
  const p = parseProfile(SAMPLE);
  // If the "# Format:" / "# The bot uses..." comments ended the section,
  // none of these would parse.
  assert.equal(p.relationships.get("shiva"), "friend");
  assert.equal(p.relationships.get("arin sharma"), "son");
});

test("angle-bracket template values are stripped", () => {
  const p = parseProfile(SAMPLE);
  assert.equal(p.relationships.get("shiva"), "friend"); // not "<friend>"
  assert.equal(p.relationships.get("arin sharma"), "son");
  for (const v of p.relationships.values()) {
    assert.ok(!v.includes("<") && !v.includes(">"), `value kept brackets: ${v}`);
  }
});

test("parenthetical aliases index all forms", () => {
  const p = parseProfile(SAMPLE);
  assert.equal(p.relationships.get("maya(mae)"), "Spouse");
  assert.equal(p.relationships.get("maya"), "Spouse");
  assert.equal(p.relationships.get("mae"), "Spouse");
});

test("multi-word value with comma survives (split on first colon only)", () => {
  const p = parseProfile(SAMPLE);
  assert.equal(
    p.relationships.get("srinivas merugu"),
    "brother-in-law, Harika's spouse",
  );
});

test("phone keys index a digit-only form", () => {
  const p = parseProfile(SAMPLE);
  // "+1 (512) 555-1234" → digits "15125551234"
  assert.equal(p.relationships.get("15125551234"), "college roommate");
});

test("empty / no-relationships profile yields empty map, prose intact", () => {
  const p = parseProfile(`## About me\njust me.\n`);
  assert.equal(p.relationships.size, 0);
  assert.ok(p.prose.includes("just me."));
});

test("a profile that is ALL preamble (no ## sections) yields empty prose", () => {
  const p = parseProfile(`# Title\nsome guidance text only\n`);
  assert.equal(p.prose, "");
  assert.equal(p.relationships.size, 0);
});

// ── Facts section ────────────────────────────────────────────────

const FACTS_SAMPLE = `# Owner profile

## About me
I'm Shekhar.

## Facts
- married: yes
- spouse: Maya
- kids: Aarav, Anaya
- wedding anniversary: 2017-06-03

## Relationships
- Sujith: brother-in-law | address as: Sujith | never: bava, anna
- Shiva: friend
`;

test("facts: parses marital status, spouse, kids, key dates", () => {
  const p = parseProfile(FACTS_SAMPLE);
  assert.ok(p.facts, "facts missing");
  assert.equal(p.facts!.maritalStatus, "married");
  assert.equal(p.facts!.spouse, "Maya");
  assert.deepEqual(p.facts!.kids, ["Aarav", "Anaya"]);
  assert.deepEqual(p.facts!.keyDates, [
    { label: "wedding anniversary", date: "2017-06-03" },
  ]);
});

test("facts: section kept out of prose (typed data, not voice)", () => {
  const p = parseProfile(FACTS_SAMPLE);
  assert.ok(!p.prose.includes("married: yes"), "facts leaked into prose");
  assert.ok(!p.prose.includes("2017-06-03"), "date leaked into prose");
});

test("facts: absent when no Facts section", () => {
  const p = parseProfile(SAMPLE);
  assert.equal(p.facts, undefined);
});

test("humanizeDate: YYYY-MM-DD → friendly", () => {
  assert.equal(humanizeDate("2017-06-03"), "June 3, 2017");
  assert.equal(humanizeDate("not a date"), "not a date");
});

test("factsBlock: deterministic ground-truth line", () => {
  const store = storeFrom(FACTS_SAMPLE);
  const block = store.factsBlock();
  assert.ok(block.startsWith("Owner facts (TRUE"), `unexpected: ${block}`);
  assert.ok(block.includes("married to Maya"), block);
  assert.ok(block.includes("kids: Aarav, Anaya"), block);
  assert.ok(block.includes("wedding anniversary June 3, 2017"), block);
});

test("factsBlock: empty when no facts", () => {
  const store = storeFrom(SAMPLE);
  assert.equal(store.factsBlock(), "");
});

// ── Per-contact address rules ────────────────────────────────────

test("addressRules: parses address-as + never from extended grammar", () => {
  const p = parseProfile(FACTS_SAMPLE);
  // Relationship still parses (backward compat).
  assert.equal(p.relationships.get("sujith"), "brother-in-law");
  const rule = p.addressRules.get("sujith");
  assert.ok(rule, "address rule missing");
  assert.equal(rule!.addressAs, "Sujith");
  assert.deepEqual(rule!.neverCall, ["bava", "anna"]);
});

test("addressRules: plain relationships have no rule (backward compat)", () => {
  const p = parseProfile(FACTS_SAMPLE);
  assert.equal(p.addressRules.get("shiva"), undefined);
  assert.equal(p.relationships.get("shiva"), "friend");
});

test("addressRuleFor: resolves by name", () => {
  const store = storeFrom(FACTS_SAMPLE);
  const rule = store.addressRuleFor("sujith");
  assert.ok(rule);
  assert.equal(rule!.addressAs, "Sujith");
  assert.deepEqual(rule!.neverCall, ["bava", "anna"]);
  assert.equal(store.addressRuleFor("shiva"), null);
  assert.equal(store.addressRuleFor("nobody"), null);
});

test("relationshipFor still works alongside address rules", () => {
  const store = storeFrom(FACTS_SAMPLE);
  assert.equal(store.relationshipFor("sujith"), "brother-in-law");
  assert.equal(store.relationshipFor("shiva"), "friend");
});

// ───────────────────────────────────────────────────────────────────
// SEALED owner-only knowledge vault ("## Private" / "## Vault" /
// "## Security"). SECURITY-CRITICAL: the vault body is captured into
// `privateVault` for owner-only consumers, but must NEVER appear in
// `prose` (prose is injected into contact-facing replies). A leak here
// would hand security-question answers to anyone the bot replies to.
// Dummy placeholder values only.
// ───────────────────────────────────────────────────────────────────
const VAULT_SAMPLE = `# Owner profile

## About me
I'm Shekhar. I'm a founder building Lantern.

## Private
- mother's maiden name: TestSurname
- birth city: TestCity
- first school: TestSchool
- security question honeypot: TestAnswer

## Relationships
- Shiva: friend
`;

test("vault: ## Private body lands in privateVault, NEVER in prose", () => {
  const p = parseProfile(VAULT_SAMPLE);
  // THE key security assertion: the secret is absent from contact-facing prose.
  assert.ok(!p.prose.includes("TestSurname"), "vault secret leaked into prose");
  assert.ok(!p.prose.includes("TestCity"), "vault secret leaked into prose");
  assert.ok(!p.prose.includes("TestSchool"), "vault secret leaked into prose");
  // The section header itself must not leak either.
  assert.ok(!p.prose.includes("Private"), "vault header leaked into prose");
  // But the owner-only field DOES capture it.
  assert.ok(p.privateVault.includes("TestSurname"), "vault missing maiden name");
  assert.ok(p.privateVault.includes("TestCity"), "vault missing birth city");
  assert.ok(p.privateVault.includes("TestSchool"), "vault missing first school");
  // Prose still has the real prose content.
  assert.ok(p.prose.includes("I'm Shekhar"), "About me missing from prose");
});

test("vault: ## Vault and ## Security aliases also seal", () => {
  for (const header of ["## Vault", "## Security"]) {
    const p = parseProfile(`# Owner profile\n\n## About me\nI'm Shekhar.\n\n${header}\n- mother's maiden name: TestSurname\n`);
    assert.ok(!p.prose.includes("TestSurname"), `${header}: leaked into prose`);
    assert.ok(p.privateVault.includes("TestSurname"), `${header}: missing from vault`);
  }
});

test("privateVaultBlock(): returns body for owner-only consumers, '' when absent", () => {
  const withVault = storeFrom(VAULT_SAMPLE);
  assert.ok(withVault.privateVaultBlock().includes("TestSurname"));
  assert.ok(withVault.privateVaultBlock().includes("TestCity"));
  // And the prose path (used for contact replies) stays clean.
  assert.ok(!withVault.prose().includes("TestSurname"));

  const noVault = storeFrom(FACTS_SAMPLE);
  assert.equal(noVault.privateVaultBlock(), "");
});

test("vault: relationships after the sealed section still parse (boundary)", () => {
  const p = parseProfile(VAULT_SAMPLE);
  // The ## Relationships section follows ## Private — confirm the vault
  // state machine releases on the next heading so people still parse.
  assert.equal(p.relationships.get("shiva"), "friend");
  // And Shiva (a relationship) is not in the vault.
  assert.ok(!p.privateVault.includes("Shiva"), "relationship bled into vault");
});
