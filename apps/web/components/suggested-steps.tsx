"use client";

// AI-suggested next steps. Asks the control-plane LLM (model "auto") for 1-3
// steps grounded in the page + compact workspace facts the caller passes;
// every href is validated against the route allowlist. Always renders the
// caller's deterministic fallback first, then swaps in the model's picks —
// no provider / any error → the fallback simply stays. Cached per session.

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useModels } from "@/lib/model-context";
import { SUGGEST_SYSTEM_PROMPT, parseSuggestions, type SuggestedStep } from "@/lib/assistant";

export function SuggestedSteps({
  page, facts, fallback, title = "Suggested next steps",
}: {
  page: string;
  /** Compact, real facts, e.g. ["0 agents", "no provider key"]. */
  facts: string[];
  fallback: SuggestedStep[];
  title?: string;
}) {
  const { isConfigured, loading } = useModels();
  const [aiSteps, setSteps] = useState<SuggestedStep[]>([]);
  const [ai, setAi] = useState(false);
  const factKey = `pal-suggest:${page}:${facts.join("|")}`;

  useEffect(() => {
    if (loading || !isConfigured) return;
    let cancelled = false;
    try {
      const hit = sessionStorage.getItem(factKey);
      if (hit) {
        const parsed = JSON.parse(hit) as SuggestedStep[];
        setSteps(parsed);
        setAi(true);
        return;
      }
    } catch {
      /* ignore */
    }
    void api
      .assistJSON(SUGGEST_SYSTEM_PROMPT, `Page: ${page}\nWorkspace facts:\n- ${facts.join("\n- ")}`, { maxTokens: 250 })
      .then((raw) => {
        const parsed = raw ? parseSuggestions(raw) : null;
        if (cancelled || !parsed) return;
        setSteps(parsed);
        setAi(true);
        try {
          sessionStorage.setItem(factKey, JSON.stringify(parsed));
        } catch {
          /* ignore */
        }
      });
    return () => {
      cancelled = true;
    };
    // factKey already encodes page + facts; arrays are new each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factKey, isConfigured, loading]);

  // The fallback is derived from live props, so it tracks state as it loads.
  const steps = ai ? aiSteps : fallback;
  if (steps.length === 0) return null;
  return (
    <section aria-label={title} className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
        <Sparkles className="h-3.5 w-3.5 text-pal-400" /> {title}
        {ai && <span className="ml-1 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">by PAL</span>}
      </h2>
      <ul className="mt-2.5 space-y-1">
        {steps.map((s) => (
          <li key={s.href + s.label}>
            <Link href={s.href} className="group flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs text-zinc-300 hover:bg-surface-3 hover:text-zinc-50">
              {s.label}
              <ArrowRight className="h-3 w-3 text-zinc-600 transition-transform group-hover:translate-x-0.5 group-hover:text-pal-400" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
