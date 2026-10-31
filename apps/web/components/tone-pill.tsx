import clsx from "clsx";
import type { Tone } from "@/lib/observability";

const TONE: Record<Tone, string> = {
  ok: "bg-emerald-500/10 text-emerald-400 ring-emerald-500/20",
  bad: "bg-red-500/10 text-red-400 ring-red-500/20",
  warn: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
  muted: "bg-surface-3 text-zinc-400 ring-zinc-700/40",
};

/** Small status pill; colour comes from the semantic tone, never the text alone. */
export function TonePill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={clsx("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", TONE[tone])}>
      {children}
    </span>
  );
}
