"use client";

// /personal/activity — live activity feed. Mirrors what's coming over
// the bridge WS so the user can debug "did the assistant actually do
// anything when I wasn't looking" in real time.

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Eye,
  EyeOff,
  Filter,
  MessageSquare,
  Pause,
  Play,
  Zap,
} from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";
import type { ActivityEvent, ActivityKind } from "@/lib/bridge-types";

const FILTERS: { id: "all" | ActivityKind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "message_in", label: "Incoming" },
  { id: "agent_reply", label: "Replies" },
  { id: "attention_dm", label: "Alerts" },
  { id: "monitor_on", label: "Monitor" },
  { id: "system", label: "System" },
];

export default function ActivityPage() {
  const { state, activity } = useBridge();
  const [filter, setFilter] = useState<"all" | ActivityKind>("all");

  const filtered = useMemo(() => {
    if (filter === "all") return activity;
    return activity.filter((e) => e.kind === filter);
  }, [activity, filter]);

  const offline = state !== "connected" && state !== "reconnecting";

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
        <h2 className="text-lg font-medium text-zinc-50">Live activity</h2>
        <p className="mt-1 max-w-2xl text-sm text-zinc-400">
          Every incoming DM, every reply your assistant sends, every monitor toggle. Real-time, capped at the last 200 events.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Filter className="h-3.5 w-3.5 text-zinc-500" />
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2 py-1 text-xs transition-colors ${
                filter === f.id
                  ? "bg-violet-500/15 text-violet-200 border border-violet-500/30"
                  : "border border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
        {offline ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-400">
            <AlertCircle className="h-6 w-6 text-zinc-600" />
            <div className="mt-3 text-zinc-300">Bridge isn&apos;t live</div>
            <p className="mt-1 max-w-md text-xs text-zinc-500">
              The activity feed populates while the bridge is connected.{" "}
              <Link href="/personal/setup" className="underline">
                Pair to start
              </Link>
              .
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-400">
            <MessageSquare className="h-6 w-6 text-zinc-600" />
            <div className="mt-3 text-zinc-300">
              {filter === "all"
                ? "Nothing yet"
                : "No matching events"}
            </div>
            <p className="mt-1 max-w-md text-xs text-zinc-500">
              {filter === "all"
                ? "When the bridge sees a message or fires a reply, it'll show up here."
                : "Try a different filter."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {filtered.map((e) => (
              <FeedRow key={e.id} event={e} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FeedRow({ event }: { event: ActivityEvent }) {
  const { Icon, tone, label } = describe(event.kind);
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border ${tone}`}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <div className="truncate text-sm text-zinc-100">
            {event.summary}
          </div>
          <time className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-zinc-600">
            {hhmm(event.timestamp)}
          </time>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
          <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono">
            {label}
          </span>
          {event.pushName && <span>{event.pushName}</span>}
          {event.jid && (
            <span className="truncate font-mono text-zinc-600">
              {event.jid}
            </span>
          )}
        </div>
        {event.detail && (
          <div className="mt-1 line-clamp-3 text-xs text-zinc-400">
            {event.detail}
          </div>
        )}
      </div>
    </li>
  );
}

function describe(kind: ActivityKind): {
  Icon: React.ComponentType<{ className?: string }>;
  tone: string;
  label: string;
} {
  switch (kind) {
    case "message_in":
      return {
        Icon: ArrowDownToLine,
        tone: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
        label: "in",
      };
    case "agent_reply":
      return {
        Icon: ArrowUpFromLine,
        tone: "border-violet-500/30 bg-violet-500/10 text-violet-300",
        label: "reply",
      };
    case "attention_dm":
      return {
        Icon: AlertCircle,
        tone: "border-amber-500/40 bg-amber-500/10 text-amber-300",
        label: "alert",
      };
    case "monitor_on":
      return {
        Icon: Eye,
        tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
        label: "monitor",
      };
    case "monitor_off":
      return {
        Icon: EyeOff,
        tone: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
        label: "monitor",
      };
    case "bot_on":
      return {
        Icon: Zap,
        tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
        label: "bot",
      };
    case "bot_off":
      return {
        Icon: Pause,
        tone: "border-amber-500/30 bg-amber-500/10 text-amber-300",
        label: "bot",
      };
    case "contact_paused":
      return {
        Icon: Pause,
        tone: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
        label: "pause",
      };
    case "contact_resumed":
      return {
        Icon: Play,
        tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
        label: "resume",
      };
    case "agent_skipped":
      return {
        Icon: EyeOff,
        tone: "border-zinc-700 bg-zinc-800/60 text-zinc-500",
        label: "skip",
      };
    case "system":
    default:
      return {
        Icon: MessageSquare,
        tone: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
        label: "sys",
      };
  }
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
