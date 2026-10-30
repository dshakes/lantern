// Billing view-model (ADR 0049). Pure: no React, no fetch — unit-tested in
// billing.test.mts. The server is the source of truth for plans, prices and
// subscription state; this file only decides what the Billing tab shows.

export interface BillingPlanLimits {
  maxCostUsdPerDay: number | null;
  budgetHardFail: boolean;
  maxConcurrentVMs: number | null;
  maxComputeHoursPerDay: number | null;
  maxEgressGBPerDay: number | null;
  runtimeMaxCostUsdPerDay: number | null;
}

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  monthlyPriceCents: number | null;
  selfServe: boolean;
  features: string[];
  limits: BillingPlanLimits;
  purchasable: boolean;
}

export type SubscriptionStatus =
  | "none"
  | "active"
  | "trialing"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export interface BillingAccount {
  planId: string;
  effectivePlanId: string;
  status: SubscriptionStatus;
  currentPeriodEnd?: string;
  paymentFailedAt?: string;
  graceUntil?: string;
  downgradedAt?: string;
  hasCustomer: boolean;
}

export interface BillingOverview {
  enabled: boolean;
  plans: BillingPlan[];
  account: BillingAccount;
}

export function formatPlanPrice(plan: Pick<BillingPlan, "monthlyPriceCents">): string {
  const c = plan.monthlyPriceCents;
  if (c === null || c === undefined) return "Custom";
  if (c === 0) return "$0/mo";
  const dollars = c / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}/mo`;
}

/** A subscription Stripe still considers open (portal, not checkout). */
export function hasOpenSubscription(status: SubscriptionStatus): boolean {
  return status === "active" || status === "trialing" || status === "past_due" || status === "unpaid";
}

export type PlanAction =
  | { kind: "current" }
  | { kind: "checkout" }
  | { kind: "portal" }
  | { kind: "contact" }
  | { kind: "unavailable"; reason: string };

/** What the button on a plan card does. */
export function planAction(plan: BillingPlan, overview: BillingOverview): PlanAction {
  const { account, enabled } = overview;
  if (plan.id === account.effectivePlanId) return { kind: "current" };
  if (!plan.selfServe) return { kind: "contact" };
  if (!enabled) return { kind: "unavailable", reason: "Billing is not configured on this deployment" };
  if (hasOpenSubscription(account.status)) return { kind: "portal" };
  if (!plan.purchasable) return { kind: "unavailable", reason: "Not available for self-serve checkout" };
  return { kind: "checkout" };
}

export interface BillingBanner {
  tone: "warning" | "error" | "info";
  message: string;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** Dunning / cancellation notice for the top of the Billing tab, if any. */
export function billingBanner(account: BillingAccount, plans: BillingPlan[], now: Date = new Date()): BillingBanner | null {
  const paidName = plans.find((p) => p.id === account.planId)?.name ?? account.planId;
  if (account.status === "canceled") {
    return {
      tone: "info",
      message: `Your ${paidName} subscription was canceled, so Free limits apply. Your agents, runs and data are untouched.`,
    };
  }
  const downgraded = account.effectivePlanId === "free" && account.planId !== "free";
  if (downgraded && (account.downgradedAt || account.graceUntil)) {
    return {
      tone: "error",
      message: `Payment is overdue, so this workspace is on Free limits. Nothing was deleted. Update your payment method to restore ${paidName}.`,
    };
  }
  if (account.graceUntil && new Date(account.graceUntil) > now) {
    return {
      tone: "warning",
      message: `Your last payment failed. Update your payment method by ${shortDate(account.graceUntil)} to keep ${paidName} limits.`,
    };
  }
  return null;
}

/** Human-readable limit lines for a plan card. */
export function limitLines(l: BillingPlanLimits): string[] {
  const out: string[] = [];
  out.push(l.maxCostUsdPerDay === null ? "No daily model-spend cap" : `$${l.maxCostUsdPerDay}/day model spend`);
  if (l.maxConcurrentVMs !== null) {
    out.push(`${l.maxConcurrentVMs} concurrent sandbox${l.maxConcurrentVMs === 1 ? "" : "es"}`);
  } else {
    out.push("Custom sandbox capacity");
  }
  return out;
}
