"use client";

// /personal/groups — searchable group picker. The user said the
// /lantern groups list was empty from their phone because the bridge
// doesn't have group metadata until it fetches it once. This page
// triggers that fetch and renders the result with a toggle per row.
//
// UX rules:
//   1. Show monitored groups at the top, even if hundreds of others.
//   2. Search is the primary affordance (user has 139 groups).
//   3. Toggle is optimistic — user's intent matters, refresh confirms.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Eye,
  EyeOff,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";
import type { GroupRow } from "@/lib/bridge-types";

export default function GroupsPage() {
  const { state, bot, busy, monitorGroup, unmonitorGroup, refreshGroups } =
    useBridge();

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [togglingJid, setTogglingJid] = useState<string | null>(null);

  // Load groups whenever bridge becomes live.
  useEffect(() => {
    if (state !== "connected" && state !== "reconnecting") return;
    if (loaded) return;
    let cancelled = false;
    (async () => {
      const next = await refreshGroups();
      if (!cancelled) {
        setGroups(next);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, loaded, refreshGroups]);

  // Reconcile rows with bot.monitoredGroups whenever it changes — so a
  // toggle from another tab / phone is reflected here too.
  const monitoredSet = useMemo(
    () => new Set(bot?.monitoredGroups ?? []),
    [bot?.monitoredGroups],
  );

  const decorated = useMemo(
    () =>
      groups.map((g) => ({ ...g, monitored: monitoredSet.has(g.jid) })),
    [groups, monitoredSet],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? decorated.filter(
          (g) =>
            g.name.toLowerCase().includes(q) || g.jid.toLowerCase().includes(q),
        )
      : decorated;
    // Monitored first, then alpha by name.
    return [...matched].sort((a, b) => {
      if (a.monitored !== b.monitored) return a.monitored ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [decorated, query]);

  const offline = state !== "connected" && state !== "reconnecting";
  const monitoredCount = decorated.filter((g) => g.monitored).length;

  const handleRefresh = async () => {
    const next = await refreshGroups();
    setGroups(next);
    setLoaded(true);
  };

  const handleToggle = async (jid: string, currentlyMonitored: boolean) => {
    setTogglingJid(jid);
    try {
      if (currentlyMonitored) await unmonitorGroup(jid);
      else await monitorGroup(jid);
    } finally {
      setTogglingJid(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-zinc-800/80 bg-surface-1 p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium text-zinc-50">
              Monitor group chats
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-zinc-400">
              Pick the groups you want your assistant to watch. When you&apos;re @mentioned in a monitored group, the assistant DMs you a quick summary instead of you having to scroll.
            </p>
            <div className="mt-3 flex items-center gap-3 text-xs">
              <span className="text-zinc-500">
                {monitoredCount} monitored · {decorated.length} total
              </span>
              <button
                type="button"
                onClick={handleRefresh}
                disabled={offline || busy.refreshingGroups}
                className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3 w-3 ${busy.refreshingGroups ? "animate-spin" : ""}`}
                />
                Refresh
              </button>
            </div>
          </div>
        </div>
      </div>

      {offline ? (
        <OfflineCard />
      ) : (
        <div className="rounded-2xl border border-zinc-800/80 bg-surface-1">
          <div className="border-b border-zinc-800/60 p-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-2 pl-10 pr-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
          {filtered.length === 0 ? (
            <EmptyGroupList
              loaded={loaded}
              query={query}
              onRefresh={handleRefresh}
              refreshing={busy.refreshingGroups}
            />
          ) : (
            <ul className="divide-y divide-zinc-800/60">
              {filtered.map((g) => (
                <GroupRowItem
                  key={g.jid}
                  group={g}
                  busy={togglingJid === g.jid}
                  onToggle={() => handleToggle(g.jid, g.monitored)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- row

function GroupRowItem({
  group,
  busy,
  onToggle,
}: {
  group: GroupRow & { monitored: boolean };
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-zinc-900/40">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900">
        <Users className="h-4 w-4 text-zinc-500" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-100">{group.name}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">
          {group.participants > 0 ? `${group.participants} members · ` : ""}
          {group.jid}
        </div>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
          group.monitored
            ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
            : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        {group.monitored ? (
          <>
            <Eye className="h-3.5 w-3.5" /> Monitored
          </>
        ) : (
          <>
            <EyeOff className="h-3.5 w-3.5" /> Off
          </>
        )}
      </button>
    </li>
  );
}

// -------------------------------------------------------------------- empty states

function EmptyGroupList({
  loaded,
  query,
  onRefresh,
  refreshing,
}: {
  loaded: boolean;
  query: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  if (query) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-400">
        <Search className="h-6 w-6 text-zinc-600" />
        <div className="mt-3">No groups match &quot;{query}&quot;.</div>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-400">
        <RefreshCw className="h-6 w-6 animate-spin text-zinc-600" />
        <div className="mt-3">Loading your groups…</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center text-sm text-zinc-400">
      <Users className="h-6 w-6 text-zinc-600" />
      <div className="mt-3 text-zinc-300">No groups discovered yet</div>
      <p className="mt-1 max-w-md text-xs text-zinc-500">
        The bridge fetches your group list once after pairing. If it&apos;s empty, your phone may not have synced groups to the linked-device yet. Try refreshing in a few seconds.
      </p>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
      >
        <RefreshCw
          className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
        />
        Refresh now
      </button>
    </div>
  );
}

function OfflineCard() {
  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 text-sm text-amber-100">
      <h3 className="font-medium text-amber-100">Pair WhatsApp first</h3>
      <p className="mt-1 text-xs text-amber-200/80">
        The bridge needs to be paired with your phone before we can fetch your group list.
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
