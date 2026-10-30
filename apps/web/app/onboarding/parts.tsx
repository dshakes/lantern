"use client";

// Presentational pieces of the agentic onboarding flow. No data fetching and
// no flow decisions here — page.tsx owns those (via onboarding-logic.ts).
//
// Styling is centralized in `ui` below and uses only theme tokens (zinc /
// surface / pal scales remap under light mode in globals.css), so the
// brand refresh can swap tokens without touching this file's markup.

import { forwardRef, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, Check, CircleSlash, XCircle } from "lucide-react";
import { Button } from "@/components/button";
import { STEPS, stepStatus, type FixSuggestion, type Step } from "./onboarding-logic";

export const ui = {
  panel: "rounded-xl border border-zinc-800 bg-surface-1",
  field:
    "w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-50 placeholder:text-zinc-600 outline-none focus:border-pal-500 focus:ring-1 focus:ring-pal-500/30",
  label: "mb-1.5 block text-xs font-medium text-zinc-300",
  muted: "text-sm text-zinc-400",
  mono: "font-mono text-xs",
  lit: "bg-pal-400",
  ok: "text-emerald-400",
  bad: "text-red-400",
  warn: "text-amber-400",
};

// ---- Progress rail ---------------------------------------------------------

/**
 * The progress rail: a vertical wick of the real steps. Lit up to the current
 * step; the current step's marker is the one bright point on the page.
 */
export function ProgressRail({ current, blocked }: { current: Step; blocked: boolean }) {
  const idx = STEPS.findIndex((s) => s.id === current);
  const pct = Math.round((idx / (STEPS.length - 1)) * 100);
  const cur = STEPS[idx];
  return (
    <>
      {/* Phone: one line + bar. */}
      <div className="lg:hidden">
        <p className="text-xs text-zinc-400">
          Step {idx + 1} of {STEPS.length}: <span className="text-zinc-50">{cur.label}</span>
        </p>
        <div className="mt-2 h-1 rounded-full bg-zinc-800" aria-hidden>
          <div
            className={clsx("h-1 rounded-full motion-safe:transition-[width] motion-safe:duration-500", blocked ? "bg-amber-400" : ui.lit)}
            style={{ width: `${Math.max(pct, 4)}%` }}
          />
        </div>
      </div>

      {/* Desktop: the full wick. */}
      <ol aria-label="Onboarding progress" className="relative hidden lg:block">
        <span aria-hidden className="absolute left-[11px] top-3 bottom-3 w-px bg-zinc-800" />
        <span
          aria-hidden
          className={clsx("absolute left-[11px] top-3 w-px motion-safe:transition-[height] motion-safe:duration-500", ui.lit)}
          style={{ height: `calc(${pct}% - ${pct === 100 ? 24 : 12}px)` }}
        />
        {STEPS.map((s) => {
          const st = stepStatus(s.id, current);
          const isBlocked = st === "current" && blocked;
          return (
            <li
              key={s.id}
              aria-current={st === "current" ? "step" : undefined}
              className="relative flex gap-3 pb-6 last:pb-0"
            >
              <span
                className={clsx(
                  "relative z-10 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                  st === "done" && "border-pal-400 bg-pal-400 text-on-flame",
                  st === "current" && !isBlocked && "border-pal-400 bg-surface-0 text-pal-300 ring-4 ring-pal-500/25",
                  isBlocked && "border-amber-400 bg-surface-0 text-amber-400 ring-4 ring-amber-400/15",
                  st === "todo" && "border-zinc-700 bg-surface-0 text-zinc-500",
                )}
              >
                {st === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : STEPS.indexOf(s) + 1}
              </span>
              <div className="min-w-0">
                <p className={clsx("text-sm", st === "todo" ? "text-zinc-500" : "text-zinc-50", st === "current" && "font-medium")}>
                  {s.label}
                  <span className="sr-only">{st === "done" ? " (done)" : st === "current" ? (isBlocked ? " (needs attention)" : " (current)") : ""}</span>
                </p>
                <p className="text-xs text-zinc-500">{s.hint}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}

// ---- Conversation ----------------------------------------------------------

export function AgentMessage({ children, busy, mark = "L" }: { children: ReactNode; busy?: boolean; mark?: string }) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-pal-400 text-xs font-bold text-on-flame"
      >
        {mark}
      </span>
      <div className="min-w-0 flex-1 space-y-3 pt-1 text-sm leading-relaxed text-zinc-200">
        <span className="sr-only">PAL guide:</span>
        {children}
        {busy && (
          <span className="inline-flex items-center gap-1" aria-label="Working">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-zinc-500 motion-safe:animate-pulse"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export function UserMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-3 px-4 py-2.5 text-sm text-zinc-50">
        <span className="sr-only">You:</span>
        {children}
      </div>
    </div>
  );
}

/** A step's interactive card. Focusable heading so step changes move focus. */
export const StepCard = forwardRef<HTMLHeadingElement, { title: string; children: ReactNode; className?: string }>(
  function StepCard({ title, children, className }, ref) {
    return (
      <section className={clsx(ui.panel, "ml-0 p-4 sm:ml-10 sm:p-5", className)} aria-label={title}>
        <h2 ref={ref} tabIndex={-1} className="mb-3 text-sm font-semibold text-zinc-50 outline-none">
          {title}
        </h2>
        {children}
      </section>
    );
  },
);

// ---- Failure with a one-click fix -----------------------------------------

export function FixCard({
  failure,
  onFix,
  secondary,
  busy,
}: {
  failure: Pick<FixSuggestion, "summary" | "detail"> & { fix: { label: string } };
  onFix: () => void;
  secondary?: ReactNode;
  busy?: boolean;
}) {
  return (
    <div role="alert" className="ml-0 rounded-xl border border-red-500/30 bg-red-500/10 p-4 sm:ml-10">
      <div className="flex items-start gap-2">
        <XCircle className={clsx("mt-0.5 h-4 w-4 shrink-0", ui.bad)} aria-hidden />
        <div className="min-w-0">
          <p className="text-sm text-zinc-50">{failure.summary}</p>
          {failure.detail && failure.detail !== failure.summary && (
            <p className="mt-1 break-words font-mono text-xs text-zinc-400">{failure.detail}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-6">
        <Button variant="primary" size="md" onClick={onFix} loading={busy}>
          {failure.fix.label}
        </Button>
        {secondary}
      </div>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "warn" | "off"; children: ReactNode }) {
  const Icon = tone === "ok" ? Check : tone === "warn" ? AlertTriangle : CircleSlash;
  return (
    <div
      className={clsx(
        "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm",
        tone === "ok" && "border-emerald-500/30 bg-emerald-500/10 text-zinc-50",
        tone === "warn" && "border-amber-500/30 bg-amber-500/10 text-zinc-50",
        tone === "off" && "border-zinc-700 bg-surface-2 text-zinc-300",
      )}
    >
      <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", tone === "ok" ? ui.ok : tone === "warn" ? ui.warn : "text-zinc-500")} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
