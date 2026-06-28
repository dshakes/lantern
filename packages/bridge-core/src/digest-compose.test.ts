// Tests for composeDigestNarrative — deterministic path only (no network).
//   cd packages/bridge-core && node --import=tsx/esm --test src/digest-compose.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { composeDigestNarrative } from "./digest-compose.ts";
import type { DigestData } from "./daily-digest.ts";

// Baseline empty-ish data: the minimum valid DigestData.
const EMPTY: DigestData = {
  repliesSent: 0,
  pausedContacts: [],
  monitoredChats: 0,
  escalations: 0,
  channelLabel: "WhatsApp",
};

const FUTURE_MS = Date.now() + 60 * 60_000; // 1h from now

// Force deterministic path by unsetting the env flag (it defaults to "1" / on,
// but we pass no llmCompose, so it always falls through to deterministic).

test("urgent commitment leads the brief", async () => {
  const data: DigestData = {
    ...EMPTY,
    commitments: [
      { title: "file tax extension", urgency: "now" },
      { title: "reply to dentist", urgency: "normal" },
    ],
  };
  const out = await composeDigestNarrative(data);
  const lines = out.split("\n").filter(Boolean);
  // First bullet must be the urgent task.
  const firstBullet = lines.find((l) => l.startsWith("•")) ?? "";
  assert.match(firstBullet, /tax extension/i, "urgent task leads");
  // Output is short (≤ 8 lines total).
  assert.ok(lines.length <= 8, `too long: ${lines.length} lines`);
});

test("urgent commitment outranks ops stats", async () => {
  const data: DigestData = {
    ...EMPTY,
    repliesSent: 20, // high ops count
    commitments: [{ title: "send Raju the deck", urgency: "now" }],
  };
  const out = await composeDigestNarrative(data);
  const bullets = out.split("\n").filter((l) => l.startsWith("•"));
  assert.ok(bullets.length >= 1);
  assert.match(bullets[0], /Raju/i, "urgent task before ops stats");
});

test("escalation appears near the top when no urgent task", async () => {
  const data: DigestData = {
    ...EMPTY,
    escalations: 2,
    repliesSent: 10,
  };
  const out = await composeDigestNarrative(data);
  const bullets = out.split("\n").filter((l) => l.startsWith("•"));
  assert.ok(bullets.some((b) => /escalation/i.test(b)), "escalation in output");
  assert.match(bullets[0], /escalation/i, "escalation leads");
});

test("empty data emits quiet-night message with no bullet noise", async () => {
  const out = await composeDigestNarrative(EMPTY);
  assert.match(out, /quiet/i, "says quiet when nothing happening");
  const bullets = out.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(bullets.length, 0, "no bullets for empty data");
});

test("zero repliesSent omitted (no '0 auto-replies' noise)", async () => {
  const out = await composeDigestNarrative(EMPTY);
  assert.ok(!/0 auto-repl/i.test(out), "zero ops count is omitted");
});

test("life-event with money keyword ranks above normal life-event", async () => {
  const data: DigestData = {
    ...EMPTY,
    lifeEvents: ["newsletter from blog.co", "PG&E bill due $48"],
  };
  const out = await composeDigestNarrative(data);
  const bullets = out.split("\n").filter((l) => l.startsWith("•"));
  const moneyIdx = bullets.findIndex((b) => /\$48|PG&E/i.test(b));
  const otherIdx = bullets.findIndex((b) => /newsletter/i.test(b));
  assert.ok(moneyIdx !== -1, "money life-event present");
  assert.ok(moneyIdx < otherIdx, "money event ranks above generic event");
});

test("overdue contact appears with name + days", async () => {
  const data: DigestData = {
    ...EMPTY,
    overdueContacts: [{ displayName: "Manu", daysOverdue: 3 }],
  };
  const out = await composeDigestNarrative(data);
  assert.match(out, /Manu/i, "overdue contact name present");
  assert.match(out, /3d/i, "days overdue present");
});

test("short sleep surfaces with hours", async () => {
  const data: DigestData = { ...EMPTY, sleepHours: 4.5 };
  const out = await composeDigestNarrative(data);
  assert.match(out, /4\.5h|slept/i, "sleep hours in output");
});

test("fine sleep (7h) is NOT mentioned", async () => {
  const data: DigestData = { ...EMPTY, sleepHours: 7 };
  const out = await composeDigestNarrative(data);
  assert.ok(!/slept/i.test(out), "fine sleep hours not mentioned");
});

test("one-click action hint ends the brief when commitments present", async () => {
  const data: DigestData = {
    ...EMPTY,
    commitments: [{ title: "book dentist", urgency: "soon" }],
  };
  const out = await composeDigestNarrative(data);
  assert.match(out, /→/, "one-click hint present");
});

test("one-click action hint for overdue contact names the person", async () => {
  const data: DigestData = {
    ...EMPTY,
    overdueContacts: [{ displayName: "Sujith", daysOverdue: 4 }],
  };
  const out = await composeDigestNarrative(data);
  assert.match(out, /Sujith/, "contact name in coda");
});

test("output is short (≤ 8 lines with full data)", async () => {
  const data: DigestData = {
    repliesSent: 14,
    pausedContacts: [{ label: "Mom", resumesAtMs: FUTURE_MS }],
    monitoredChats: 2,
    escalations: 1,
    channelLabel: "WhatsApp",
    lifeEvents: ["delivery arriving", "PG&E bill due $48"],
    commitments: [{ title: "file taxes", urgency: "now" }],
    overdueContacts: [{ displayName: "Raju", daysOverdue: 3 }],
    sleepHours: 5.5,
    nextEvent: "standup in 25 min",
  };
  const out = await composeDigestNarrative(data);
  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.length <= 8, `too long: ${lines.length} lines\n${out}`);
});

test("never fabricates data not in DigestData", async () => {
  const data: DigestData = {
    ...EMPTY,
    nextEvent: "1:1 with Alice in 30 min",
  };
  const out = await composeDigestNarrative(data);
  // Should NOT mention anything that wasn't in data
  assert.ok(!/tax|bill|Raju|dentist|deck/i.test(out), "no fabricated items");
  assert.match(out, /Alice|1:1/i, "real data appears");
});

test("LLM path fallback: llmCompose returning null uses deterministic", async () => {
  const data: DigestData = {
    ...EMPTY,
    commitments: [{ title: "call doctor", urgency: "now" }],
  };
  const out = await composeDigestNarrative(data, {
    llmCompose: async () => null, // simulates LLM returning nothing
  });
  // Deterministic path should still include the commitment.
  assert.match(out, /call doctor/i, "fallback deterministic includes commitment");
});

test("LLM path fallback: llmCompose throwing uses deterministic", async () => {
  const data: DigestData = {
    ...EMPTY,
    commitments: [{ title: "reply to accountant", urgency: "soon" }],
  };
  const out = await composeDigestNarrative(data, {
    llmCompose: async () => { throw new Error("network error"); },
  });
  assert.match(out, /accountant/i, "fallback deterministic includes commitment");
});

test("LLM path used when llmCompose returns non-empty string", async () => {
  const data: DigestData = { ...EMPTY };
  const custom = "yo — nothing urgent today. enjoy the quiet.";
  const out = await composeDigestNarrative(data, {
    llmCompose: async () => custom,
  });
  assert.equal(out, custom, "LLM reply used verbatim when non-empty");
});

test("output is owner-toned: date header is lowercase", async () => {
  const out = await composeDigestNarrative(EMPTY);
  // The date line should be there and lowercase (ponytail: lowercase = casual owner style)
  const dateLine = out.split("\n")[0];
  assert.equal(dateLine, dateLine.toLowerCase() || dateLine, "date line is lowercase");
});
