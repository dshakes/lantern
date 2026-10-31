import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffPolicy,
  emptyPolicy,
  formatConnectors,
  normalizePolicy,
  parseApiError,
  parseConnectors,
  parseLines,
  policiesEqual,
  type AgentPolicy,
} from "./agent-policy";

const base = (): AgentPolicy => ({
  ...emptyPolicy(),
  tools: ["web_search", "shell_exec"],
  connectors: { github: ["get_issue", "list_*"] },
  version: 4,
});

test("policiesEqual ignores version and ordering", () => {
  const a = base();
  const b = { ...base(), tools: ["shell_exec", "web_search"], version: 9 };
  b.connectors = { github: ["list_*", "get_issue"] };
  assert.equal(policiesEqual(a, b), true);
});

test("policiesEqual detects a differing entry, mode, and budget", () => {
  const a = base();
  assert.equal(policiesEqual(a, { ...a, tools: ["web_search"] }), false);
  assert.equal(policiesEqual(a, { ...a, mode: "legacy_permissive" }), false);
  assert.equal(policiesEqual(a, { ...a, budget: { ...a.budget, maxToolCallsPerRun: 5 } }), false);
});

test("policiesEqual treats missing collections as empty", () => {
  const sparse = { mode: "enforce", version: 1 } as unknown as AgentPolicy;
  assert.equal(policiesEqual(sparse, emptyPolicy()), true);
});

test("diffPolicy reports added and removed entries per field", () => {
  const cur = base();
  const next: AgentPolicy = {
    ...cur,
    tools: ["web_search", "http_fetch"],
    connectors: { github: ["get_issue"], slack: ["post_message"] },
    mode: "legacy_permissive",
    budget: { maxToolCallsPerRun: 50, maxA2AInboundPerMinute: 0 },
  };
  const d = Object.fromEntries(diffPolicy(cur, next).map((e) => [e.field, e]));
  assert.deepEqual(d.tools, { field: "tools", added: ["http_fetch"], removed: ["shell_exec"] });
  assert.deepEqual(d.connectors.added, ["slack → post_message"]);
  assert.deepEqual(d.connectors.removed, ["github → list_*"]);
  assert.deepEqual(d.mode.added, ["legacy_permissive"]);
  assert.deepEqual(d["budget.maxToolCallsPerRun"], {
    field: "budget.maxToolCallsPerRun",
    added: ["50"],
    removed: ["0"],
  });
});

test("diffPolicy is empty for identical policies", () => {
  assert.deepEqual(diffPolicy(base(), { ...base(), version: 99 }), []);
});

test("parseLines splits on newline/comma, trims, dedupes", () => {
  assert.deepEqual(parseLines(" a, b\n\nb\n c "), ["a", "b", "c"]);
});

test("parseConnectors round-trips and rejects malformed lines", () => {
  const ok = parseConnectors("github: list_*, get_issue\nslack: post_message");
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.value, { github: ["get_issue", "list_*"], slack: ["post_message"] });
    assert.equal(formatConnectors(ok.value), "github: get_issue, list_*\nslack: post_message");
  }
  assert.equal(parseConnectors("github").ok, false);
  assert.equal(parseConnectors("github:").ok, false);
});

test("parseApiError recovers status, code, field", () => {
  assert.deepEqual(parseApiError(new Error('API 409: {"code":"version_conflict"}')), {
    status: 409,
    code: "version_conflict",
    field: undefined,
    message: '{"code":"version_conflict"}',
  });
  const bad = parseApiError(new Error('API 400: {"error":"bad host","field":"egressHosts"}'));
  assert.equal(bad.field, "egressHosts");
  assert.equal(bad.message, "bad host");
  assert.equal(parseApiError(new Error("API 502: upstream down")).message, "upstream down");
  assert.equal(parseApiError(new Error("network")).status, null);
});

test("normalizePolicy fills nulls from the server", () => {
  const n = normalizePolicy({ mode: "enforce", tools: null, version: 2 } as unknown as AgentPolicy);
  assert.deepEqual(n.tools, []);
  assert.equal(n.version, 2);
});

// Regression: a type import added above "use client" in lib/api.ts made Next
// reject the module and 500 every dashboard page. The directive must lead.
test('lib/api.ts keeps "use client" as its first statement', async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(src, /^"use client";/);
});
