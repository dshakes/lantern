import { test } from "node:test";
import { strict as assert } from "node:assert";
import { TurnBindings } from "./entity-binding.ts";

test("same handle in two forms returns one consistent name", () => {
  const t = new TurnBindings();
  t.bind("+16303475128", "Arun");
  assert.equal(t.nameFor("16303475128@s.whatsapp.net"), "Arun");
  assert.equal(t.nameFor("+16303475128"), "Arun");
});

test("explicit binding overrides a prior heuristic binding", () => {
  const t = new TurnBindings();
  t.bind("+16303475128", "Arun");                          // heuristic first
  t.bind("16303475128@s.whatsapp.net", "Aarun", { explicit: true }); // correction
  assert.equal(t.nameFor("+16303475128"), "Aarun");
});

test("heuristic does not override an explicit binding", () => {
  const t = new TurnBindings();
  t.bind("+16303475128", "Aarun", { explicit: true });     // owner correction first
  t.bind("16303475128@s.whatsapp.net", "Arun");            // heuristic later
  assert.equal(t.nameFor("+16303475128"), "Aarun");        // explicit wins
});

test("unbound handle returns null", () => {
  const t = new TurnBindings();
  assert.equal(t.nameFor("+15125551234"), null);
});

test("two distinct handles bind independently", () => {
  const t = new TurnBindings();
  t.bind("+16303475128", "Arun");
  t.bind("+15125551234", "Manasa");
  assert.equal(t.nameFor("+16303475128"), "Arun");
  assert.equal(t.nameFor("+15125551234"), "Manasa");
});

test("second heuristic binding on same handle is ignored (first wins)", () => {
  const t = new TurnBindings();
  t.bind("+16303475128", "Arun");
  t.bind("+16303475128", "Manasa"); // second heuristic — must not flip
  assert.equal(t.nameFor("+16303475128"), "Arun");
});
