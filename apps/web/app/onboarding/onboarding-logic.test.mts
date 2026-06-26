import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideProviderSave,
  decideAgentCreate,
  decideRunDisplay,
  isTerminalRunStatus,
  errorMessage,
} from "./onboarding-logic.ts";

// ---------------------------------------------------------------------------
// The whole point of this suite: a FAILED call must never look like success.
// ---------------------------------------------------------------------------

test("decideProviderSave: thrown save is a real error, never ok", () => {
  const out = decideProviderSave(new Error("API 401: unauthorized"), null);
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /401/);
});

test("decideProviderSave: save ok but test returned success:false surfaces the error", () => {
  const out = decideProviderSave(null, { success: false, error: "invalid_api_key" });
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /invalid_api_key/);
});

test("decideProviderSave: save ok but test never ran is NOT success", () => {
  const out = decideProviderSave(null, null);
  assert.equal(out.ok, false);
});

test("decideProviderSave: save ok + test success is the ONLY ok path", () => {
  const out = decideProviderSave(null, { success: true });
  assert.deepEqual(out, { ok: true });
});

test("decideAgentCreate: a thrown create does NOT advance / show success", () => {
  const out = decideAgentCreate(new Error("API 500: boom"));
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /500/);
});

test("decideAgentCreate: only a non-throwing create is ok", () => {
  assert.deepEqual(decideAgentCreate(null), { ok: true });
});

test("decideRunDisplay: a thrown create/poll is rendered as a real failure, not success", () => {
  const out = decideRunDisplay(null, new Error("API 402: budget exceeded"));
  assert.equal(out.kind, "failed");
  assert.match((out as { error: string }).error, /402/);
});

test("decideRunDisplay: a failed run renders the run error, never success", () => {
  const out = decideRunDisplay(
    { id: "r1", status: "failed", error: { message: "tool crashed" } },
    null,
  );
  assert.equal(out.kind, "failed");
  assert.match((out as { error: string }).error, /tool crashed/);
});

test("decideRunDisplay: a non-terminal run is pending, not success", () => {
  assert.equal(decideRunDisplay({ id: "r1", status: "running" }, null).kind, "pending");
});

test("decideRunDisplay: only a succeeded run shows the output", () => {
  const out = decideRunDisplay({ id: "r1", status: "succeeded", output: { ok: 1 } }, null);
  assert.equal(out.kind, "succeeded");
  assert.deepEqual((out as { output: unknown }).output, { ok: 1 });
});

test("isTerminalRunStatus", () => {
  assert.equal(isTerminalRunStatus("succeeded"), true);
  assert.equal(isTerminalRunStatus("failed"), true);
  assert.equal(isTerminalRunStatus("cancelled"), true);
  assert.equal(isTerminalRunStatus("running"), false);
  assert.equal(isTerminalRunStatus("queued"), false);
});

test("errorMessage falls back when there is no usable message", () => {
  assert.equal(errorMessage(new Error(""), "fallback"), "fallback");
  assert.equal(errorMessage(null, "fallback"), "fallback");
  assert.equal(errorMessage("boom", "fallback"), "boom");
});
