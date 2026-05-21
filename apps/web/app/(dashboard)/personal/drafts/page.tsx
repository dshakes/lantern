"use client";

// /personal/drafts — pending VIP drafts awaiting approve / edit /
// discard. The dashboard is where these get resolved; the bridge
// queues them when an inbound from a VIP arrives.
//
// UX rules:
//   - Show inbound + draft side-by-side so the user can compare tone.
//   - One-tap approve is the dominant action — large, primary button.
//   - Edit-in-place: clicking the draft body switches to a textarea
//     with the same content + Save/Cancel.
//   - History tab so the user can see what was sent vs discarded.
//   - Auto-refresh every 6s while pending tab is open (no WS yet —
//     drafts are low-frequency enough that polling is fine).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Check,
  Clock,
  Crown,
  Edit3,
  FileText,
  Inbox,
  MessageCircle,
  RefreshCw,
  Send,
  Smartphone,
  Trash2,
  X,
} from "lucide-react";

import {
  actOnDraft,
  listDrafts,
  prettyJid,
  type Draft,
} from "@/lib/whatsapp-personal-client";
import { useToast } from "@/components/toast";

type StatusTab = "pending" | "approved" | "edited" | "discarded";
type ChannelFilter = "all" | "whatsapp" | "imessage";

const TABS: { id: StatusTab; label: string }[] = [
  { id: "pending", label: "Pending" },
  { id: "approved", label: "Sent" },
  { id: "edited", label: "Edited" },
  { id: "discarded", label: "Discarded" },
];

export default function DraftsPage() {
  const [tab, setTab] = useState<StatusTab>("pending");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const toast = useToast();
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const { drafts } = await listDrafts(tab);
        setDrafts(drafts);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load drafts");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [tab],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll only while the Pending tab is open — minimizes load and the
  // user only cares about live updates when they're actively triaging.
  useEffect(() => {
    if (tab !== "pending") {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
      return;
    }
    pollTimer.current = setInterval(() => refresh(true), 6000);
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
      pollTimer.current = null;
    };
  }, [tab, refresh]);

  const handleAction = async (
    id: string,
    action: "approve" | "edit" | "discard",
    finalText?: string,
  ) => {
    try {
      const result = await actOnDraft(id, action, finalText);
      if (result.sendError) {
        toast.warning(`Resolved, but bridge send failed: ${result.sendError}`);
      } else {
        const verb =
          action === "approve" ? "Sent" : action === "edit" ? "Sent (edited)" : "Discarded";
        toast.success(verb);
      }
      await refresh(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Action failed");
    }
  };

  const filtered = useMemo(
    () =>
      channelFilter === "all"
        ? drafts
        : drafts.filter((d) => d.channel === channelFilter),
    [drafts, channelFilter],
  );
  const pendingCount = useMemo(() => (tab === "pending" ? filtered.length : null), [tab, filtered.length]);
  const totalByChannel = useMemo(() => {
    let wa = 0, im = 0;
    for (const d of drafts) {
      if (d.channel === "whatsapp") wa++;
      else if (d.channel === "imessage") im++;
    }
    return { wa, im };
  }, [drafts]);

  return (
    <div className="space-y-6">
      <Intro pendingCount={pendingCount} />

      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
        <div className="flex items-center justify-between border-b border-zinc-800/60 px-4">
          <nav className="flex items-center gap-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`-mb-px flex items-center gap-2 border-b-2 px-3 py-3 text-sm transition-colors ${
                  tab === t.id
                    ? "border-violet-500 text-zinc-50"
                    : "border-transparent text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => refresh()}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="m-4 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {drafts.length > 0 && (
          <div className="flex items-center gap-1 border-b border-zinc-800/60 px-4 py-2">
            <span className="mr-1 text-[10px] uppercase tracking-wide text-zinc-500">channel</span>
            <FilterChip active={channelFilter === "all"} onClick={() => setChannelFilter("all")}>
              all <span className="text-zinc-500">({drafts.length})</span>
            </FilterChip>
            {totalByChannel.wa > 0 && (
              <FilterChip
                active={channelFilter === "whatsapp"}
                onClick={() => setChannelFilter("whatsapp")}
                tone="emerald"
              >
                WhatsApp <span className="text-zinc-500">({totalByChannel.wa})</span>
              </FilterChip>
            )}
            {totalByChannel.im > 0 && (
              <FilterChip
                active={channelFilter === "imessage"}
                onClick={() => setChannelFilter("imessage")}
                tone="blue"
              >
                iMessage <span className="text-zinc-500">({totalByChannel.im})</span>
              </FilterChip>
            )}
          </div>
        )}

        {loading ? (
          <SkeletonCards />
        ) : filtered.length === 0 ? (
          <EmptyState tab={tab} />
        ) : (
          <ul className="divide-y divide-zinc-800/60">
            {filtered.map((d) => (
              <DraftCard
                key={d.id}
                draft={d}
                onApprove={() => handleAction(d.id, "approve")}
                onEdit={(text) => handleAction(d.id, "edit", text)}
                onDiscard={() => handleAction(d.id, "discard")}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  tone = "violet",
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "violet" | "emerald" | "blue";
  children: React.ReactNode;
}) {
  const activeColors = {
    violet: "border-violet-500/30 bg-violet-500/15 text-violet-200",
    emerald: "border-emerald-500/30 bg-emerald-500/15 text-emerald-200",
    blue: "border-blue-500/30 bg-blue-500/15 text-blue-200",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border px-2 py-0.5 text-xs transition-colors ${
        active ? activeColors : "border-zinc-800 text-zinc-400 hover:text-zinc-200"
      }`}
    >
      {children}
    </button>
  );
}

// -------------------------------------------------------------- intro

function Intro({ pendingCount }: { pendingCount: number | null }) {
  return (
    <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-300">
            <Crown className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg font-medium text-zinc-50">
              Drafts awaiting your call
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              When a{" "}
              <Link href="/personal/vip" className="text-violet-300 underline">
                VIP contact
              </Link>{" "}
              messages you, the assistant drafts a reply in your style but doesn't send. Approve as-is, edit, or discard.
            </p>
          </div>
        </div>
        {pendingCount !== null && pendingCount > 0 && (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300">
            {pendingCount} pending
          </span>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------- DraftCard

function DraftCard({
  draft,
  onApprove,
  onEdit,
  onDiscard,
}: {
  draft: Draft;
  onApprove: () => void;
  onEdit: (text: string) => void;
  onDiscard: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(draft.draftText);
  const [busy, setBusy] = useState<"approve" | "edit" | "discard" | null>(null);

  const isPending = draft.status === "pending";
  const senderLabel = draft.displayName || prettyJid(draft.jid);

  const handleApprove = async () => {
    setBusy("approve");
    try { await onApprove(); } finally { setBusy(null); }
  };
  const handleEdit = async () => {
    setBusy("edit");
    try { await onEdit(editText.trim()); setEditing(false); } finally { setBusy(null); }
  };
  const handleDiscard = async () => {
    setBusy("discard");
    try { await onDiscard(); } finally { setBusy(null); }
  };

  return (
    <li className="px-5 py-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Crown className="h-3.5 w-3.5 text-amber-300" />
            <span className="text-sm font-medium text-zinc-100">{senderLabel}</span>
            <ChannelBadge channel={draft.channel} />
            {senderLabel !== prettyJid(draft.jid) && (
              <span className="font-mono text-[10px] text-zinc-600">
                {prettyJid(draft.jid)}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 text-[10px] uppercase tracking-wide text-zinc-500">
              <Clock className="h-3 w-3" />
              {timeAgo(draft.createdAt)}
            </span>
          </div>

          {/* Inbound */}
          <div className="mt-3 rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
              <Inbox className="h-3 w-3" />
              They wrote
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-300">
              {draft.inboundText || <em className="text-zinc-600">(empty)</em>}
            </p>
          </div>

          {/* Draft / Edit */}
          <div className="mt-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.03] p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-violet-300">
                <FileText className="h-3 w-3" />
                Assistant draft
              </div>
              {isPending && !editing && (
                <button
                  type="button"
                  onClick={() => { setEditText(draft.draftText); setEditing(true); }}
                  className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200"
                >
                  <Edit3 className="h-3 w-3" /> Edit
                </button>
              )}
            </div>
            {editing ? (
              <div className="mt-2">
                <textarea
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={Math.min(8, Math.max(3, editText.split("\n").length))}
                  className="w-full rounded-md border border-violet-500/40 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-violet-500 focus:outline-none"
                />
                <div className="mt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setEditing(false); setEditText(draft.draftText); }}
                    className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleEdit}
                    disabled={busy === "edit" || !editText.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-500 px-3 py-1 text-xs font-medium text-white hover:bg-violet-400 disabled:opacity-50"
                  >
                    <Send className="h-3 w-3" />
                    {busy === "edit" ? "Sending…" : "Send edited"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-100">
                {draft.status === "approved" || draft.status === "edited"
                  ? draft.finalText || draft.draftText
                  : draft.draftText}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Actions row — only on pending */}
      {isPending && !editing && (
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDiscard}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {busy === "discard" ? "Discarding…" : "Discard"}
          </button>
          <button
            type="button"
            onClick={handleApprove}
            disabled={!!busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-emerald-400 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {busy === "approve" ? "Sending…" : "Approve & Send"}
          </button>
        </div>
      )}

      {!isPending && (
        <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-zinc-500">
          <ResolvedBadge status={draft.status} />
        </div>
      )}
    </li>
  );
}

// Small chip showing which channel queued the draft so the user knows
// where the approved reply will go out. Emerald = WhatsApp, blue =
// iMessage (matches the channel-switcher color palette).
function ChannelBadge({ channel }: { channel: Draft["channel"] }) {
  const isWA = channel === "whatsapp";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
        isWA
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
          : "border-blue-500/30 bg-blue-500/10 text-blue-300"
      }`}
      title={isWA ? "queued from WhatsApp" : "queued from iMessage"}
    >
      {isWA ? <MessageCircle className="h-2.5 w-2.5" /> : <Smartphone className="h-2.5 w-2.5" />}
      {isWA ? "WhatsApp" : "iMessage"}
    </span>
  );
}

function ResolvedBadge({ status }: { status: Draft["status"] }) {
  switch (status) {
    case "approved":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
          <Check className="h-3 w-3" /> sent
        </span>
      );
    case "edited":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-300">
          <Edit3 className="h-3 w-3" /> sent (edited)
        </span>
      );
    case "discarded":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800/40 px-2 py-0.5 text-zinc-400">
          <X className="h-3 w-3" /> discarded
        </span>
      );
    default:
      return null;
  }
}

// ----------------------------------------------------------- empty state

function EmptyState({ tab }: { tab: StatusTab }) {
  const all: Record<StatusTab, { title: string; hint: string }> = {
    pending: {
      title: "No drafts to review",
      hint: "When a VIP contact messages you, the assistant's draft will appear here for your call.",
    },
    approved: {
      title: "Nothing sent yet",
      hint: "Drafts you approve land here.",
    },
    edited: {
      title: "Nothing edited yet",
      hint: "Drafts you tweak before sending land here.",
    },
    discarded: {
      title: "Nothing discarded yet",
      hint: "Drafts you decided not to send land here.",
    },
  };
  const copy = all[tab];
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Inbox className="h-6 w-6 text-zinc-600" />
      <div className="mt-3 text-sm text-zinc-300">{copy.title}</div>
      <p className="mt-1 max-w-md text-xs text-zinc-500">{copy.hint}</p>
      {tab === "pending" && (
        <Link
          href="/personal/vip"
          className="mt-4 inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          Manage VIPs
        </Link>
      )}
    </div>
  );
}

function SkeletonCards() {
  return (
    <ul className="divide-y divide-zinc-800/60">
      {[0, 1].map((i) => (
        <li key={i} className="px-5 py-5">
          <div className="space-y-3">
            <div className="h-3 w-32 animate-pulse rounded bg-zinc-800" />
            <div className="h-16 animate-pulse rounded-lg bg-zinc-800/60" />
            <div className="h-20 animate-pulse rounded-lg bg-zinc-800/50" />
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- helpers

function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
