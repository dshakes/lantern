"use client";

// Shared visual primitives for the Runtime Command Center: state + isolation
// style maps, the inline SVG Sparkline, the state dot, and the isolation
// tier badge. Kept here so the page, fleet grid, and drawer stay consistent.

import clsx from "clsx";
import { Shield } from "lucide-react";
import type { VmState } from "@/lib/runtime-types";

// Palette discipline: neutral zinc everything + ONE accent (lantern). State
// reads as a small muted dot + neutral text — no saturated pills. Only two
// states carry a quiet hue: running (calm green) and failed (muted red);
// every other state is a neutral grey dot. The data is the hero.
export const STATE_STYLES: Record<VmState, { dot: string; text: string; label: string }> = {
  pending:    { dot: "bg-zinc-500",            text: "text-zinc-400", label: "Pending" },
  spawning:   { dot: "bg-zinc-400",            text: "text-zinc-300", label: "Spawning" },
  running:    { dot: "bg-emerald-500/80",      text: "text-zinc-200", label: "Running" },
  draining:   { dot: "bg-zinc-400",            text: "text-zinc-300", label: "Draining" },
  terminated: { dot: "bg-zinc-600",            text: "text-zinc-500", label: "Terminated" },
  failed:     { dot: "bg-red-500/70",          text: "text-zinc-300", label: "Failed" },
};

// Isolation tier → concrete sandbox backend. Quiet, low-contrast neutral text
// (no bright colored badges). The tier is metadata, not a focal point.
export const ISOLATION_STYLES: Record<string, { label: string; backend: string }> = {
  trusted:      { label: "runc",         backend: "K8s Job" },
  standard:     { label: "Firecracker",  backend: "microVM" },
  untrusted:    { label: "gVisor",       backend: "FC + egress" },
  hostile:      { label: "Kata",         backend: "full VM" },
  wasm:         { label: "Wasmtime",     backend: "wasm" },
  devcontainer: { label: "Devcontainer", backend: "pod + PVC" },
};

export function isolationStyle(cls: string) {
  return ISOLATION_STYLES[cls] || { label: cls, backend: "" };
}

const PULSING: VmState[] = ["spawning", "draining", "pending"];

export function StateDot({ state, className }: { state: VmState; className?: string }) {
  const ss = STATE_STYLES[state] ?? STATE_STYLES.pending;
  return (
    <span className={clsx("relative inline-flex h-1.5 w-1.5", className)}>
      <span className={clsx("relative inline-flex h-1.5 w-1.5 rounded-full", ss.dot, PULSING.includes(state) && "animate-pulse")} />
    </span>
  );
}

// Quiet state label: muted dot + neutral text. No pill fill or ring.
export function StatePill({ state }: { state: VmState }) {
  const ss = STATE_STYLES[state] ?? STATE_STYLES.pending;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 text-[12px] font-medium", ss.text)}>
      <StateDot state={state} />
      {ss.label}
    </span>
  );
}

// Isolation tier: a very subtle neutral chip — implicit, not a colored badge.
export function IsolationBadge({ cls, dense }: { cls: string; dense?: boolean }) {
  const is = isolationStyle(cls);
  return (
    <span
      title={`${cls} · ${is.backend}`}
      className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-medium text-zinc-400"
    >
      <Shield className={clsx("text-zinc-500", dense ? "h-2.5 w-2.5" : "h-3 w-3")} />
      {is.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — tiny SVG line over a 0..1 series. Smooth-updates because the
// parent swaps the `data` prop in place every tick.
// ---------------------------------------------------------------------------

export function Sparkline({
  data,
  color = "var(--color-accent)",
  width = 64,
  height = 20,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) {
    return <span className="font-mono text-[11px] text-zinc-600">—</span>;
  }
  const n = data.length;
  const stepX = width / (n - 1);
  const y = (v: number) => height - v * (height - 2) - 1;
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = "M" + pts.join(" L");
  const last = data[n - 1];
  // Monochrome + low-ink: a thin stroke and a single endpoint dot, no filled
  // area gradient. One ink colour per spark — calm, not instrument-panel.
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeOpacity="0.85"
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ transition: "d 0.4s ease" }}
      />
      <circle cx={width} cy={y(last)} r="1.4" fill={color} />
    </svg>
  );
}

// Tiny utilisation bar (used in the drawer metrics + capacity map cells).
// Calm fills: the accent for normal load, a muted red only at true saturation.
// Low/medium load reads neutral — we don't paint healthy capacity green.
export function UtilBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "warn" | "danger" | "ok" }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  const fill =
    tone === "danger" ? "bg-red-500/70" : tone === "warn" ? "bg-zinc-400" : tone === "ok" ? "bg-zinc-500" : "bg-lantern-400/80";
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={clsx("h-full rounded-full transition-all duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}
