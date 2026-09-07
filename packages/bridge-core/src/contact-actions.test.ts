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

test("newest actions win regardless of log order, and a shared first name requires the full name (review on #243)", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ ts: now - (9 - i) * 60_000, kind: "note_saved" as const, summary: `saved note ${i} for Madhu` }));
  const b = contactActionsBlock(many, "Madhu", now);
  assert.match(b, /note 8 for Madhu/, "the newest is kept");
  assert.doesNotMatch(b, /note 0 for Madhu/, "the oldest is dropped");
  const oldestFirst = [...many].reverse();
  assert.match(contactActionsBlock(oldestFirst, "Madhu", now), /note 8 for Madhu/, "order-independent");
  const two = [
    { ts: now - 60_000, kind: "calendar_added" as const, summary: "added lunch with Ravi Reddy" },
    { ts: now - 30_000, kind: "note_saved" as const, summary: "saved Ravi Kumar's address" },
  ];
  const kumar = contactActionsBlock(two, "Ravi Kumar", now, { sharedFirstName: true });
  assert.match(kumar, /Ravi Kumar's address/);
  assert.doesNotMatch(kumar, /Ravi Reddy/, "the other Ravi's action never leaks");
  assert.equal(contactActionsBlock(two, "Ravi", now, { sharedFirstName: true }), "", "no full name to disambiguate → nothing");
});
