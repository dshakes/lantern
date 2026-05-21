"use client";

// /personal/auto-reply — the master switch + per-contact pause overview.
// "Should the assistant reply on my behalf? When is it allowed to?"

import { useMemo } from "react";
import Link from "next/link";
import { ArrowRight, BellOff, Pause, Play, ShieldCheck, Zap } from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";

export default function AutoReplyPage() {
  const { state, bot, busy, toggleMute, clearAllPauses } = useBridge();

  const offlineHint =
    state !== "connected" && state !== "reconnecting"
      ? "Pair your phone first — the master switch needs a live bridge."
      : null;

  const pausedCount = Object.keys(bot?.paused ?? {}).length;
  const muted = !!bot?.muted;

  return (
    <div className="space-y-6">
      {offlineHint && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200">
          {offlineHint}{" "}
          <Link href="/personal/setup" className="underline">
            Open setup
          </Link>
          .
        </div>
      )}

      <MasterSwitch
        muted={muted}
        disabled={!bot || busy.togglingMute || !!offlineHint}
        onToggle={toggleMute}
      />

      <PausedContactsCard
        count={pausedCount}
        disabled={busy.clearingPauses || pausedCount === 0}
        onClearAll={clearAllPauses}
      />

      <HowItWorksCard />
    </div>
  );
}

// -------------------------------------------------------------------- master switch

function MasterSwitch({
  muted,
  disabled,
  onToggle,
}: {
  muted: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800/80 bg-surface-1">
      <div className="flex items-start gap-5 p-6">
        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
            muted
              ? "bg-amber-500/15 text-amber-300"
              : "bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {muted ? <Pause className="h-6 w-6" /> : <Zap className="h-6 w-6" />}
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-medium text-zinc-50">
            {muted ? "Auto-reply is paused" : "Auto-reply is on"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            {muted
              ? "Your assistant won't respond to any DMs while paused. You'll still get incoming messages on your phone as usual."
              : "When someone DMs you and you don't respond within a couple minutes, the assistant takes over. If you start typing in that thread, it backs off."}
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={onToggle}
              disabled={disabled}
              className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium shadow-sm transition disabled:opacity-50 ${
                muted
                  ? "bg-emerald-500 text-white hover:bg-emerald-400"
                  : "border border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
              }`}
            >
              {muted ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {muted ? "Resume auto-reply" : "Pause auto-reply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- paused contacts card

function PausedContactsCard({
  count,
  disabled,
  onClearAll,
}: {
  count: number;
  disabled: boolean;
  onClearAll: () => void;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
      <div className="flex items-start justify-between border-b border-zinc-800/60 p-5">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">Paused contacts</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Contacts where you typed yourself — assistant steps aside for 60 minutes.
          </p>
        </div>
        <BellOff className="h-4 w-4 text-zinc-600" />
      </div>
      <div className="p-5">
        {count === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <span className="text-2xl font-medium text-zinc-300">0</span>
            <span className="mt-1 text-xs text-zinc-500">
              No contacts paused right now.
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <div className="text-2xl font-medium text-zinc-100">{count}</div>
              <div className="mt-1 text-xs text-zinc-500">
                {count === 1 ? "contact" : "contacts"} paused
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/personal/contacts"
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                View list <ArrowRight className="h-3 w-3" />
              </Link>
              <button
                type="button"
                onClick={onClearAll}
                disabled={disabled}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Resume all
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- how it works

function HowItWorksCard() {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-medium text-zinc-100">How auto-reply decides</h3>
      </div>
      <ol className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-2">
        <Rule
          n={1}
          title="Waits before replying"
          body="Gives you a chance to respond first. Assistant only steps in if you haven't typed in a couple minutes."
        />
        <Rule
          n={2}
          title="Backs off when you take over"
          body="The moment you send a message in a thread, the assistant pauses replies to that contact for an hour."
        />
        <Rule
          n={3}
          title="Skips groups by default"
          body="Group chats are silent unless you explicitly pick them on the Groups page."
        />
        <Rule
          n={4}
          title="Sends urgent stuff to you"
          body="If a message looks important (boss, family, time-sensitive), the assistant DMs you the alert instead of replying."
        />
      </ol>
    </div>
  );
}

function Rule({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-400">
          {n}
        </span>
        <div>
          <div className="text-xs font-medium text-zinc-100">{title}</div>
          <div className="mt-0.5 text-xs text-zinc-400">{body}</div>
        </div>
      </div>
    </div>
  );
}
