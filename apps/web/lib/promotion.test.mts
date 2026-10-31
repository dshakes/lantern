import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarizeDetail,
  canRollback,
  envBadgeLabel,
  errorRate,
  fmtPct,
  gatesFailed,
  parseApiError,
  proposedBy,
  validatePromote,
  type EnvState,
} from "./promotion.ts";

const base: EnvState = { env: "prod", version: "v2", previousVersion: "v1", status: "active" };

test("canRollback", () => {
  assert.equal(canRollback(base), true);
  assert.equal(canRollback({ ...base, previousVersion: null }), false);
  assert.equal(canRollback({ ...base, previousVersion: "v2" }), false);
  assert.equal(canRollback({ ...base, previousVersion: null, status: "canary" }), true);
});

test("envBadgeLabel / errorRate / fmtPct", () => {
  assert.equal(envBadgeLabel({ ...base, status: "canary", canaryPct: 10 }), "canary 10%");
  assert.equal(envBadgeLabel(base), "active");
  assert.equal(errorRate({ Terminal: 0, Failed: 0, AvgCost: 0 }), null);
  assert.equal(fmtPct(errorRate({ Terminal: 4, Failed: 1, AvgCost: 0 })), "25.0%");
  assert.equal(fmtPct(null), "—");
});

test("proposedBy flags agents", () => {
  assert.match(proposedBy({ requestedBy: "bot", requestedByKind: "agent" }), /proposed by an agent/);
  assert.equal(proposedBy({ requestedBy: "ann", requestedByKind: "human" }), "proposed by ann");
});

test("gatesFailed", () => {
  assert.equal(gatesFailed(null).length, 0);
  assert.deepEqual(
    gatesFailed([{ name: "a", status: "pass" }, { name: "b", status: "fail" }]).map((g) => g.name),
    ["b"],
  );
});

test("parseApiError", () => {
  const g = parseApiError(new Error('API 422: {"code":"gate_failed","error":"nope","gates":[{"name":"x","status":"fail"}]}'));
  assert.equal(g.status, 422);
  assert.equal(g.code, "gate_failed");
  assert.equal(g.message, "nope");
  assert.equal(g.gates?.length, 1);
  const h = parseApiError(new Error('API 403: {"code":"human_approval_required"}'));
  assert.equal(h.code, "human_approval_required");
  assert.deepEqual(parseApiError(new Error("API 500: boom")), { status: 500, message: "boom" });
  assert.equal(parseApiError("weird").status, 0);
});

test("validatePromote", () => {
  assert.equal(validatePromote({ env: "staging", canaryPct: "abc" }), null);
  assert.equal(validatePromote({ env: "prod", canaryPct: "" }), null);
  assert.equal(validatePromote({ env: "prod", canaryPct: "10" }), null);
  assert.ok(validatePromote({ env: "prod", canaryPct: "0" }));
  assert.ok(validatePromote({ env: "prod", canaryPct: "1.5" }));
});

test("summarizeDetail renders audit objects as text, never as an object child", () => {
  const out = summarizeDetail({ reason: "x", version: "v2", gates: [1, 2], empty: "", nested: { a: 1 } });
  assert.equal(out, "reason: x · version: v2 · gates: 2 items · nested: …");
  assert.equal(summarizeDetail(null), "");
});
