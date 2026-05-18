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

// Client-side fallback: same template metadata the backend's
// handlers/templates.go ships. Used when the API is unreachable so the
// tiles always render. The descriptions / cron / budget here MUST stay
// in sync with the backend — the backend is the source of truth at
// apply-time but the UI needs SOMETHING to show offline.
const FALLBACK_TEMPLATES: Template[] = [
  {
    id: "inbox-concierge",
    name: "inbox-concierge",
    description:
      "Reads your Gmail every morning and texts a 3-bucket summary to your WhatsApp. Reply to it to draft, archive, snooze — all from your phone.",
    model: "auto",
    cronExpr: "0 8 * * *",
    maxCostUsdDay: 1.0,
    maxCostUsdPerRun: 0.1,
    connectors: ["gmail"],
    surfaces: ["whatsapp"],
  },
  {
    id: "morning-brief",
    name: "morning-brief",
    description:
      "Texts you 3 bullets every weekday at 8am about what needs your attention across GitHub PRs/issues and Linear tickets.",
    model: "auto",
    cronExpr: "0 8 * * 1-5",
    maxCostUsdDay: 1.0,
    maxCostUsdPerRun: 0.05,
    connectors: ["github", "linear"],
    surfaces: ["whatsapp"],
  },
];

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
      // If the API returned templates, use them. Otherwise fall back to
      // the hardcoded client-side list so the tiles ALWAYS render — the
      // user can still browse + read descriptions even when offline.
      setTemplates(t && t.length > 0 ? t : FALLBACK_TEMPLATES);
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

  // While templates haven't loaded yet, show the fallback tiles in a
  // dimmed state — better than a blank section. Once the API responds
  // we swap in the live data.
  const tiles = templates ?? FALLBACK_TEMPLATES;

  const apply = async (t: Template) => {
    setApplying(t.id);
    try {
      const res = await api.createAgentFromTemplate(t.id);
      toast.success(`Created "${res.agent.name}" — finish setup`);
      // Land on the inline setup gate. It renders the live checklist
      // (required connectors + surfaces) and gates Run until everything
      // is green. Replaces the old /channels destination which buried the
      // checklist behind a tab.
      router.push(`/agents/${encodeURIComponent(res.agent.name)}/setup`);
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
        <h2 className="text-sm font-semibold text-zinc-100">
          One-click recipes
        </h2>
        <span className="text-[11px] text-zinc-500">
          · agent + schedule + budget, configured atomically
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {tiles.map((t) => {
          const visual = TEMPLATE_VISUALS[t.id] ?? {
            icon: Sparkles,
            tint: "text-lantern-300",
            bg: "bg-lantern-500/10",
          };
          const Icon = visual.icon;
          return (
            <article
              key={t.id}
              className="group flex flex-col rounded-xl border border-zinc-800 bg-surface-1 p-5 transition-all duration-150 hover:border-lantern-500/40 hover:shadow-md"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className={clsx("flex h-10 w-10 items-center justify-center rounded-xl", visual.bg)}>
                  <Icon className={clsx("h-5 w-5", visual.tint)} />
                </div>
                <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-zinc-400">
                  {t.cronExpr}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-zinc-100">{t.name}</h3>
              <p className="mt-1 flex-1 text-[11px] leading-relaxed text-zinc-500">
                {t.description}
              </p>

              {/* Required connectors with live install state. */}
              <div className="mt-4 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-zinc-600">needs:</span>
                {t.connectors.map((c) => {
                  const ok = installed.has(c);
                  return (
                    <span
                      key={c}
                      className={clsx(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
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
                    className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-zinc-400"
                  >
                    {s}
                  </span>
                ))}
              </div>

              <button
                onClick={() => apply(t)}
                disabled={!!applying}
                className="mt-4 inline-flex items-center justify-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-2 text-xs font-medium text-white shadow-sm transition-all duration-150 hover:bg-lantern-400 hover:shadow-md disabled:opacity-50"
              >
                {applying === t.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    Use this recipe
                    <ChevronRight className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5" />
                  </>
                )}
              </button>
              <p className="mt-2 text-[11px] text-zinc-600">
                creates the agent + ${t.maxCostUsdDay.toFixed(2)}/day hard-cap budget + the cron
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
