import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RAIL,
  containsProviderKey,
  decideView,
  latestData,
  maskSecrets,
  optimisticUserMessage,
  railCurrent,
  railStatuses,
  toolLabel,
  toolResult,
  channelSummary,
  type Facts,
} from "./agent-chat-logic.ts";

const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";

test("railStatuses: runtime rows come from facts, not list order", () => {
  const f: Facts = { providerReady: true, phase: "create", runtime: { goal: "standups", spec: { name: "s" } } };
  const st = Object.fromEntries(railStatuses("runtime", f).map((r) => [r.id, r.status]));
  assert.deepEqual(st, { provider: "done", goal: "done", spec: "current", create: "todo", run: "todo", done: "todo" });
});

test("railStatuses: a finished setup shows every row done, none current", () => {
  for (const [p, f] of [
    ["runtime", { providerReady: true, phase: "done", runtime: { goal: "g", spec: { name: "s" }, agentCreated: true, runStatus: "succeeded", completedAt: "x" } }],
    ["pal", { providerReady: true, phase: "done", channelsVerified: true, pal: { consent: { version: "2026-10", acceptedAt: "x" }, voice: { skipped: true }, trust: { prefsSaved: true, holdsAcknowledged: true }, profile: { done: true }, completedAt: "x" } }],
  ] as const) {
    assert.ok(railStatuses(p, f as Facts).every((r) => r.status === "done"), p);
  }
});

test("railStatuses: no key yet puts the key row first and current", () => {
  for (const p of ["runtime", "pal"] as const) {
    const rows = railStatuses(p, { providerReady: false, phase: "provider" });
    assert.equal(rows[0].id, "provider");
    assert.equal(rows[0].status, "current");
    assert.ok(rows.slice(1).every((r) => r.status === "todo"));
  }
});

test("railStatuses: pal — consent + live channel, voice current", () => {
  const f: Facts = {
    providerReady: true,
    phase: "voice",
    channelsVerified: true,
    pal: { consent: { version: "2026-10", acceptedAt: "2026-10-30T00:00:00Z", voiceSampling: true } },
  };
  const st = Object.fromEntries(railStatuses("pal", f).map((r) => [r.id, r.status]));
  assert.equal(st.welcome, "done");
  assert.equal(st.channels, "done");
  assert.equal(st.voice, "current");
  assert.equal(st.trust, "todo");
});

test("railStatuses: an outdated consent version is not done", () => {
  const f: Facts = { providerReady: true, phase: "welcome", pal: { consent: { version: "2025-01", acceptedAt: "x" } } };
  assert.equal(railStatuses("pal", f).find((r) => r.id === "welcome")?.status, "current");
});

test("railCurrent maps the runtime finish phase onto the last row", () => {
  assert.equal(railCurrent("runtime", "finish"), "done");
  assert.equal(railCurrent("pal", "trust"), "trust");
  assert.ok(RAIL.runtime.some((r) => r.id === "done"));
});

test("decideView: only a model failure or a dead endpoint drops to the wizard", () => {
  assert.deepEqual(decideView({ mode: "agent" }), { kind: "chat" });
  assert.deepEqual(decideView({ mode: "scripted" }), { kind: "chat" });
  const fb = decideView({ mode: "fallback", fallbackReason: "the model call failed" });
  assert.equal(fb.kind, "wizard");
  assert.match((fb as { reason: string }).reason, /^The model call failed\./);
  const err = decideView(null, new Error("API 503: down"));
  assert.equal(err.kind, "wizard");
  assert.match((err as { reason: string }).reason, /isn't reachable \(down\)/);
});

test("maskSecrets / containsProviderKey", () => {
  assert.ok(containsProviderKey(`my key ${KEY}`));
  assert.ok(containsProviderKey("sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.ok(!containsProviderKey("a skeleton key"));
  const m = maskSecrets(`use ${KEY} please`);
  assert.ok(!m.includes("ABCDEFGH"));
  assert.match(m, /removed from chat/);
  // repeated calls are stable (global regex lastIndex must not leak state)
  assert.ok(containsProviderKey(KEY) && containsProviderKey(KEY));
});

test("optimisticUserMessage masks and skips empty", () => {
  assert.equal(optimisticUserMessage("   "), null);
  assert.ok(!optimisticUserMessage(KEY)!.text.includes("ABCDEFGH"));
});

test("toolResult never carries a key and is capped", () => {
  const r = toolResult({ id: "a1", tool: "collect_provider_key" }, true, `saved ${KEY} ${"x".repeat(1000)}`);
  assert.equal(r.actionId, "a1");
  assert.ok(!r.summary.includes("ABCDEFGH"));
  assert.ok(r.summary.length <= 400);
  const c = toolResult({ id: "a2", tool: "check_channels" }, false, "x", { whatsapp: "needs_pairing", imessage: "ready" });
  assert.deepEqual(c.channels, { whatsapp: "needs_pairing", imessage: "ready" });
});

test("channelSummary is human", () => {
  assert.equal(channelSummary({ whatsapp: "needs_pairing", imessage: "ready" }), "iMessage connected; WhatsApp needs pairing");
});

test("toolLabel + latestData", () => {
  assert.equal(toolLabel("design_agent"), "Designed the agent");
  assert.equal(toolLabel("collect_provider_key"), "Add a model key");
  assert.equal(toolLabel("weird_tool"), "weird tool");
  const calls = [
    { tool: "design_agent", ok: true, summary: "", data: { name: "a" } },
    { tool: "design_agent", ok: false, summary: "" },
    { tool: "design_agent", ok: true, summary: "", data: { name: "b" } },
  ];
  assert.deepEqual(latestData(calls, "design_agent"), { name: "b" });
  assert.equal(latestData(calls, "start_run"), null);
});
