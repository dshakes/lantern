// Tests for executeOutboundCall's resolve-miss path: when a name can't be
// resolved to a phone, the failure reason must surface the resolver's
// "did you mean: …" candidates (when present) so the owner can re-try —
// instead of the bare generic hint. Regression for the wiring gap where
// lastSuggestions was read via (deps as any) but never passed by the bridge.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  executeOutboundCall,
  type OrchestratorDeps,
  type OutboundCallIntent,
} from "./call-orchestrator.ts";

const noopLogger = {
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
} as any;

function baseDeps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    logger: noopLogger,
    twilioFromNumber: "+15125550000",
    resolveContact: async () => null, // always a miss
    authedFetch: (async () => new Response("{}")) as any,
    notifyOwner: async () => {},
    ...over,
  };
}

const intent: OutboundCallIntent = { intent: "conference", target: "Madhu" };

test("resolve miss surfaces the resolver's suggestions in the reason", async () => {
  const deps = baseDeps({
    lastSuggestions: () => "did you mean:\n  • Madhu Mudarapu (cousin)",
  });
  const res = await executeOutboundCall(intent, deps, { ownerInitiated: true });
  assert.equal(res.ok, false);
  assert.match(res.reason || "", /couldn't resolve "Madhu" to a phone/);
  assert.match(res.reason || "", /did you mean:/);
  assert.match(res.reason || "", /Madhu Mudarapu/);
});

test("resolve miss with no suggestions falls back to the generic hint", async () => {
  const res = await executeOutboundCall(intent, baseDeps(), { ownerInitiated: true });
  assert.equal(res.ok, false);
  assert.match(res.reason || "", /try the full name, or paste a phone number directly/);
});

test("empty suggestion string still uses the generic hint", async () => {
  const deps = baseDeps({ lastSuggestions: () => "" });
  const res = await executeOutboundCall(intent, deps, { ownerInitiated: true });
  assert.equal(res.ok, false);
  assert.match(res.reason || "", /try the full name/);
});
