import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fuseKnownPeople, buildKnownPeopleBlock, normalizeProfilePerson } from "./known-people.ts";

test("normalizeProfilePerson: clean name + short label", () => {
  assert.deepEqual(
    normalizeProfilePerson("Manasa", 'wife — ALWAYS address as "Manasa". The "Manu" alias…'),
    { name: "Manasa", relationship: "wife" },
  );
  assert.deepEqual(normalizeProfilePerson("Ved Mudarapu", "son"), { name: "Ved Mudarapu", relationship: "son" });
  // keeps the person but drops a noisy non-relationship label
  assert.deepEqual(normalizeProfilePerson("Madhu K Mudarapu", "lives in Dublin, CA"), { name: "Madhu K Mudarapu", relationship: undefined });
});

test("normalizeProfilePerson: rejects markdown/section-note artifacts", () => {
  assert.equal(normalizeProfilePerson('**brothers-in-law never addressed as "bava"', "** Sowmyadhar, Srinivas"), null);
  assert.equal(normalizeProfilePerson("specific address mappings", "see the Relationships section below"), null);
  assert.equal(normalizeProfilePerson("", "wife"), null);
});

const NOW = 1_750_000_000_000; // fixed clock
const day = 86_400_000;

test("profile person is enriched with their most-active matching thread", () => {
  const people = fuseKnownPeople(
    [{ name: "Manasa", relationship: "wife" }],
    [
      { handle: "+16303475128", name: "Manasa", msgs: 227, lastTs: NOW - day },
      { handle: "+15713085176", name: "Manasa Sesham", msgs: 1, lastTs: NOW - 200 * day },
    ],
  );
  // wife resolves to the ACTIVE thread (227), not the dead namesake (1)
  assert.equal(people[0].name, "Manasa");
  assert.equal(people[0].relationship, "wife");
  assert.equal(people[0].handle, "+16303475128");
  assert.equal(people[0].msgs, 227);
});

test("profile people rank first; active non-profile threads backfill by volume", () => {
  const people = fuseKnownPeople(
    [{ name: "Manasa", relationship: "wife" }],
    [
      { handle: "+1999", name: "Chantell", msgs: 40, lastTs: NOW - day },
      { handle: "+16303475128", name: "Manasa", msgs: 227, lastTs: NOW - day },
      { handle: "+1888", name: "Raju", msgs: 12, lastTs: NOW - 2 * day },
    ],
  );
  assert.equal(people[0].name, "Manasa"); // profile first
  assert.equal(people[1].name, "Chantell"); // then by activity
  assert.equal(people[2].name, "Raju");
});

test("does NOT fold distinct namesakes together (Manasa vs Manish)", () => {
  const people = fuseKnownPeople(
    [{ name: "Manasa", relationship: "wife" }],
    [{ handle: "+1777", name: "Manish", msgs: 50, lastTs: NOW }],
  );
  assert.equal(people.find((p) => p.name === "Manasa")?.handle, undefined); // wife not matched to Manish
  assert.equal(people.find((p) => p.name === "Manish")?.handle, "+1777"); // Manish backfilled separately
});

test("block grounds the LLM and never empty when people exist", () => {
  const block = buildKnownPeopleBlock(
    [{ name: "Manasa", relationship: "wife" }],
    [{ handle: "+16303475128", name: "Manasa", msgs: 227, lastTs: NOW - day }],
    { nowMs: NOW },
  );
  assert.match(block, /# Your people/);
  assert.match(block, /Manasa — your wife · 227 msgs\/30d, last yesterday · \+16303475128/);
  assert.match(block, /never claim a top\s+contact went silent/);
});

test("empty inputs → empty block", () => {
  assert.equal(buildKnownPeopleBlock([], [], { nowMs: NOW }), "");
});
