import { test } from "node:test";
import assert from "node:assert/strict";
import {
  budgetPct,
  budgetTone,
  fmtMs,
  fmtUsd,
  incidentActions,
  incidentTone,
  kindLabel,
  MIN_BAR_PCT,
  waterfallRows,
  type RunTrace,
  type TraceNode,
} from "./observability.ts";

const node = (id: string, startMs: number, durationMs: number, extra: Partial<TraceNode> = {}): TraceNode => ({
  id, name: id, type: "step", status: "ok", startMs, durationMs, ...extra,
});
const trace = (runId: string, durationMs: number, steps: TraceNode[], childRuns: RunTrace[] = []): RunTrace => ({
  runId, status: "succeeded", agentName: "a", startedAt: "2026-01-01T00:00:00Z", durationMs, costUsd: 0, tokensIn: 0,
  tokensOut: 0, totals: { steps: steps.length, llmCalls: 0, toolCalls: 0, retries: 0 }, steps, childRuns,
});

test("waterfall positions bars on one axis and keeps every bar visible", () => {
  const rows = waterfallRows(trace("r", 1000, [node("a", 0, 500), node("b", 500, 0)]));
  assert.equal(rows[0].leftPct, 0);
  assert.equal(rows[0].widthPct, 50);
  assert.equal(rows[1].leftPct, 50);
  assert.ok(rows[1].widthPct >= MIN_BAR_PCT, "zero-duration step must still render a sliver");
});

test("child run steps are offset by the spawning step and nested one level deeper", () => {
  const child = trace("c", 200, [node("x", 0, 200)]);
  const rows = waterfallRows(trace("r", 1000, [node("sub", 400, 300, { type: "subagent", childRun: child })]));
  assert.deepEqual(rows.map((r) => [r.runId, r.depth]), [["r", 0], ["c", 1]]);
  assert.equal(rows[1].leftPct, 40);
  assert.equal(rows[1].widthPct, 20);
});

test("a step that overruns the recorded run duration still fits the axis", () => {
  const rows = waterfallRows(trace("r", 100, [node("a", 50, 450)]));
  for (const r of rows) assert.ok(r.leftPct + r.widthPct <= 100.0001);
});

test("formatters", () => {
  assert.equal(fmtMs(0.2), "<1ms");
  assert.equal(fmtMs(350), "350ms");
  assert.equal(fmtMs(1500), "1.50s");
  assert.equal(fmtMs(75_000), "1m 15s");
  assert.equal(fmtUsd(0), "$0");
  assert.equal(fmtUsd(0.0004), "$0.00040");
  assert.equal(fmtUsd(0.5), "$0.5000");
  assert.equal(fmtUsd(12.345), "$12.35");
});

test("incident actions mirror the server's transition rules", () => {
  assert.deepEqual(incidentActions("open"), ["acknowledge", "resolve"]);
  assert.deepEqual(incidentActions("acknowledged"), ["resolve"]);
  assert.deepEqual(incidentActions("resolved"), []);
  assert.equal(incidentTone({ severity: "page", status: "open" }), "bad");
  assert.equal(incidentTone({ severity: "ticket", status: "open" }), "warn");
  assert.equal(incidentTone({ severity: "page", status: "resolved" }), "muted");
});

test("labels and budget", () => {
  assert.equal(kindLabel("anomaly:error_rate"), "Error rate anomaly");
  assert.equal(kindLabel("slo:success"), "Success SLO burn");
  assert.equal(budgetPct(-0.4), 0);
  assert.equal(budgetPct(0.756), 76);
  assert.equal(budgetTone(-0.1), "bad");
  assert.equal(budgetTone(0.4), "warn");
  assert.equal(budgetTone(0.9), "ok");
});
