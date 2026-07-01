import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { handleSpouseMessage } from "./spouse-agent.ts";

const OPTS = { ownerName: "Shekhar", spouseName: "Manasa", nowISO: "2026-06-30T18:00:00-04:00" };
const OPEN = [
  { id: "c1", title: "pick up groceries" },
  { id: "c2", title: "call the plumber" },
];

describe("handleSpouseMessage", () => {
  test("actions: extracts multiple items + confirmation + owner summary", async () => {
    const llm = async () =>
      JSON.stringify({
        type: "actions",
        items: [
          { title: "get milk", kind: "shopping", urgency: "normal" },
          { title: "Kai's dentist", kind: "appointment", urgency: "normal", whenISO: "2026-07-01T15:00:00-04:00" },
        ],
        replyToSpouse: "got it — milk + added Kai's dentist to the calendar",
        ownerSummary: "Manasa: milk, Kai dentist tmrw 3",
      });
    const r = await handleSpouseMessage("get milk, Kai's dentist tomorrow at 3", { ...OPTS, openItems: OPEN }, llm);
    assert.equal(r?.type, "actions");
    if (r?.type === "actions") {
      assert.equal(r.items.length, 2);
      assert.ok(r.items[1].whenISO);
    }
  });

  test("status: answers truthfully from the open list (no fabricated done)", async () => {
    const llm = async () =>
      JSON.stringify({ type: "status", replyToSpouse: "not yet — the plumber's still on his list, i'll nudge him" });
    const r = await handleSpouseMessage("did you call the plumber yet?", { ...OPTS, openItems: OPEN }, llm);
    assert.equal(r?.type, "status");
    if (r?.type === "status") assert.match(r.replyToSpouse, /plumber/);
  });

  test("done: maps her completion report to the real open-item ids", async () => {
    const llm = async () =>
      JSON.stringify({ type: "done", doneIndices: [0], replyToSpouse: "nice, crossing groceries off 👍", ownerSummary: "Manasa got groceries" });
    const r = await handleSpouseMessage("i already grabbed the groceries", { ...OPTS, openItems: OPEN }, llm);
    assert.equal(r?.type, "done");
    if (r?.type === "done") assert.deepEqual(r.doneIds, ["c1"]);
  });

  test("done with out-of-range index → null (no bad mark)", async () => {
    const llm = async () => JSON.stringify({ type: "done", doneIndices: [9], replyToSpouse: "ok" });
    assert.equal(await handleSpouseMessage("done", { ...OPTS, openItems: OPEN }, llm), null);
  });

  test("recurring: parses a repeating reminder spec", async () => {
    const llm = async () =>
      JSON.stringify({ type: "recurring", reminder: { title: "take his meds", cadence: "daily", timeHHMM: "20:00" }, replyToSpouse: "on it, i'll remind him every night", ownerSummary: "nightly meds reminder" });
    const r = await handleSpouseMessage("every night at 8 remind him to take his meds", { ...OPTS, openItems: OPEN }, llm);
    assert.equal(r?.type, "recurring");
    if (r?.type === "recurring") {
      assert.equal(r.reminder.timeHHMM, "20:00");
      assert.equal(r.reminder.cadence, "daily");
    }
  });

  test("recurring weekly keeps valid days", async () => {
    const llm = async () =>
      JSON.stringify({ type: "recurring", reminder: { title: "call mom", cadence: "weekly", timeHHMM: "18:00", days: [0, 3, 9] }, replyToSpouse: "ok", ownerSummary: "call mom" });
    const r = await handleSpouseMessage("remind him to call mom sundays and wednesdays at 6", { ...OPTS, openItems: OPEN }, llm);
    if (r?.type === "recurring") assert.deepEqual(r.reminder.days, [0, 3]); // 9 dropped
  });

  test("list add/remove/show", async () => {
    const add = async () => JSON.stringify({ type: "list", op: "add", items: ["milk", "eggs"], replyToSpouse: "added milk + eggs" });
    let r = await handleSpouseMessage("add milk and eggs to the list", { ...OPTS, openItems: OPEN }, add);
    assert.equal(r?.type, "list");
    if (r?.type === "list") { assert.equal(r.op, "add"); assert.deepEqual(r.items, ["milk", "eggs"]); }
    const show = async () => JSON.stringify({ type: "list", op: "show", items: [], replyToSpouse: "" });
    r = await handleSpouseMessage("what's on our list?", { ...OPTS, openItems: OPEN }, show);
    assert.equal(r?.type === "list" && r.op, "show");
  });

  test("chat → null (normal reply runs)", async () => {
    const llm = async () => JSON.stringify({ type: "chat" });
    assert.equal(await handleSpouseMessage("miss you, how's your day?", { ...OPTS, openItems: OPEN }, llm), null);
  });

  test("malformed / throwing / no-llm → null, never throws", async () => {
    assert.equal(await handleSpouseMessage("get milk", OPTS, async () => "not json"), null);
    assert.equal(await handleSpouseMessage("get milk", OPTS, async () => { throw new Error("x"); }), null);
    assert.equal(await handleSpouseMessage("get milk", OPTS, undefined), null);
  });
});
