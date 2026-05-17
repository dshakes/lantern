"use client";

// AgentAvatar — deterministic colored initials avatar used wherever an
// agent shows up in a list (Inbox, Agents, Runs, Marketplace, etc.).
// Same agent name always lands on the same color across the dashboard
// so the eye learns "the violet one = research-agent" quickly.
//
// Why deterministic over random: stable visual identity across reloads
// + zero coupling to a persisted color field on the agent record.

import clsx from "clsx";
import type { RunStatus } from "@/lib/mock-data";

// Curated palette — eight accents that read well on dark surfaces and
// distinguish from each other at a glance. Stays in sync with the
// design tokens (uses Tailwind opacity-modified palette colors).
const AVATAR_PALETTE = [
  { bg: "bg-violet-500/15", text: "text-violet-300", ring: "ring-violet-500/30" },
  { bg: "bg-sky-500/15", text: "text-sky-300", ring: "ring-sky-500/30" },
  { bg: "bg-emerald-500/15", text: "text-emerald-300", ring: "ring-emerald-500/30" },
  { bg: "bg-amber-500/15", text: "text-amber-300", ring: "ring-amber-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-300", ring: "ring-rose-500/30" },
  { bg: "bg-cyan-500/15", text: "text-cyan-300", ring: "ring-cyan-500/30" },
  { bg: "bg-fuchsia-500/15", text: "text-fuchsia-300", ring: "ring-fuchsia-500/30" },
  { bg: "bg-lime-500/15", text: "text-lime-300", ring: "ring-lime-500/30" },
] as const;

export function colorForAgentName(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

export function initialsForAgent(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

type Size = "sm" | "md" | "lg";

const SIZE_CLS: Record<Size, string> = {
  sm: "h-7 w-7 text-(--text-xs)",
  md: "h-8 w-8 text-(--text-xs)",
  lg: "h-10 w-10 text-(--text-sm)",
};

const DOT_CLS: Record<Size, string> = {
  sm: "h-2 w-2 -bottom-0 -right-0",
  md: "h-2.5 w-2.5 -bottom-0.5 -right-0.5",
  lg: "h-3 w-3 -bottom-0.5 -right-0.5",
};

interface AgentAvatarProps {
  name: string;
  // Optional run status — renders a tiny dot in the corner.
  status?: RunStatus;
  size?: Size;
  // When true, dims to 40% — used when the row is grouped with the
  // previous one of the same agent to make bursts read as clusters.
  dimmed?: boolean;
  className?: string;
}

export function AgentAvatar({
  name,
  status,
  size = "md",
  dimmed,
  className,
}: AgentAvatarProps) {
  const palette = colorForAgentName(name);
  return (
    <div className={clsx("relative shrink-0", className)}>
      <div
        className={clsx(
          "flex items-center justify-center rounded-(--radius-md) font-semibold ring-1 transition-opacity duration-(--motion-fast)",
          SIZE_CLS[size],
          palette.bg,
          palette.text,
          palette.ring,
          dimmed && "opacity-40"
        )}
        aria-hidden
      >
        {initialsForAgent(name)}
      </div>
      {status && (
        <span
          className={clsx(
            "absolute rounded-full ring-2 ring-surface-1",
            DOT_CLS[size],
            status === "succeeded" && "bg-emerald-400",
            status === "failed" && "bg-red-400",
            (status === "running" || status === "paused") && "bg-lantern-400 animate-pulse",
            (status === "queued" || status === "cancelled") && "bg-zinc-500"
          )}
          aria-label={`status: ${status}`}
        />
      )}
    </div>
  );
}
