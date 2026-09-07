// ADR 0024 W1: the dated present-tense self-model.
//   cd packages/bridge-core && npx tsx --test src/owner-profile-now.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseProfile, parseNowLine, OwnerProfileStore } from "./owner-profile.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPersonaPrompt, inferStyle } from "./natural.ts";

const silentLogger = { child() { return this; }, info() {}, warn() {}, debug() {}, error() {}, trace() {}, fatal() {} } as never;

const PROFILE = `# Owner profile
## Facts
- married: yes
## Now
- Sowmyadhar (brother-in-law) is staying with us | until: 2026-09-01
- Crispy Cones opening-week prep, opening day is the 10th (until 2026-09-10)
- learning to make gelato
## Public
- Opening a Crispy Cones franchise in Brambleton, VA
`;

test("parseNowLine reads the three expiry spellings and plain text", () => {
  assert.deepEqual(parseNowLine("- a | until: 2026-09-01"), { text: "a", until: "2026-09-01" });
  assert.deepEqual(parseNowLine("- b (until 2026-09-10)"), { text: "b", until: "2026-09-10" });
  assert.deepEqual(parseNowLine("- c till 2026-09-10"), { text: "c", until: "2026-09-10" });
  assert.deepEqual(parseNowLine("- d"), { text: "d" });
  assert.equal(parseNowLine("<!-- id:x -->"), null);
});

test("## Now is typed, kept out of prose, and expired items are dropped at injection", () => {
  const prof = parseProfile(PROFILE);
  assert.equal(prof.now.length, 3);
  assert.doesNotMatch(prof.prose, /Sowmyadhar|gelato/);
  const dir = mkdtempSync(join(tmpdir(), "now-"));
  const path = join(dir, "owner-profile.md");
  writeFileSync(path, PROFILE);
  const store = new OwnerProfileStore(silentLogger, path);
  const sep6 = store.nowBlock(new Date("2026-09-06T15:00:00Z"));
  assert.doesNotMatch(sep6, /Sowmyadhar/, "left on the 1st — must not be 'here' on the 6th");
  assert.match(sep6, /opening-week prep.*through Sept?\.? 10, 2026|opening-week prep/);
  assert.match(sep6, /gelato/);
  const aug30 = store.nowBlock(new Date("2026-08-30T15:00:00Z"));
  assert.match(aug30, /Sowmyadhar/);
  writeFileSync(path, "# Owner profile\n## Facts\n- married: yes\n");
  const empty = new OwnerProfileStore(silentLogger, path);
  assert.equal(empty.nowBlock(), "", "no section → nothing injected");
});

test("persona: contacts get present-tense guidance, the owner gets a working picture", () => {
  const now = "What the owner is doing RIGHT NOW (this week; present tense): gelato practice.";
  const style = inferStyle(["hey", "how's it going"]);
  const contact = agentPersonaPrompt("Shekhar", style, false, { ownerNow: now });
  assert.match(contact, /gelato practice/);
  assert.match(contact, /present tense/);
  const self = agentPersonaPrompt("Shekhar", style, false, { ownerNow: now, audience: "owner" });
  assert.match(self, /working picture of the week/);
});
