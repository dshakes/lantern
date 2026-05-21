"use client";

// /personal/contacts — list of contacts where the assistant is paused
// (because the user typed in the thread). Each row has its expiry +
// a "Resume now" action.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Clock, Play, UserMinus } from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";

export default function ContactsPage() {
  const { state, bot, busy, resumeContact, clearAllPauses } = useBridge();
  const [resumingJid, setResumingJid] = useState<string | null>(null);

  const offline = state !== "connected" && state !== "reconnecting";
  const pausedEntries = useMemo(() => {
    const obj = bot?.paused ?? {};
    return Object.entries(obj)
      .map(([jid, until]) => ({ jid, until: Number(until) }))
      .filter((e) => e.until > Date.now())
      .sort((a, b) => a.until - b.until);
  }, [bot?.paused]);

  if (offline) {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 text-sm text-amber-100">
        <h3 className="font-medium text-amber-100">Pair WhatsApp first</h3>
        <p className="mt-1 text-xs text-amber-200/80">
          The bridge needs to be paired to manage paused contacts.
        </p>
        <div className="mt-3">
          <Link
            href="/personal/setup"
            className="rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/30"
          >
            Open setup
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-zinc-50">Paused contacts</h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              When you type in a thread, the assistant steps aside for that contact for 60 minutes. Pauses listed here will auto-expire — or you can resume them now.
            </p>
          </div>
          {pausedEntries.length > 0 && (
            <button
              type="button"
              onClick={clearAllPauses}
              disabled={busy.clearingPauses}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy.clearingPauses ? "Resuming…" : "Resume all"}
            </button>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
        {pausedEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <UserMinus className="h-6 w-6 text-zinc-600" />
            <div className="mt-3 text-sm text-zinc-300">Nothing paused</div>
            <p className="mt-1 max-w-sm text-xs text-zinc-500">
              When you reply manually to a contact, that contact gets paused for 60 minutes and shows up here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {pausedEntries.map(({ jid, until }) => (
              <li
                key={jid}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-zinc-900/40"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
                  <UserMinus className="h-4 w-4 text-zinc-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-xs text-zinc-200">
                    {prettyJid(jid)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-zinc-500">
                    <Clock className="h-3 w-3" />
                    resumes in {timeUntil(until)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setResumingJid(jid);
                    try {
                      await resumeContact(jid);
                    } finally {
                      setResumingJid(null);
                    }
                  }}
                  disabled={resumingJid === jid}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Play className="h-3.5 w-3.5" />
                  Resume now
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function prettyJid(jid: string): string {
  // contact JIDs look like 15551234567@s.whatsapp.net — show the
  // user-readable phone number when possible.
  const at = jid.indexOf("@");
  if (at > 0) {
    const local = jid.slice(0, at);
    if (/^\d+$/.test(local)) return `+${local}`;
    return local;
  }
  return jid;
}

function timeUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}
