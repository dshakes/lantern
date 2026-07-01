import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { planSpouseActions } from "./spouse-agent.ts";

const OPTS = { ownerName: "Shekhar", spouseName: "Manasa", nowISO: "2026-06-30T18:00:00-04:00" };

describe("planSpouseActions", () => {
  test("extracts multiple action items + confirmation + owner summary", async () => {
    const llm = async () =>
      JSON.stringify({
        items: [
          { title: "get milk", kind: "shopping", urgency: "normal" },
          { title: "call the plumber", kind: "task", urgency: "soon" },
          { title: "Kai's dentist", kind: "appointment", urgency: "normal", whenISO: "2026-07-01T15:00:00-04:00" },
        ],
        replyToSpouse: "got it — i'll grab milk and call the plumber, and put Kai's dentist on the calendar",
        ownerSummary: "Manasa: milk, call plumber, Kai dentist tmrw 3pm",
      });
    const plan = await planSpouseActions("get milk and call the plumber, Kai's dentist is tomorrow at 3", OPTS, llm);
    assert.equal(plan?.items.length, 3);
    assert.equal(plan?.items[2].kind, "appointment");
    assert.ok(plan?.items[2].whenISO);
    assert.match(plan?.replyToSpouse ?? "", /milk/);
    assert.match(plan?.ownerSummary ?? "", /Manasa/);
  });

  test("no action items → null (normal chat untouched)", async () => {
    const llm = async () => JSON.stringify({ items: [] });
    assert.equal(await planSpouseActions("miss you, how's your day going?", OPTS, llm), null);
  });

  test("drops malformed items but keeps valid ones", async () => {
    const llm = async () =>
      JSON.stringify({ items: [{ title: "x" }, { title: "pick up dry cleaning", kind: "task" }], replyToSpouse: "ok", ownerSummary: "" });
    const plan = await planSpouseActions("pick up dry cleaning", OPTS, llm);
    assert.equal(plan?.items.length, 1);
    assert.equal(plan?.items[0].title, "pick up dry cleaning");
    assert.equal(plan?.ownerSummary, "pick up dry cleaning"); // fallback summary
  });

  test("invalid whenISO is dropped (no bad calendar event)", async () => {
    const llm = async () => JSON.stringify({ items: [{ title: "book flights", kind: "task", whenISO: "not-a-date" }], replyToSpouse: "on it", ownerSummary: "flights" });
    const plan = await planSpouseActions("book the flights", OPTS, llm);
    assert.equal(plan?.items[0].whenISO, undefined);
  });

  test("malformed / throwing LLM → null, never throws", async () => {
    assert.equal(await planSpouseActions("get milk", OPTS, async () => "not json"), null);
    assert.equal(await planSpouseActions("get milk", OPTS, async () => { throw new Error("x"); }), null);
    assert.equal(await planSpouseActions("get milk", OPTS, undefined), null);
  });
});
