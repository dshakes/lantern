"use client";

// AvailableConnectors — always-visible grid of the top connectors with
// live install status. Renders on /agents/create above the templates
// section so users can connect their tools BEFORE picking a recipe.
//
// "Connectors in Lantern are one-time per workspace" — this surface
// reinforces that model. Click an unconnected tile to jump to /connectors
// with that connector pre-selected.

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Mail,
  Github,
  MessageSquare,
  StickyNote,
  Calendar,
  HardDrive,
  CreditCard,
  Send,
  Layers,
  Check,
  Plus,
  Loader2,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";

interface ConnectorDef {
  id: string;
  label: string;
  description: string;
  icon: typeof Mail;
  tint: string;
  bg: string;
}

// Curated top 8 — the connectors most users will reach for. Order is
// the empirical "most-installed first" — Gmail and GitHub are by far
// the top two.
const CONNECTORS: ConnectorDef[] = [
  { id: "gmail", label: "Gmail", description: "Read + reply", icon: Mail, tint: "text-rose-300", bg: "bg-rose-500/10" },
  { id: "github", label: "GitHub", description: "Issues + PRs", icon: Github, tint: "text-zinc-200", bg: "bg-zinc-500/10" },
  { id: "slack", label: "Slack", description: "Channels + DMs", icon: MessageSquare, tint: "text-purple-300", bg: "bg-purple-500/10" },
  { id: "linear", label: "Linear", description: "Tickets", icon: Layers, tint: "text-sky-300", bg: "bg-sky-500/10" },
  { id: "notion", label: "Notion", description: "Docs + databases", icon: StickyNote, tint: "text-zinc-200", bg: "bg-zinc-500/10" },
  { id: "google-calendar", label: "Calendar", description: "Events + availability", icon: Calendar, tint: "text-emerald-300", bg: "bg-emerald-500/10" },
  { id: "google-drive", label: "Drive", description: "Files", icon: HardDrive, tint: "text-amber-300", bg: "bg-amber-500/10" },
  { id: "stripe", label: "Stripe", description: "Payments + customers", icon: CreditCard, tint: "text-violet-300", bg: "bg-violet-500/10" },
];

export function AvailableConnectors() {
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .listConnectors()
      .then((data) => {
        if (cancelled) return;
        const ids = new Set<string>();
        for (const ci of data as Array<{ connectorId: string }>) {
          if (ci?.connectorId) ids.add(ci.connectorId);
        }
        setInstalled(ids);
      })
      .catch(() => {
        /* offline — empty install set */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const installedCount = installed.size;

  return (
    <section className="mb-8">
      <header className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">
            Your connected tools
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Connect once at the workspace level. Every agent you create can use them.
          </p>
        </div>
        <Link
          href="/connectors"
          className="text-xs font-medium text-lantern-400 transition-colors hover:text-lantern-300"
        >
          See all 17 →
        </Link>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {CONNECTORS.map((c) => {
          const ok = installed.has(c.id);
          const Icon = c.icon;
          return (
            <Link
              key={c.id}
              href={ok ? "/connectors" : `/connectors?install=${encodeURIComponent(c.id)}`}
              className={clsx(
                "group relative flex flex-col items-start gap-2 rounded-xl border p-3 transition-all duration-150",
                ok
                  ? "border-emerald-500/30 bg-emerald-500/5 hover:bg-emerald-500/10"
                  : "border-zinc-800 bg-surface-1 hover:border-zinc-700 hover:bg-surface-2"
              )}
              title={ok ? `${c.label} connected — every agent can use it` : `Install ${c.label}`}
            >
              <div className={clsx("flex h-8 w-8 items-center justify-center rounded-lg", c.bg)}>
                <Icon className={clsx("h-4 w-4", c.tint)} />
              </div>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs font-medium text-zinc-100">
                  {c.label}
                  {loading ? (
                    <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
                  ) : ok ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Plus className="h-3 w-3 text-zinc-600 transition-colors group-hover:text-lantern-400" />
                  )}
                </p>
                <p className="truncate text-[11px] text-zinc-500">{c.description}</p>
              </div>
            </Link>
          );
        })}
      </div>

      {!loading && installedCount === 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          Tip: connect Gmail + GitHub now — that unlocks the one-click recipes below.
        </p>
      )}
    </section>
  );
}
