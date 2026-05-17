"use client";

// OneClickTemplates — curated recipes that create an agent + budget +
// schedule atomically. The user picks a tile, the control-plane wires
// everything, and they land on the agent's Channels tab to plug in
// the tokens (which can't be auto-filled — they're personal credentials).
//
// Each tile up-front shows which connectors the template needs AND
// whether those are already installed at the tenant level. Connectors
// in Lantern are workspace-wide — install once, every agent can use
// them — so the tile reflects the user's real install state.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Inbox,
  Sun,
  Loader2,
  Check,
  Plus,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";
import { api } from "@/lib/api";
import { useToast } from "@/components/toast";

interface Template {
  id: string;
  name: string;
  description: string;
  model: string;
  cronExpr: string;
  maxCostUsdDay: number;
  maxCostUsdPerRun: number;
  connectors: string[];
  surfaces: string[];
}

// Per-template visual identity. Lookups, not a prop on the template
// itself — the template metadata stays pure data.
const TEMPLATE_VISUALS: Record<string, { icon: typeof Inbox; tint: string; bg: string }> = {
  "inbox-concierge": { icon: Inbox, tint: "text-amber-300", bg: "bg-amber-500/10" },
  "morning-brief": { icon: Sun, tint: "text-sky-300", bg: "bg-sky-500/10" },
};

export function OneClickTemplates() {
  const router = useRouter();
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [t, c] = await Promise.all([
        api.listAgentTemplates(),
        api.listConnectors().catch(() => [] as unknown[]),
      ]);
      if (cancelled) return;
      setTemplates(t);
      const ids = new Set<string>();
      for (const ci of c as Array<{ connectorId: string }>) {
        if (ci?.connectorId) ids.add(ci.connectorId);
      }
      setInstalled(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (templates === null) {
    return (
      <div className="rounded-(--radius-lg) border border-zinc-800 bg-surface-1 p-6">
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-zinc-500" />
      </div>
    );
  }
  if (templates.length === 0) return null;

  const apply = async (t: Template) => {
    setApplying(t.id);
    try {
      const res = await api.createAgentFromTemplate(t.id);
      toast.success(`Created "${res.agent.name}" — finish setup`);
      // Land on the agent's Channels tab so the user immediately sees
      // what to plug in next (Gmail token, WhatsApp pairing).
      router.push(`/agents/${encodeURIComponent(res.agent.name)}/channels`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to apply template";
      // Common case: name collision (409) — point the user to the
      // existing agent instead of failing silently.
      if (msg.includes("already exists")) {
        toast.error(`"${t.name}" already exists. Open it from the sidebar.`);
      } else {
        toast.error(msg);
      }
    } finally {
      setApplying(null);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-lantern-400" />
        <h2 className="text-(--text-base) font-semibold text-zinc-100">
          One-click recipes
        </h2>
        <span className="text-(--text-xs) text-zinc-500">
          · agent + schedule + budget, configured atomically
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => {
          const visual = TEMPLATE_VISUALS[t.id] ?? {
            icon: Sparkles,
            tint: "text-lantern-300",
            bg: "bg-lantern-500/10",
          };
          const Icon = visual.icon;
          return (
            <article
              key={t.id}
              className="group flex flex-col rounded-(--radius-lg) border border-zinc-800 bg-surface-1 p-5 transition-all duration-(--motion-fast) hover:border-lantern-500/40 hover:shadow-(--elev-2)"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", visual.bg)}>
                  <Icon className={clsx("h-5 w-5", visual.tint)} />
                </div>
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-(--text-xs) font-medium text-zinc-400">
                  {t.cronExpr}
                </span>
              </div>
              <h3 className="text-(--text-base) font-semibold text-zinc-100">{t.name}</h3>
              <p className="mt-1 flex-1 text-(--text-xs) leading-(--leading-relaxed) text-zinc-500">
                {t.description}
              </p>

              {/* Required connectors with live install state. */}
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="text-(--text-xs) text-zinc-600">needs:</span>
                {t.connectors.map((c) => {
                  const ok = installed.has(c);
                  return (
                    <span
                      key={c}
                      className={clsx(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-(--text-xs) font-medium",
                        ok
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                          : "border-zinc-700 bg-surface-2 text-zinc-400"
                      )}
                    >
                      {ok ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
                      {c}
                    </span>
                  );
                })}
                {t.surfaces.map((s) => (
                  <span
                    key={s}
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-surface-2 px-2 py-0.5 text-(--text-xs) font-medium text-zinc-400"
                  >
                    {s}
                  </span>
                ))}
              </div>

              <button
                onClick={() => apply(t)}
                disabled={!!applying}
                className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-(--radius-md) bg-lantern-500 px-3 py-2 text-(--text-sm) font-medium text-white shadow-(--elev-1) transition-all duration-(--motion-fast) hover:bg-lantern-400 hover:shadow-(--elev-2) disabled:opacity-50"
              >
                {applying === t.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    Use this recipe
                    <ChevronRight className="h-3.5 w-3.5 transition-transform duration-(--motion-fast) group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
              <p className="mt-2 text-(--text-xs) text-zinc-600">
                creates the agent + ${t.maxCostUsdDay.toFixed(2)}/day hard-cap budget + the cron
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
