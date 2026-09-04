// Regression for the "congrats to them" failure (2026-09-04).
//
// The owner publicly announced opening a store. A friend forwarded that
// announcement back and said "congratulations". The bot replied "congrats to
// them, that's exciting" and then asked the friend whether a store was opening
// near HIM. Two structural causes, both pinned here:
//
//   1. There was no bucket for a PUBLIC fact. `## Facts` is private-by-default
//      (contacts get "never confirm, never deny"), so the most important fact
//      in the owner's life was unrepresentable — and had it been in Facts, the
//      model would have been told NOT to confirm it.
//   2. The language scorer classified "Brambleton, VA" as French (0.95) on the
//      single 2-letter token "va", engaging a foreign-language reply mode on
//      the owner's own English announcement.
//
//   cd packages/bridge-core && npx tsx --test src/owner-public-facts.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OwnerProfileStore } from "./owner-profile.ts";
import { agentPersonaPrompt, type StyleProfile } from "./natural.ts";
import { detectLanguageHints } from "./language.ts";

const stub: any = { child() { return stub; }, info() {}, warn() {}, debug() {}, error() {} };
const STYLE: StyleProfile = { formality: "casual", mostlyLowercase: true } as StyleProfile;

function storeFor(md: string): OwnerProfileStore {
  const dir = mkdtempSync(join(tmpdir(), "op-"));
  const p = join(dir, "owner-profile.md");
  writeFileSync(p, md);
  return new OwnerProfileStore(stub, p);
}

const PROFILE = `# me
I text short and lowercase.

## Facts
- married: yes
- spouse: Sam

## Public
# comment lines are ignored
- Opening a Crispy Cones store in Brambleton, VA — grand opening Sep 10, 2026.
- Store 1 of 4 planned.

## Private
- mother's maiden name: Rao

## Relationships
- Sam: wife
`;

test("## Public is parsed into publicFacts and kept OUT of prose", () => {
  const s = storeFor(PROFILE);
  const pub = s.publicBlock();
  assert.match(pub, /Crispy Cones/);
  assert.match(pub, /Store 1 of 4/);
  assert.match(pub, /OK to confirm/);
  // Not a free-form voice sample; a typed block like Facts.
  assert.equal(s.prose().includes("Crispy Cones"), false, "public facts leaked into prose");
  // Comment lines under the header are not facts.
  assert.equal(pub.includes("comment lines"), false);
  // And it must not have been mistaken for the vault or for Facts.
  assert.equal(s.privateVaultBlock().includes("Crispy"), false);
  assert.equal((s.factsBlock() || "").includes("Crispy"), false);
});

test("header aliases: Announced / What I'm up to / Shareable all work", () => {
  for (const h of ["## Announced", "## What I'm up to", "## Shareable"]) {
    const s = storeFor(`# me\n\n${h}\n- launched a podcast\n\n## Relationships\n- Sam: wife\n`);
    assert.match(s.publicBlock(), /launched a podcast/, `header ${h} not recognised`);
  }
});

test("no ## Public section → empty block, no prompt change", () => {
  const s = storeFor(`# me\n\n## Facts\n- married: yes\n\n## Relationships\n- Sam: wife\n`);
  assert.equal(s.publicBlock(), "");
  const p = agentPersonaPrompt("Shekhar", STYLE, false, { ownerPublic: "" });
  assert.equal(p.includes("thank them as the person it happened to"), false);
});

test("the persona tells a CONTACT-facing model to OWN public news", () => {
  const s = storeFor(PROFILE);
  const p = agentPersonaPrompt("Shekhar", STYLE, false, { ownerPublic: s.publicBlock() });
  assert.match(p, /Crispy Cones/);
  assert.match(p, /thank them as the person it happened to/);
  assert.match(p, /never as an outsider \("congrats to them"\)/);
  assert.match(p, /never ask them whether it is happening near THEM/);
});

test("a US state code cannot classify a message as a foreign language", () => {
  assert.equal(detectLanguageHints("Brambleton, VA").primary, "english");
  assert.equal(detectLanguageHints("we are opening a store in Brambleton VA on the 10th").primary, "english");
  assert.equal(detectLanguageHints("see you in MA next week").primary, "english");
  assert.equal(detectLanguageHints("congratulations").primary, "english");
});

test("real romanized one-word and multi-word messages still detect", () => {
  assert.equal(detectLanguageHints("vasta").primary, "telugu");
  assert.equal(detectLanguageHints("ela unnav").primary, "telugu");
  assert.equal(detectLanguageHints("tu es ma soeur").primary, "french");
  assert.equal(detectLanguageHints("bonjour").primary, "french");
});
