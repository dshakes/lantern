"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, ArrowUpRight, ExternalLink, Info } from "lucide-react";
import { api } from "@/lib/api";
import {
  billingBanner,
  formatPlanPrice,
  hasOpenSubscription,
  limitLines,
  planAction,
  type BillingOverview,
  type BillingPlan,
} from "@/lib/billing";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { useToast } from "@/components/settings/toast";

const SALES_EMAIL = "sales@pal.dev";

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // request() throws `API <status>: <body>`; surface the server's error text.
  const body = raw.replace(/^API \d+:\s*/, "");
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return body || "Something went wrong";
}

/**
 * Settings → Billing: plan cards, subscription state, and dunning notice,
 * backed by GET /v1/billing. Checkout and plan changes happen on Stripe's
 * hosted pages; this component only redirects there.
 */
export function BillingPlans() {
  const { toast } = useToast();
  const [overview, setOverview] = useState<BillingOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setOverview(await api.getBilling());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // One-shot notice for the Stripe Checkout return (?checkout=success|cancel).
  // The param is stripped so a reload (or React's dev double-effect) never
  // repeats it.
  useEffect(() => {
    const url = new URL(window.location.href);
    const checkout = url.searchParams.get("checkout");
    if (!checkout) return;
    url.searchParams.delete("checkout");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (checkout === "success") toast("success", "Subscription started. Your new limits apply as soon as Stripe confirms payment.");
    if (checkout === "cancel") toast("error", "Checkout canceled. No changes were made.");
  }, [toast]);

  const redirect = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      window.location.href = await fn();
    } catch (err) {
      toast("error", errorMessage(err));
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-44 rounded-xl" />
        ))}
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5 text-sm text-zinc-400">
        Billing information is unavailable right now. Check that the control plane is reachable and reload.
      </div>
    );
  }

  const { account, plans, enabled } = overview;
  const banner = billingBanner(account, plans);
  const current = plans.find((p) => p.id === account.effectivePlanId);

  return (
    <div className="space-y-4">
      {!enabled && (
        <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-surface-2 px-4 py-3 text-xs text-zinc-400">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Payments are not configured on this deployment, so plans are shown for reference only. Limits are managed under Budgets.</span>
        </div>
      )}

      {banner && (
        <div
          role="status"
          className={clsx(
            "flex items-start gap-2 rounded-lg border px-4 py-3 text-sm",
            banner.tone === "error" && "border-red-500/30 bg-red-500/10 text-red-300",
            banner.tone === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-300",
            banner.tone === "info" && "border-zinc-700 bg-surface-2 text-zinc-300",
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{banner.message}</span>
          {enabled && account.hasCustomer && banner.tone !== "info" && (
            <Button size="sm" variant="secondary" loading={busy === "portal"} onClick={() => redirect("portal", () => api.openBillingPortal())}>
              Update payment
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-zinc-400">
          Current plan: <span className="font-medium text-zinc-100">{current?.name ?? account.effectivePlanId}</span>
          {account.currentPeriodEnd && hasOpenSubscription(account.status) && (
            <span className="text-zinc-500"> · renews {new Date(account.currentPeriodEnd).toLocaleDateString()}</span>
          )}
        </p>
        {enabled && account.hasCustomer && (
          <Button
            size="sm"
            variant="ghost"
            icon={<ExternalLink className="h-3 w-3" />}
            loading={busy === "portal"}
            onClick={() => redirect("portal", () => api.openBillingPortal())}
          >
            Manage billing
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            overview={overview}
            busy={busy}
            onCheckout={() => redirect(plan.id, () => api.startCheckout(plan.id))}
            onPortal={() => redirect("portal", () => api.openBillingPortal())}
          />
        ))}
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  overview,
  busy,
  onCheckout,
  onPortal,
}: {
  plan: BillingPlan;
  overview: BillingOverview;
  busy: string | null;
  onCheckout: () => void;
  onPortal: () => void;
}) {
  const action = planAction(plan, overview);
  const isCurrent = action.kind === "current";
  return (
    <div className={clsx("flex flex-col rounded-xl border p-5", isCurrent ? "border-pal-500 bg-pal-500/5" : "border-zinc-800 bg-surface-1")}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-zinc-100">{plan.name}</p>
          <p className="mt-0.5 text-lg font-bold text-pal-400">{formatPlanPrice(plan)}</p>
        </div>
        {isCurrent && <span className="rounded-full bg-pal-500/10 px-2 py-0.5 text-xs font-medium text-pal-400">Current</span>}
      </div>
      {plan.description && <p className="mt-2 text-xs text-zinc-400">{plan.description}</p>}
      <ul className="mt-3 flex-1 space-y-1">
        {[...limitLines(plan.limits), ...plan.features].map((f) => (
          <li key={f} className="text-xs text-zinc-500">{f}</li>
        ))}
      </ul>
      <div className="mt-4">
        {action.kind === "checkout" && (
          <Button size="md" variant="primary" className="w-full" icon={<ArrowUpRight className="h-3 w-3" />} loading={busy === plan.id} disabled={busy !== null} onClick={onCheckout}>
            Choose {plan.name}
          </Button>
        )}
        {action.kind === "portal" && (
          <Button size="md" variant="secondary" className="w-full" loading={busy === "portal"} disabled={busy !== null} onClick={onPortal}>
            Switch in billing portal
          </Button>
        )}
        {action.kind === "contact" && (
          <a
            href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent(`PAL ${plan.name}`)}`}
            className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-700 px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-surface-3"
          >
            Contact sales
          </a>
        )}
        {action.kind === "unavailable" && <p className="text-center text-[12px] text-zinc-600">{action.reason}</p>}
      </div>
    </div>
  );
}
