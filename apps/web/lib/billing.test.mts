import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billingBanner,
  formatPlanPrice,
  limitLines,
  planAction,
  type BillingAccount,
  type BillingOverview,
  type BillingPlan,
} from "./billing.ts";

const limits = {
  maxCostUsdPerDay: 25,
  budgetHardFail: true,
  maxConcurrentVMs: 10,
  maxComputeHoursPerDay: 10,
  maxEgressGBPerDay: 5,
  runtimeMaxCostUsdPerDay: 10,
};

function plan(id: string, over: Partial<BillingPlan> = {}): BillingPlan {
  return { id, name: id[0].toUpperCase() + id.slice(1), description: "", monthlyPriceCents: 2900, selfServe: true, features: [], limits, purchasable: true, ...over };
}

const plans = [
  plan("free", { monthlyPriceCents: 0 }),
  plan("pro"),
  plan("enterprise", { monthlyPriceCents: null, selfServe: false, purchasable: false }),
];

function overview(account: Partial<BillingAccount>, enabled = true): BillingOverview {
  return { enabled, plans, account: { planId: "free", effectivePlanId: "free", status: "none", hasCustomer: false, ...account } };
}

test("formatPlanPrice", () => {
  assert.equal(formatPlanPrice({ monthlyPriceCents: null }), "Custom");
  assert.equal(formatPlanPrice({ monthlyPriceCents: 0 }), "$0/mo");
  assert.equal(formatPlanPrice({ monthlyPriceCents: 2900 }), "$29/mo");
  assert.equal(formatPlanPrice({ monthlyPriceCents: 1999 }), "$19.99/mo");
});

test("planAction: current plan is the EFFECTIVE plan", () => {
  // Downgraded by dunning: Free is current even though planId is pro.
  const o = overview({ planId: "pro", effectivePlanId: "free", status: "past_due" });
  assert.deepEqual(planAction(plans[0], o), { kind: "current" });
  assert.deepEqual(planAction(plans[1], o), { kind: "portal" });
});

test("planAction: checkout only without an open subscription", () => {
  assert.deepEqual(planAction(plans[1], overview({})), { kind: "checkout" });
  assert.deepEqual(planAction(plans[1], overview({ status: "canceled", planId: "pro" })), { kind: "checkout" });
  assert.deepEqual(planAction(plans[1], overview({ status: "active", planId: "team", effectivePlanId: "team" })), { kind: "portal" });
});

test("planAction: enterprise is contact sales; disabled billing is unavailable", () => {
  assert.deepEqual(planAction(plans[2], overview({})), { kind: "contact" });
  assert.equal(planAction(plans[1], overview({}, false)).kind, "unavailable");
  assert.equal(planAction(plan("team", { purchasable: false }), overview({})).kind, "unavailable");
});

test("billingBanner: grace, downgrade, cancel, healthy", () => {
  const now = new Date("2026-10-10T00:00:00Z");
  assert.equal(billingBanner(overview({ status: "active", planId: "pro", effectivePlanId: "pro" }).account, plans, now), null);
  const grace = billingBanner(
    overview({ status: "past_due", planId: "pro", effectivePlanId: "pro", graceUntil: "2026-10-15T00:00:00Z" }).account,
    plans,
    now,
  );
  assert.equal(grace?.tone, "warning");
  assert.match(grace!.message, /Oct 15, 2026/);
  assert.match(grace!.message, /Pro/);
  const down = billingBanner(
    overview({ status: "past_due", planId: "pro", effectivePlanId: "free", graceUntil: "2026-10-05T00:00:00Z", downgradedAt: "2026-10-06T00:00:00Z" }).account,
    plans,
    now,
  );
  assert.equal(down?.tone, "error");
  assert.match(down!.message, /Nothing was deleted/);
  const canceled = billingBanner(overview({ status: "canceled", planId: "pro", effectivePlanId: "free" }).account, plans, now);
  assert.equal(canceled?.tone, "info");
});

test("limitLines", () => {
  assert.deepEqual(limitLines(limits), ["$25/day model spend", "10 concurrent sandboxes"]);
  assert.deepEqual(limitLines({ ...limits, maxCostUsdPerDay: null, maxConcurrentVMs: null }), [
    "No daily model-spend cap",
    "Custom sandbox capacity",
  ]);
  assert.deepEqual(limitLines({ ...limits, maxConcurrentVMs: 1 }).at(1), "1 concurrent sandbox");
});
