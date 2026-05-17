"use client";

// /marketplace/invocations — W11c surface.
//
// Lists cross-tenant marketplace invocations for the current tenant
// (as buyer or seller). Each row shows the HMAC-signed receipt with a
// "Verify" link that drops into the public /proof page with the JSON
// pre-filled.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, Check, ShieldCheck, AlertTriangle, ExternalLink } from "lucide-react";
import clsx from "clsx";
import { PageHeader } from "@/components/page-header";
import { api } from "@/lib/api";

interface Invocation {
  id: string;
  buyerTenantId: string;
  sellerTenantId: string;
  marketplaceSlug: string;
  agentName: string;
  status: string;
  costUsd: number;
  signature: string;
  errorMessage: string;
  createdAt: string;
  completedAt: string;
  receipt?: Record<string, unknown>;
}

type Role = "buyer" | "seller";

export default function InvocationsPage() {
  const [role, setRole] = useState<Role>("buyer");
  const [invocations, setInvocations] = useState<Invocation[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInvocations(null);
    api.listMarketplaceInvocations(role).then((data) => {
      if (!cancelled) setInvocations(data as Invocation[]);
    });
    return () => {
      cancelled = true;
    };
  }, [role]);

  const totals = useMemo(() => {
    if (!invocations) return { count: 0, costUsd: 0, succeeded: 0 };
    return invocations.reduce(
      (acc, i) => ({
        count: acc.count + 1,
        costUsd: acc.costUsd + (i.costUsd || 0),
        succeeded: acc.succeeded + (i.status === "succeeded" ? 1 : 0),
      }),
      { count: 0, costUsd: 0, succeeded: 0 }
    );
  }, [invocations]);

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <PageHeader
        title="Marketplace invocations"
        description="Cross-tenant agent calls with HMAC-signed settlement. Every successful invocation produces a receipt verifiable at /proof."
      />

      <div className="space-y-5 p-8">
        {/* Role toggle */}
        <div className="flex items-center gap-2">
          <RolePill active={role === "buyer"} onClick={() => setRole("buyer")} label="As buyer" />
          <RolePill active={role === "seller"} onClick={() => setRole("seller")} label="As seller" />
        </div>

        {/* Totals strip */}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Invocations" value={String(totals.count)} />
          <Stat label="Succeeded" value={String(totals.succeeded)} />
          <Stat label="Total cost" value={totals.costUsd > 0 ? `$${totals.costUsd.toFixed(4)}` : "—"} />
        </div>

        {/* List */}
        {invocations === null ? (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-6 text-[12px] text-zinc-500">
            Loading…
          </div>
        ) : invocations.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-surface-1 p-8 text-center text-[12px] text-zinc-500">
            No {role}-side invocations yet. {role === "buyer"
              ? <>Discover agents in <Link href="/marketplace" className="text-lantern-400 hover:text-lantern-300">the marketplace</Link>.</>
              : "Publish an agent so others can invoke it."}
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
            {invocations.map((i) => (
              <InvocationRow key={i.id} inv={i} role={role} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RolePill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors",
        active
          ? "border-lantern-500/40 bg-lantern-500/10 text-lantern-200"
          : "border-zinc-800 bg-surface-1 text-zinc-400 hover:text-zinc-200"
      )}
    >
      {label}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-100">{value}</p>
    </div>
  );
}

function InvocationRow({ inv, role }: { inv: Invocation; role: Role }) {
  const ok = inv.status === "succeeded";
  const verifyHref = inv.receipt
    ? `/proof?prefill=${encodeURIComponent(JSON.stringify({
        payload: inv.receipt,
        signature: inv.signature,
        algorithm: "HMAC-SHA256",
      }))}`
    : "/proof";

  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {ok ? (
        <ShieldCheck className="h-4 w-4 text-emerald-400" />
      ) : (
        <AlertTriangle className="h-4 w-4 text-red-400" />
      )}
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] text-zinc-100">
          <Link href={`/marketplace/${inv.marketplaceSlug}`} className="font-semibold hover:text-lantern-300">
            {inv.marketplaceSlug}
          </Link>
          <span className="text-zinc-700">·</span>
          <span className="font-mono text-[11px] text-zinc-400">{inv.agentName}</span>
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-zinc-500">
          {role === "buyer" ? "from" : "to"}{" "}
          <code className="rounded bg-surface-3 px-1 text-zinc-400">
            {role === "buyer" ? inv.sellerTenantId.slice(0, 8) : inv.buyerTenantId.slice(0, 8)}…
          </code>
          <ArrowLeftRight className="h-3 w-3 text-zinc-700" />
          <span>{new Date(inv.createdAt).toLocaleString()}</span>
          {inv.errorMessage && (
            <span className="text-red-300">— {inv.errorMessage}</span>
          )}
        </p>
      </div>
      {inv.costUsd > 0 && (
        <span className="text-[12px] text-zinc-400 tabular-nums">
          ${inv.costUsd.toFixed(4)}
        </span>
      )}
      {inv.signature && (
        <Link
          href={verifyHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 transition-colors hover:bg-surface-3 hover:text-zinc-100"
          title="Verify the signed receipt"
        >
          <Check className="h-3 w-3 text-emerald-400" />
          Verify
          <ExternalLink className="h-2.5 w-2.5" />
        </Link>
      )}
      <span
        className={clsx(
          "rounded-full px-2 py-0.5 text-[10px] font-medium",
          ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300"
        )}
      >
        {inv.status}
      </span>
    </li>
  );
}
