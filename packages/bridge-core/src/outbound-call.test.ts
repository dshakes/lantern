// Tests for the outbound-call cost forecast shown in the approval gate.
//
// These lock in that (a) every mode produces a positive estimate,
// (b) a conference (two legs) costs more than a single-leg call, and
// (c) the estimate is surfaced in the plan summary the owner approves.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  estimateCallCostUsd,
  planCall,
  type OutboundCallRequest,
} from "./outbound-call.ts";

test("estimateCallCostUsd is positive for every mode", () => {
  for (const mode of [
    "VOICEMAIL_DELIVERY",
    "AGENT_TASK",
    "CONFERENCE_BRIDGE",
  ] as const) {
    assert.ok(
      estimateCallCostUsd(mode) > 0,
      `${mode} should have a positive estimate`,
    );
  }
});

test("conference (two legs) costs more than a one-leg voicemail", () => {
  assert.ok(
    estimateCallCostUsd("CONFERENCE_BRIDGE") >
      estimateCallCostUsd("VOICEMAIL_DELIVERY"),
    "conference bridges two legs and should estimate higher",
  );
});

test("planCall attaches the estimate and surfaces it in the summary", () => {
  const req: OutboundCallRequest = {
    mode: "VOICEMAIL_DELIVERY",
    to: "+15125550000",
    from: "+15125551234",
    message: "happy birthday!",
    ownerInitiated: true,
  };
  const plan = planCall(req);
  assert.equal(
    plan.estimatedCostUsd,
    estimateCallCostUsd("VOICEMAIL_DELIVERY"),
  );
  assert.ok(
    plan.summary.includes("est. ~$"),
    "summary should show the cost preview",
  );
});
