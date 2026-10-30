"use client";

// /brief — pal home: today's Brief.
//
// One ranked list of what needs the owner, with the acting buttons inline:
// approve / edit / discard a held reply, dismiss a suggestion, copy the chat
// command for a waiting thread (chat stays the acting surface for those).
// Ranking = deterministic base order + one control-plane LLM pass that may
// only reorder/annotate (lib/brief). Nothing here fabricates: every row is a
// real server record; a source that is down is named, not faked.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  AlertTriangle, ArrowRight, Check, Clock, Copy, Edit3, Inbox, Loader2, MessageCircle, RefreshCw, Smartphone,
  Sparkles, Trash2, X, Zap, CheckCircle2,
} from "lucide-react";
import { api, type Commitment, type LifeEvent } from "@/lib/api";
import { actOnDraft, listDrafts, type Draft } from "@/lib/whatsapp-personal-client";
import { fetchAttention, fetchHealth, type AttentionItem } from "@/lib/bridge-client";
import type { BridgeChannel } from "@/lib/bridge-types";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import { useToast } from "@/components/toast";
import { Button } from "@/components/button";
import { Skeleton } from "@/components/skeleton";
import { AskBar } from "@/components/ask-bar";
import { SuggestedSteps } from "@/components/suggested-steps";
import {
  RANK_SYSTEM_PROMPT, applyRank, buildBriefItems, buildRankPrompt, greeting, parseRank, rankCacheKey,
  type BriefItem,
} from "@/lib/brief";

const CHANNELS: BridgeChannel[] = ["whatsapp", "imessage"];
type ChannelHealth = Record<BridgeChannel, "online" | "offline" | "unknown">;

export default function BriefPage() {
  const { user } = useAuth();
  const { isConfigured } = useModels();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [events, setEvents] = useState<LifeEvent[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [threads, setThreads] = useState<Array<AttentionItem & { channel: BridgeChannel }>>([]);
  const [health, setHealth] = useState<ChannelHealth>({ whatsapp: "unknown", imessage: "unknown" });
  const [failed, setFailed] = useState<string[]>([]);
  const [ranked, setRanked] = useState<BriefItem[] | null>(null);
  const [ranking, setRanking] = useState(false);

  const load = useCallback(async () => {
    const down: string[] = [];
    const tenantId = user?.tenantId;
    const [d, e, c] = await Promise.all([
      listDrafts("pending").then((r) => r.drafts ?? []).catch(() => (down.push("held replies"), [] as Draft[])),
      api.listLifeEvents({ status: "suggested", limit: 30 }).catch(() => (down.push("automations"), [] as LifeEvent[])),
      api.listCommitments({ status: "open", limit: 30 }).catch(() => (down.push("commitments"), [] as Commitment[])),
    ]);
    const h: ChannelHealth = { whatsapp: "unknown", imessage: "unknown" };
    const t: Array<AttentionItem & { channel: BridgeChannel }> = [];
    await Promise.all(
      CHANNELS.map(async (ch) => {
        try {
          await fetchHealth(ch);
          h[ch] = "online";
          if (tenantId) {
            const snap = await fetchAttention(tenantId, ch).catch(() => null);
            for (const it of snap?.items ?? []) if (it.ref === "thread") t.push({ ...it, channel: ch });
          }
        } catch {
          h[ch] = "offline";
        }
      }),
    );
    setDrafts(d);
    setEvents(e);
    setCommitments(c);
    setThreads(t);
    setHealth(h);
    setFailed(down);
    setLoading(false);
  }, [user?.tenantId]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, [load]);

  const base = useMemo(
    () =>
      buildBriefItems({
        holds: drafts,
        lifeEvents: events,
        commitments,
        threads: threads.map((t) => ({ id: `${t.id}`, label: t.label, why: t.why, channel: t.channel })),
      }),
    [drafts, events, commitments, threads],
  );

  // AI rank: one call per distinct item set, cached for the session.
  useEffect(() => {
    if (!isConfigured || base.length < 2) {
      setRanked(null);
      return;
    }
    const key = rankCacheKey(base);
    try {
      const hit = sessionStorage.getItem(key);
      if (hit) {
        setRanked(applyRank(base, JSON.parse(hit)));
        return;
      }
    } catch {
      /* ignore */
    }
    let cancelled = false;
    setRanking(true);
    void api.assistJSON(RANK_SYSTEM_PROMPT, buildRankPrompt(base), { maxTokens: 500 }).then((raw) => {
      if (cancelled) return;
      const rank = raw ? parseRank(raw, base) : null;
      setRanked(rank ? applyRank(base, rank) : null);
      setRanking(false);
      if (rank) {
        try {
          sessionStorage.setItem(key, JSON.stringify(rank));
        } catch {
          /* ignore */
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [base, isConfigured]);

  // Ranked order, but always the CURRENT item set (resolved rows drop out).
  const items = useMemo(() => {
    if (!ranked) return base;
    const live = new Map(base.map((b) => [b.key, b]));
    const out: BriefItem[] = ranked.filter((r) => live.has(r.key)).map((r) => ({ ...live.get(r.key)!, why: r.why }));
    for (const b of base) if (!out.some((o) => o.key === b.key)) out.push(b);
    return out;
  }, [base, ranked]);

  const draftById = useMemo(() => new Map(drafts.map((d) => [d.id, d])), [drafts]);
  const threadByKey = useMemo(() => new Map(threads.map((t) => [`thread:${t.channel}:${t.id}`, t])), [threads]);

  const resolveDraft = async (d: Draft, action: "approve" | "edit" | "discard", text?: string) => {
    try {
      const res = await actOnDraft(d.id, action, text);
      setDrafts((prev) => prev.filter((x) => x.id !== d.id));
      if (res.sendError) toast.warning(`Saved, but sending failed: ${res.sendError}`);
      else toast.success(action === "discard" ? "Discarded" : `Sent to ${d.displayName || "contact"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the reply");
    }
  };

  const dismissEvent = async (id: string) => {
    try {
      await api.dismissLifeEvent(id);
      setEvents((prev) => prev.filter((e) => e.id !== id));
      toast.success("Dismissed");
    } catch {
      toast.error("Couldn't dismiss that");
    }
  };

  const copyCommand = (t: AttentionItem) => {
    const cmd = `${t.n} ${t.defaultAction}`;
    navigator.clipboard.writeText(cmd).then(
      () => toast.success(`Copied “${cmd}” — send it in your self-chat`),
      () => toast.error("Couldn't copy"),
    );
  };

  const now = new Date();
  const firstName = user?.name?.split(" ")[0];
  const holdCount = drafts.length;
  const anyChannelOnline = health.whatsapp === "online" || health.imessage === "online";

  return (
    <div className="flex flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 md:px-8 md:py-8">
        {/* Greeting */}
        <header className="mb-6">
          <p className="text-xs font-medium text-zinc-500">
            {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50 md:text-3xl">
            {greeting(now.getHours())}
            {firstName ? `, ${firstName}` : ""}.
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            {loading
              ? "Gathering what needs you…"
              : items.length === 0
                ? "Nothing needs you right now."
                : `${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you${holdCount ? ` — ${holdCount} repl${holdCount === 1 ? "y is" : "ies are"} waiting for your OK` : ""}.`}
          </p>
        </header>

        <div className="mb-6">
          <AskBar
            placeholder="Ask PAL anything — “what did I miss?”"
            examples={["What needs me today?", "Show replies waiting on me", "Open automations"]}
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* What needs you */}
          <section aria-labelledby="needs-you" className="min-w-0">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="needs-you" className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                What needs you
                {ranking && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-normal text-zinc-500">
                    <Loader2 className="h-3 w-3 animate-spin" /> ranking
                  </span>
                )}
                {ranked && !ranking && (
                  <span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    <Sparkles className="h-2.5 w-2.5 text-pal-400" /> ranked by PAL
                  </span>
                )}
              </h2>
              <Button variant="ghost" size="sm" icon={<RefreshCw className="h-3 w-3" />} onClick={() => void load()}>
                Refresh
              </Button>
            </div>

            {failed.length > 0 && (
              <p className="mb-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Couldn&apos;t load {failed.join(" and ")} — showing what loaded.
              </p>
            )}

            {loading ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-24 w-full rounded-xl" />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-zinc-700/60 bg-surface-1 px-6 py-12 text-center">
                <CheckCircle2 className="mx-auto h-8 w-8 text-pal-400" />
                <p className="mt-3 text-sm font-semibold text-zinc-100">You&apos;re all caught up</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-zinc-500">
                  {anyChannelOnline
                    ? "Held replies, suggestions, and threads waiting on you will show up here."
                    : "Connect a channel so PAL can start catching what needs you."}
                </p>
                {!anyChannelOnline && (
                  <Link href="/personal/setup" className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-pal-400 px-4 py-2 text-xs font-medium text-on-flame hover:bg-pal-300">
                    Connect a channel <ArrowRight className="h-3 w-3" />
                  </Link>
                )}
              </div>
            ) : (
              <ol className="space-y-2" aria-label="Ranked items">
                {items.map((item) => (
                  <li key={item.key}>
                    {item.kind === "hold" && draftById.get(item.id) ? (
                      <HoldCard item={item} draft={draftById.get(item.id)!} onResolve={resolveDraft} />
                    ) : item.kind === "life_event" ? (
                      <RowCard item={item} icon={Zap}>
                        <Button size="sm" variant="ghost" icon={<X className="h-3 w-3" />} onClick={() => void dismissEvent(item.id)}>
                          Dismiss
                        </Button>
                        <Link href="/automations" className="text-[12px] font-medium text-pal-400 hover:text-pal-300">Open</Link>
                      </RowCard>
                    ) : item.kind === "commitment" ? (
                      <RowCard item={item} icon={Clock}>
                        <Link href="/personal" className="text-[12px] font-medium text-pal-400 hover:text-pal-300">View</Link>
                      </RowCard>
                    ) : item.kind === "thread" && threadByKey.get(item.key) ? (
                      <RowCard item={item} icon={MessageCircle}>
                        <Button size="sm" variant="secondary" icon={<Copy className="h-3 w-3" />} onClick={() => copyCommand(threadByKey.get(item.key)!)}>
                          Copy chat command
                        </Button>
                      </RowCard>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Side rail */}
          <aside className="space-y-4">
            <section aria-label="Channels" className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
              <h2 className="text-xs font-semibold text-zinc-200">Channels</h2>
              <ul className="mt-2.5 space-y-2">
                {CHANNELS.map((ch) => (
                  <li key={ch} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 text-zinc-300">
                      <Smartphone className="h-3.5 w-3.5 text-zinc-500" />
                      {ch === "whatsapp" ? "WhatsApp" : "iMessage"}
                    </span>
                    <span className={clsx("flex items-center gap-1.5", health[ch] === "online" ? "text-emerald-400" : "text-zinc-500")}>
                      <span className={clsx("h-1.5 w-1.5 rounded-full", health[ch] === "online" ? "bg-emerald-400" : "bg-zinc-600")} />
                      {health[ch] === "online" ? "Connected" : health[ch] === "offline" ? "Offline" : "Checking"}
                    </span>
                  </li>
                ))}
              </ul>
              <Link href="/personal/setup" className="mt-3 inline-flex text-[12px] font-medium text-pal-400 hover:text-pal-300">
                Manage channels
              </Link>
            </section>

            <section aria-label="At a glance" className="grid grid-cols-2 gap-2">
              <Stat label="Held replies" value={loading ? "—" : String(holdCount)} href="/personal/drafts" icon={Inbox} />
              <Stat label="Suggestions" value={loading ? "—" : String(events.length)} href="/automations" icon={Zap} />
            </section>

            <SuggestedSteps
              page="pal Brief (personal home)"
              facts={[
                `${holdCount} held replies`,
                `${events.length} suggested automations`,
                `${commitments.length} open commitments`,
                `WhatsApp ${health.whatsapp}`,
                `iMessage ${health.imessage}`,
                isConfigured ? "model provider configured" : "no model provider key",
              ]}
              fallback={[
                ...(isConfigured ? [] : [{ label: "Add a model provider key", href: "/settings?tab=providers" }]),
                ...(anyChannelOnline ? [] : [{ label: "Connect WhatsApp or iMessage", href: "/personal/setup" }]),
                { label: "Tune automation trust levels", href: "/automations" },
                { label: "Teach PAL about your people", href: "/personal/contacts" },
              ].slice(0, 3)}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, href, icon: Icon }: { label: string; value: string; href: string; icon: typeof Inbox }) {
  return (
    <Link href={href} className="rounded-xl border border-zinc-800 bg-surface-1 p-3 transition-colors hover:border-zinc-700">
      <Icon className="h-3.5 w-3.5 text-zinc-500" />
      <p className="mt-2 text-xl font-semibold tabular-nums text-zinc-50">{value}</p>
      <p className="text-[11px] text-zinc-500">{label}</p>
    </Link>
  );
}

function Why({ why }: { why?: string }) {
  if (!why) return null;
  return (
    <p className="mt-1 flex items-center gap-1 text-[11px] text-pal-400">
      <Sparkles className="h-2.5 w-2.5" /> {why}
    </p>
  );
}

function RowCard({ item, icon: Icon, children }: { item: BriefItem; icon: typeof Inbox; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-surface-1 p-4 sm:flex-row sm:items-center">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-3 text-zinc-400">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-100">{item.title}</p>
        <p className="truncate text-xs text-zinc-500">
          {item.detail}
          {item.channel ? ` · ${item.channel}` : ""}
        </p>
        <Why why={item.why} />
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function HoldCard({
  item, draft, onResolve,
}: {
  item: BriefItem;
  draft: Draft;
  onResolve: (d: Draft, action: "approve" | "edit" | "discard", text?: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.draftText);
  const [busy, setBusy] = useState<null | "approve" | "edit" | "discard">(null);
  const act = async (a: "approve" | "edit" | "discard") => {
    setBusy(a);
    await onResolve(draft, a, a === "edit" ? text : undefined);
    setBusy(null);
  };
  return (
    <article aria-label={`Held reply to ${draft.displayName}`} className="rounded-xl border border-pal-500/25 bg-surface-1 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-pal-500/15 text-pal-400">
          <Inbox className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100">
            {item.title}
            <span className="ml-2 text-[11px] font-normal text-zinc-500">{draft.channel}</span>
          </p>
          <Why why={item.why} />
          <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-zinc-300">
            <span className="mr-1 text-zinc-500">They said:</span>
            {draft.inboundText}
          </p>
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Edit reply"
              rows={3}
              className="mt-2 w-full resize-y rounded-lg border border-zinc-700 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-pal-500/60"
            />
          ) : (
            <p className="mt-2 rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-100">
              <span className="mr-1 text-xs text-zinc-500">Draft:</span>
              {draft.draftText}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button size="sm" variant="primary" loading={busy === "edit"} disabled={!text.trim()} icon={<Check className="h-3 w-3" />} onClick={() => void act("edit")}>
                  Send edited
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(draft.draftText); }}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" loading={busy === "approve"} icon={<Check className="h-3 w-3" />} onClick={() => void act("approve")}>
                  Approve &amp; send
                </Button>
                <Button size="sm" variant="secondary" icon={<Edit3 className="h-3 w-3" />} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" loading={busy === "discard"} icon={<Trash2 className="h-3 w-3" />} onClick={() => void act("discard")}>
                  Discard
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
