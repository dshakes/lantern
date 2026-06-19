"use client";

// Shared visual primitives for the Runtime Command Center: state + isolation
// style maps, the inline SVG Sparkline, the state dot, and the isolation
// tier badge. Kept here so the page, fleet grid, and drawer stay consistent.

import clsx from "clsx";
import { Shield } from "lucide-react";
import type { VmState } from "@/lib/runtime-types";

export const STATE_STYLES: Record<VmState, { dot: string; pill: string; text: string; label: string }> = {
  pending:    { dot: "bg-zinc-400",     pill: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/20",       text: "text-zinc-300",    label: "Pending" },
  spawning:   { dot: "bg-lantern-400",  pill: "bg-lantern-500/10 text-lantern-300 ring-lantern-500/20", text: "text-lantern-300", label: "Spawning" },
  running:    { dot: "bg-emerald-400",  pill: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20", text: "text-emerald-300", label: "Running" },
  draining:   { dot: "bg-amber-400",    pill: "bg-amber-500/10 text-amber-300 ring-amber-500/20",     text: "text-amber-300",   label: "Draining" },
  terminated: { dot: "bg-zinc-500",     pill: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",        text: "text-zinc-400",    label: "Terminated" },
  failed:     { dot: "bg-red-400",      pill: "bg-red-500/10 text-red-300 ring-red-500/20",           text: "text-red-300",     label: "Failed" },
};

// Isolation tier → concrete sandbox backend + colour. Maps the control-plane
// isolation classes to the big-tech runtime vocabulary (gVisor/Kata/runc/FC).
export const ISOLATION_STYLES: Record<string, { label: string; backend: string; cls: string }> = {
  trusted:      { label: "runc",        backend: "K8s Job",     cls: "bg-sky-500/10 text-sky-300 ring-sky-500/20" },
  standard:     { label: "Firecracker", backend: "microVM",     cls: "bg-violet-500/10 text-violet-300 ring-violet-500/20" },
  untrusted:    { label: "gVisor",      backend: "FC + egress", cls: "bg-amber-500/10 text-amber-300 ring-amber-500/20" },
  hostile:      { label: "Kata",        backend: "full VM",     cls: "bg-rose-500/10 text-rose-300 ring-rose-500/20" },
  wasm:         { label: "Wasmtime",    backend: "wasm",        cls: "bg-teal-500/10 text-teal-300 ring-teal-500/20" },
  devcontainer: { label: "Devcontainer", backend: "pod + PVC",  cls: "bg-cyan-500/10 text-cyan-300 ring-cyan-500/20" },
};

export function isolationStyle(cls: string) {
  return ISOLATION_STYLES[cls] || { label: cls, backend: "", cls: "bg-zinc-500/10 text-zinc-300 ring-zinc-500/20" };
}

const PULSING: VmState[] = ["spawning", "draining", "pending"];

export function StateDot({ state, className }: { state: VmState; className?: string }) {
  const ss = STATE_STYLES[state] ?? STATE_STYLES.pending;
  return (
    <span className={clsx("relative inline-flex h-2 w-2", className)}>
      {state === "running" && (
        <span className={clsx("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", ss.dot)} />
      )}
      <span className={clsx("relative inline-flex h-2 w-2 rounded-full", ss.dot, PULSING.includes(state) && "animate-pulse")} />
    </span>
  );
}

export function StatePill({ state }: { state: VmState }) {
  const ss = STATE_STYLES[state] ?? STATE_STYLES.pending;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", ss.pill)}>
      <StateDot state={state} />
      {ss.label}
    </span>
  );
}

export function IsolationBadge({ cls, dense }: { cls: string; dense?: boolean }) {
  const is = isolationStyle(cls);
  return (
    <span
      title={`${cls} · ${is.backend}`}
      className={clsx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ring-1 ring-inset",
        is.cls,
      )}
    >
      <Shield className={clsx(dense ? "h-2.5 w-2.5" : "h-3 w-3")} />
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
  const area = `${line} L${width.toFixed(1)},${height} L0,${height} Z`;
  const last = data[n - 1];
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ transition: "d 0.4s ease" }}
      />
      <circle cx={width} cy={y(last)} r="1.8" fill={color} />
    </svg>
  );
}

// Tiny utilisation bar (used in the drawer metrics + capacity map cells).
export function UtilBar({ value, tone = "accent" }: { value: number; tone?: "accent" | "warn" | "danger" | "ok" }) {
  const pct = Math.min(100, Math.max(0, value * 100));
  const fill =
    tone === "danger" ? "bg-red-400" : tone === "warn" ? "bg-amber-400" : tone === "ok" ? "bg-emerald-400" : "bg-lantern-400";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={clsx("h-full rounded-full transition-all duration-500", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}
