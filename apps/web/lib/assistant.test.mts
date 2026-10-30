import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAssistContext, isAllowedRoute, parseAssistAction, parseSuggestions, requiresConfirm,
  type AssistContext,
} from "./assistant.ts";

const ctx: AssistContext = {
  mode: "runtime",
  agentNames: ["triage", "digest"],
  runCountsByStatus: { failed: 1, succeeded: 4 },
  failedRuns: [{ id: "11111111-1111-1111-1111-111111111111", agentName: "triage" }],
  runningVms: [{ id: "vm-a", idleMinutes: 40 }, { id: "vm-b", idleMinutes: 1 }],
};

test("route allowlist rejects off-site and unknown routes", () => {
  assert.ok(isAllowedRoute("/runs?q=x"));
  assert.ok(isAllowedRoute("/agents/triage"));
  assert.ok(!isAllowedRoute("https://evil.example"));
  assert.ok(!isAllowedRoute("//evil.example"));
  assert.ok(!isAllowedRoute("/api/auth/session"));
  assert.ok(!isAllowedRoute("/runsx"));
});

test("navigate + answer parse, fenced JSON tolerated", () => {
  assert.deepEqual(parseAssistAction('```json\n{"kind":"navigate","path":"/runs","summary":"Open runs"}\n```', ctx),
    { kind: "navigate", path: "/runs", summary: "Open runs" });
  assert.equal(parseAssistAction('{"kind":"navigate","path":"/api/x"}', ctx), null);
  assert.equal(parseAssistAction('{"kind":"answer","answer":""}', ctx), null);
  assert.equal(parseAssistAction("not json", ctx), null);
});

test("ids must come from the context — the model cannot invent them", () => {
  const ok = parseAssistAction('{"kind":"explain_run","runId":"11111111-1111-1111-1111-111111111111"}', ctx);
  assert.equal(ok?.kind, "explain_run");
  assert.equal(parseAssistAction('{"kind":"explain_run","runId":"22222222-2222-2222-2222-222222222222"}', ctx), null);
  const vm = parseAssistAction('{"kind":"vm_action","op":"pause","vmIds":["vm-a","vm-a"]}', ctx);
  assert.deepEqual(vm && vm.kind === "vm_action" ? vm.vmIds : null, ["vm-a"]);
  assert.equal(parseAssistAction('{"kind":"vm_action","op":"pause","vmIds":["vm-zzz"]}', ctx), null);
  assert.equal(parseAssistAction('{"kind":"vm_action","op":"reboot","vmIds":["vm-a"]}', ctx), null);
  assert.equal(parseAssistAction('{"kind":"vm_action","op":"pause","vmIds":[]}', ctx), null);
});

test("mutations require confirmation; reads do not", () => {
  assert.equal(requiresConfirm({ kind: "create_agent", description: "triage GitHub issues", summary: "" }), true);
  assert.equal(requiresConfirm({ kind: "vm_action", op: "pause", vmIds: ["vm-a"], summary: "" }), true);
  assert.equal(requiresConfirm({ kind: "explain_run", runId: "x", summary: "" }), false);
  assert.equal(requiresConfirm({ kind: "navigate", path: "/runs", summary: "" }), false);
});

test("context is compact and carries the ids the model may use", () => {
  const s = formatAssistContext(ctx);
  assert.match(s, /vm-a \(idle 40m\)/);
  assert.match(s, /11111111-1111-1111-1111-111111111111 \(triage\)/);
  assert.ok(s.length < 2000);
});

test("suggestions are validated against the allowlist and capped", () => {
  const s = parseSuggestions('{"steps":[{"label":"Add a model key","href":"/settings?tab=providers"},{"label":"x","href":"https://evil"},{"label":"Review runs","href":"/runs"},{"label":"a","href":"/agents"},{"label":"b","href":"/budgets"}]}');
  assert.deepEqual(s?.map((x) => x.href), ["/settings?tab=providers", "/runs", "/agents"]);
  assert.equal(parseSuggestions('{"steps":[]}'), null);
});
