// node:test suite for action-plan.ts — multi-action plan-preview-confirm.
// Run: node --import=tsx/esm --test src/action-plan.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  matchPlanRequest,
  buildPlanPrompt,
  parseActionPlan,
  formatPlanPreview,
  parsePlanReply,
  dropStep,
  PLAN_TTL_MS,
  type ActionPlan,
} from "./action-plan.ts";

const NOW = new Date("2026-07-06T14:00:00");

describe("matchPlanRequest", () => {
  it("fires on ≥2 action clauses joined by a conjunction/comma", () => {
    assert.equal(
      matchPlanRequest("tell Madhu I'll call tonight, snooze the lease thing, and add fireworks Saturday 9pm"),
      true,
    );
    assert.equal(matchPlanRequest("text Sam I'm running late and remind me to call the bank"), true);
    assert.equal(matchPlanRequest("add dentist Tuesday 3pm, note the account number"), true);
  });

  it("does NOT fire on a single action", () => {
    assert.equal(matchPlanRequest("remind me to call the bank tomorrow"), false);
    assert.equal(matchPlanRequest("add fireworks Saturday 9pm"), false);
    assert.equal(matchPlanRequest("text Madhu I'll be there"), false);
  });

  it("does NOT hijack ordinary conversational messages with 'and'", () => {
    assert.equal(matchPlanRequest("hey how are you and the kids doing"), false);
    assert.equal(matchPlanRequest("I went to the store and then came home"), false);
    assert.equal(matchPlanRequest("thanks, that works"), false);
  });

  it("rejects too-short and too-long inputs", () => {
    assert.equal(matchPlanRequest("add x, y"), false); // < 12 chars
    assert.equal(matchPlanRequest("tell a, add b" + " x".repeat(400)), false); // > 600 chars
  });
});

describe("buildPlanPrompt", () => {
  it("includes the request, the clock, and known contacts", () => {
    const p = buildPlanPrompt("tell Madhu hi and add lunch", {
      now: NOW,
      timezone: "America/Chicago",
      contacts: ["Madhu", "Sam"],
    });
    assert.match(p, /tell Madhu hi and add lunch/);
    assert.match(p, /America\/Chicago/);
    assert.match(p, /Madhu, Sam/);
    assert.match(p, /STRICT JSON/);
  });
});

describe("parseActionPlan", () => {
  it("parses a well-formed multi-step plan", () => {
    const raw = JSON.stringify({
      steps: [
        { kind: "message", contact: "Madhu", body: "I'll call tonight", summary: "text Madhu" },
        { kind: "calendar", title: "Fireworks", start: "2026-07-11T21:00:00", summary: "add fireworks sat" },
        { kind: "snooze", target: "the lease thing", summary: "snooze lease" },
      ],
    });
    const plan = parseActionPlan(raw);
    assert.ok(plan);
    assert.equal(plan!.steps.length, 3);
    assert.equal(plan!.steps[0].kind, "message");
    assert.equal(plan!.steps[1].kind, "calendar");
    assert.equal(plan!.steps[2].kind, "snooze");
  });

  it("extracts JSON even wrapped in prose/code fences", () => {
    const raw = 'Here is the plan:\n```json\n{"steps":[{"kind":"note","title":"Lease terms"}]}\n```\ndone';
    const plan = parseActionPlan(raw);
    assert.ok(plan);
    assert.equal(plan!.steps[0].kind, "note");
  });

  it("drops invalid steps but keeps valid ones", () => {
    const raw = JSON.stringify({
      steps: [
        { kind: "message", contact: "", body: "hi" }, // invalid: no contact
        { kind: "calendar", title: "Dinner", start: "2026-07-06T19:00:00" }, // valid
        { kind: "bogus", foo: 1 }, // invalid: unknown kind
        { kind: "note" }, // invalid: no title
      ],
    });
    const plan = parseActionPlan(raw);
    assert.ok(plan);
    assert.equal(plan!.steps.length, 1);
    assert.equal(plan!.steps[0].kind, "calendar");
  });

  it("returns null on garbage / empty / no-valid-steps", () => {
    assert.equal(parseActionPlan("not json at all"), null);
    assert.equal(parseActionPlan(""), null);
    assert.equal(parseActionPlan('{"steps":[]}'), null);
    assert.equal(parseActionPlan('{"steps":[{"kind":"message"}]}'), null);
  });

  it("maps legacy 'skip' kind to snooze", () => {
    const plan = parseActionPlan('{"steps":[{"kind":"skip","target":"draft 2"}]}');
    assert.ok(plan);
    assert.equal(plan!.steps[0].kind, "snooze");
  });
});

describe("formatPlanPreview", () => {
  it("renders one compact numbered message with a confirm line", () => {
    const plan: ActionPlan = {
      steps: [
        { kind: "message", contact: "Madhu", body: "call tonight", summary: "text Madhu about the call" },
        { kind: "calendar", title: "Fireworks", start: "2026-07-11T21:00:00", summary: "add fireworks sat 9pm" },
      ],
    };
    const out = formatPlanPreview(plan);
    assert.match(out, /1\. text Madhu about the call/);
    assert.match(out, /2\. add fireworks sat 9pm/);
    assert.match(out, /do it/);
    assert.match(out, /skip/);
  });

  it("derives a line when the LLM omits a summary", () => {
    const plan: ActionPlan = { steps: [{ kind: "snooze", target: "the lease thing" }] };
    assert.match(formatPlanPreview(plan), /1\. snooze the lease thing/);
  });
});

describe("parsePlanReply", () => {
  it("recognizes confirm phrases and the thumbs-up emoji", () => {
    for (const t of ["do it", "yes", "go ahead", "send it", "confirm", "ok", "👍"]) {
      assert.deepEqual(parsePlanReply(t), { confirm: true }, t);
    }
  });

  it("recognizes step-drop in both orders", () => {
    assert.deepEqual(parsePlanReply("2 skip"), { drop: 2 });
    assert.deepEqual(parsePlanReply("skip 3"), { drop: 3 });
    assert.deepEqual(parsePlanReply("drop 1"), { drop: 1 });
  });

  it("recognizes cancel", () => {
    assert.deepEqual(parsePlanReply("cancel"), { cancel: true });
    assert.deepEqual(parsePlanReply("nvm"), { cancel: true });
  });

  it("returns null for anything else", () => {
    assert.equal(parsePlanReply("tell Madhu something"), null);
    assert.equal(parsePlanReply("what's the plan"), null);
    assert.equal(parsePlanReply(""), null);
  });
});

describe("dropStep", () => {
  const plan: ActionPlan = {
    steps: [
      { kind: "message", contact: "A", body: "x" },
      { kind: "note", title: "B" },
      { kind: "snooze", target: "C" },
    ],
  };

  it("removes the 1-based step", () => {
    const out = dropStep(plan, 2);
    assert.equal(out.steps.length, 2);
    assert.equal((out.steps[0] as { contact: string }).contact, "A");
    assert.equal((out.steps[1] as { target: string }).target, "C");
  });

  it("is a no-op when out of range", () => {
    assert.equal(dropStep(plan, 0).steps.length, 3);
    assert.equal(dropStep(plan, 9).steps.length, 3);
  });
});

describe("TTL", () => {
  it("exposes a 10-minute staging window", () => {
    assert.equal(PLAN_TTL_MS, 10 * 60 * 1000);
  });
});
