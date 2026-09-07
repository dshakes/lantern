//   cd packages/bridge-core && npx tsx --test src/contact-actions.test.ts
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { contactActionsBlock, type WorkingAction } from "./working-memory.ts";

const now = 1_800_000_000_000;
const LOG: WorkingAction[] = [
  { ts: now - 5 * 60_000, kind: "calendar_added", summary: "added 'dinner with Madhu' Sat 7pm to Calendar" },
  { ts: now - 9 * 60_000, kind: "note_saved", summary: "saved Ravi's address to Notes" },
  { ts: now - 7 * 3_600_000, kind: "calendar_added", summary: "added 'call Madhu' to Calendar" },
  { ts: now - 60_000, kind: "presence", summary: "Madhu is driving" },
];

test("a contact sees only the assistant's actions about THEM, recent, non-presence", () => {
  const b = contactActionsBlock(LOG, "Madhu K Mudarapu", now);
  assert.match(b, /dinner with Madhu/);
  assert.doesNotMatch(b, /Ravi/, "another person's action never leaks");
  assert.doesNotMatch(b, /call Madhu/, "7h old is outside the window");
  assert.doesNotMatch(b, /driving/, "presence is not an action");
  assert.match(b, /past tense/);
});

test("no name, a too-short name, or nothing about them → empty", () => {
  assert.equal(contactActionsBlock(LOG, undefined, now), "");
  assert.equal(contactActionsBlock(LOG, "M", now), "");
  assert.equal(contactActionsBlock(LOG, "Sowmyadhar", now), "");
  assert.equal(contactActionsBlock(LOG, "adh", now), "", "substring of a name is not the name");
});
