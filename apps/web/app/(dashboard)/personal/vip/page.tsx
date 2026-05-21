"use client";

// /personal/vip — VIP contacts management. VIPs are contacts where
// auto-reply is OFF: the assistant drafts but pushes to the dashboard
// for one-tap approval instead of sending. Use this for people where
// the cost of a wrong tone (boss, parents, top customers) outweighs
// the convenience of auto-reply.

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { ArrowRight, Crown, Plus, Star, Trash2, UserCheck } from "lucide-react";

import {
  addVIP,
  listVIPs,
  prettyJid,
  removeVIP,
  type VIPEntry,
} from "@/lib/whatsapp-personal-client";
import { useToast } from "@/components/toast";

export default function VIPPage() {
  const [vips, setVips] = useState<VIPEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newJid, setNewJid] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [removingJid, setRemovingJid] = useState<string | null>(null);

  const toast = useToast();

  const refresh = useCallback(async () => {
    try {
      const { vips } = await listVIPs();
      setVips(vips);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load VIPs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const jid = normalizeJid(newJid.trim());
    if (!jid) {
      toast.error("Enter a phone number or full JID");
      return;
    }
    setAdding(true);
    try {
      await addVIP(jid, newName.trim() || undefined);
      setNewJid("");
      setNewName("");
      toast.success("VIP added");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Add failed");
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (jid: string) => {
    setRemovingJid(jid);
    try {
      await removeVIP(jid);
      toast.success("VIP removed");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Remove failed");
    } finally {
      setRemovingJid(null);
    }
  };

  return (
    <div className="space-y-6">
      <Intro />

      <AddVIPForm
        jid={newJid}
        name={newName}
        onJidChange={setNewJid}
        onNameChange={setNewName}
        onSubmit={handleAdd}
        adding={adding}
      />

      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
        <div className="flex items-center justify-between border-b border-zinc-800/60 p-4">
          <div>
            <h2 className="text-sm font-medium text-zinc-100">
              {loading ? "Loading…" : `${vips.length} VIP${vips.length === 1 ? "" : "s"}`}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Auto-reply is suppressed for these contacts. Drafts go to{" "}
              <Link href="/personal/drafts" className="text-violet-300 underline">
                Drafts
              </Link>{" "}
              for approval.
            </p>
          </div>
        </div>

        {error && (
          <div className="m-4 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {loading ? (
          <SkeletonRows />
        ) : vips.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {vips.map((v) => (
              <li
                key={v.jid}
                className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-zinc-900/40"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
                  <Crown className="h-4 w-4 text-amber-300" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100">
                    {v.displayName || prettyJid(v.jid)}
                  </div>
                  {v.displayName && (
                    <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
                      {prettyJid(v.jid)}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => handleRemove(v.jid)}
                  disabled={removingJid === v.jid}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <HowItWorks />
    </div>
  );
}

// -------------------------------------------------------------------- intro

function Intro() {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-300">
          <Crown className="h-6 w-6" />
        </div>
        <div>
          <h2 className="text-lg font-medium text-zinc-50">VIP contacts</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            The assistant <strong className="text-zinc-200">never auto-sends</strong> for these contacts. Drafts queue for your one-tap approval. Use this for people where a wrong-tone reply is unacceptable: your boss, partner, parents, top customers, lawyer.
          </p>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- add form

function AddVIPForm({
  jid,
  name,
  onJidChange,
  onNameChange,
  onSubmit,
  adding,
}: {
  jid: string;
  name: string;
  onJidChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  adding: boolean;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-5"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Phone / handle
          </label>
          <input
            type="text"
            value={jid}
            onChange={(e) => onJidChange(e.target.value)}
            placeholder="+15551234567 or jid@s.whatsapp.net"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wide text-zinc-500">
            Label (optional)
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Mom, Boss, Important Client"
            className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
          />
        </div>
        <div className="flex items-end">
          <button
            type="submit"
            disabled={adding || !jid.trim()}
            className="w-full rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-400 disabled:opacity-50 md:w-auto"
          >
            <Plus className="mr-1 inline h-4 w-4" />
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Plain phone numbers (with country code) are normalized to the WhatsApp JID format automatically.
      </p>
    </form>
  );
}

// --------------------------------------------------------------------- empty

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Star className="h-6 w-6 text-zinc-600" />
      <div className="mt-3 text-sm text-zinc-300">No VIPs yet</div>
      <p className="mt-1 max-w-md text-xs text-zinc-500">
        Add contacts above. Once a contact is VIP, the assistant queues drafts for your approval instead of auto-sending.
      </p>
    </div>
  );
}

function SkeletonRows() {
  return (
    <ul className="divide-y divide-zinc-800/60">
      {[0, 1, 2].map((i) => (
        <li key={i} className="flex items-center gap-4 px-4 py-3">
          <div className="h-9 w-9 animate-pulse rounded-lg bg-zinc-800" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-32 animate-pulse rounded bg-zinc-800" />
            <div className="h-2.5 w-24 animate-pulse rounded bg-zinc-800/60" />
          </div>
          <div className="h-7 w-20 animate-pulse rounded bg-zinc-800" />
        </li>
      ))}
    </ul>
  );
}

// ----------------------------------------------------------- how-it-works

function HowItWorks() {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-center gap-2">
        <UserCheck className="h-4 w-4 text-violet-300" />
        <h3 className="text-sm font-medium text-zinc-100">How VIP mode works</h3>
      </div>
      <ol className="mt-4 space-y-3 text-sm text-zinc-400">
        <Step n={1}>VIP messages you on WhatsApp.</Step>
        <Step n={2}>Assistant drafts a reply in your style (using context, calendar, contact facts) — but does NOT send it.</Step>
        <Step n={3}>The draft lands on the{" "}
          <Link href="/personal/drafts" className="text-violet-300 underline">
            Drafts
          </Link>{" "}
          page with the inbound for context.
        </Step>
        <Step n={4}>You hit <strong className="text-zinc-200">Approve</strong> (sends as-is), <strong className="text-zinc-200">Edit</strong> (tweak then send), or <strong className="text-zinc-200">Discard</strong> (you'll reply manually). Approved drafts send via the bridge with the same natural pacing as auto-replies.</Step>
      </ol>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-700 text-[10px] text-zinc-400">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

// ---------------------------------------------------------------- helpers

// Normalize "+1 555 123 4567" or "5551234567" to "15551234567@s.whatsapp.net".
// Pass-through if already a JID. Returns "" if input is unusable.
function normalizeJid(input: string): string {
  if (!input) return "";
  if (input.includes("@")) return input;
  const digits = input.replace(/[^\d]/g, "");
  if (!digits) return "";
  return `${digits}@s.whatsapp.net`;
}
