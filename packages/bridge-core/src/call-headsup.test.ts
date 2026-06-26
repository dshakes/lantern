// Tests for the two answer-rate features on outbound calls:
//   1. caller-ID override — the recipient leg dials FROM the owner's own
//      verified number (deps.callerId), not the Twilio DID, so contacts
//      recognize the call.
//   2. heads-up SMS — a one-line text to the recipient before a conference
//      dial, sent FROM the Twilio DID, and best-effort (never blocks).

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { placeCallNow, type OrchestratorDeps } from "./call-orchestrator.ts";
import { planCall, type OutboundCallRequest } from "./outbound-call.ts";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} } as any;

function confReq(): OutboundCallRequest {
  return {
    mode: "CONFERENCE_BRIDGE",
    to: "+15125550000",
    from: "+15128819998", // Twilio DID
    contactName: "Mae Kumar",
    reason: "weekend plans",
    ownerInitiated: true,
    ownerPhone: "+15555550100",
  };
}

function makeDeps(overrides: Partial<OrchestratorDeps> = {}): { deps: OrchestratorDeps; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const deps: OrchestratorDeps = {
    logger: noopLogger,
    twilioFromNumber: "+15128819998",
    ownerPhone: "+15555550100",
    ownerName: "Ada",
    callerId: "+15555550100", // owner's verified cell
    smsHeadsUp: true,
    resolveContact: async () => null,
    notifyOwner: async () => {},
    authedFetch: (async (url: string, init: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({ data: { sid: "CA_test" } }), text: async () => "" };
    }) as any,
    ...overrides,
  };
  return { deps, calls };
}

test("recipient leg dials FROM the caller-ID override; SMS + owner leg use the Twilio DID", async () => {
  const req = confReq();
  const plan = planCall(req, {});
  const { deps, calls } = makeDeps();
  const res = await placeCallNow(req, plan, deps);
  assert.equal(res.ok, true);

  const sms = calls.find((c) => c.url.includes("send_sms"));
  const placeCall = calls.find((c) => c.url.includes("place_call"));
  const addPart = calls.find((c) => c.url.includes("add_conference_participant"));

  assert.ok(sms, "heads-up SMS should be sent");
  assert.equal(sms!.body.from, "+15128819998", "SMS must come from the Twilio DID");
  assert.equal(sms!.body.to, "+15125550000");
  assert.match(sms!.body.body, /Ada/, "SMS names the owner");

  assert.ok(placeCall, "recipient should be dialed");
  assert.equal(placeCall!.body.from, "+15555550100", "recipient leg uses the caller-ID override");

  assert.ok(addPart, "owner conference leg should be added");
  assert.equal(addPart!.body.from, "+15128819998", "owner leg uses the Twilio DID, not the override");
});

test("no callerId → recipient leg falls back to the Twilio DID", async () => {
  const req = confReq();
  const plan = planCall(req, {});
  const { deps, calls } = makeDeps({ callerId: undefined });
  await placeCallNow(req, plan, deps);
  const placeCall = calls.find((c) => c.url.includes("place_call"));
  assert.equal(placeCall!.body.from, "+15128819998");
});

test("smsHeadsUp=false → no SMS sent", async () => {
  const req = confReq();
  const plan = planCall(req, {});
  const { deps, calls } = makeDeps({ smsHeadsUp: false });
  await placeCallNow(req, plan, deps);
  assert.equal(calls.find((c) => c.url.includes("send_sms")), undefined);
});

test("SMS failure NEVER blocks the dial", async () => {
  const req = confReq();
  const plan = planCall(req, {});
  const calls: Array<{ url: string; body: any }> = [];
  const deps = makeDeps().deps;
  deps.authedFetch = (async (url: string, init: any) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    if (url.includes("send_sms")) return { ok: false, status: 500, text: async () => "carrier down" };
    return { ok: true, json: async () => ({ data: { sid: "CA_test" } }), text: async () => "" };
  }) as any;
  const res = await placeCallNow(req, plan, deps);
  assert.equal(res.ok, true, "call still placed despite SMS failure");
  assert.ok(calls.find((c) => c.url.includes("place_call")), "recipient still dialed");
});
