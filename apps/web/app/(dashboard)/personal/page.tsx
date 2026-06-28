"use client";

// /personal — overview. Glance-friendly tiles + quick actions + "Your Life"
// domain summary. Designed so a returning user can see "is my assistant alive,
// did anything happen, what's monitored, what's on my plate" in one screen.

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowRight,
  Briefcase,
  Building2,
  Car,
  CheckCircle2,
  Crown,
  DollarSign,
  FileText,
  Heart,
  Phone,
  Plane,
  Smartphone,
  Users,
  UserMinus,
  Zap,
} from "lucide-react";

import { useBridge } from "@/components/personal/bridge-context";
import type { ActivityEvent, ConnectionState } from "@/lib/bridge-types";
import { listDrafts, listVIPs } from "@/lib/whatsapp-personal-client";
import { api } from "@/lib/api";
import type { Commitment, DomainRecord } from "@/lib/api";
import type { Agent } from "@/lib/mock-data";

export default function PersonalOverview() {
  const {
    state,
    reason,
    phoneNumber,
    connectedAt,
    bot,
    activity,
    busy,
    startPairing,
  } = useBridge();

  const isLive = state === "connected" || state === "reconnecting";
  const monitoredCount = bot?.monitoredGroups?.length ?? 0;
  const pausedCount = Object.keys(bot?.paused ?? {}).length;
  const recentReplies = activity.filter((a) => a.kind === "agent_reply").slice(0, 5);
  const recentMessages = activity.filter((a) => a.kind === "message_in").length;

  // VIP + pending-drafts counts come from the control-plane (not the
  // bridge), so we poll them lightly here. Refresh every 12s — they
  // change rarely. Loaded once when the page is alive; the dedicated
  // /personal/drafts page does the heavy polling.
  const [vipCount, setVipCount] = useState<number | null>(null);
  const [pendingDrafts, setPendingDrafts] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [v, d] = await Promise.all([listVIPs(), listDrafts("pending")]);
        if (cancelled) return;
        setVipCount(v.vips.length);
        setPendingDrafts(d.drafts.length);
      } catch {
        // silent — tiles just show "—"
      }
    };
    load();
    const t = setInterval(load, 12_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  // "Your Life" data — agents, open commitments, domain records, gmail check.
  // ponytail: single load, no polling (this data is slow-changing)
  const [lifeAgents, setLifeAgents] = useState<Agent[]>([]);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [domainRecords, setDomainRecords] = useState<DomainRecord[]>([]);
  const [hasGmail, setHasGmail] = useState<boolean | null>(null);
  const [loadingLife, setLoadingLife] = useState(true);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [agentList, coms, recs, connectors] = await Promise.all([
          api.listAgents(),
          api.listCommitments({ status: "open", limit: 200 }),
          api.listDomainRecords(),
          api.listConnectors(),
        ]);
        if (cancelled) return;
        setLifeAgents(agentList);
        setCommitments(coms);
        setDomainRecords(recs);
        setHasGmail(connectors.some((c) => c.connectorId === "gmail" && c.status === "active"));
      } catch {
        // silent — each sub-section shows its own empty state
      } finally {
        if (!cancelled) setLoadingLife(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-8">
      {!isLive && <NotLiveBanner state={state} reason={reason} pairing={busy.pairing} onStart={startPairing} />}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Tile
          icon={Smartphone}
          label="Status"
          value={isLive ? "Live" : prettyState(state)}
          tone={isLive ? "good" : state === "idle" ? "neutral" : "bad"}
          meta={
            phoneNumber
              ? `+${phoneNumber}`
              : isLive
                ? null
                : "Pair to get started"
          }
        />
        <Tile
          icon={Zap}
          label="Auto-reply"
          value={bot?.muted ? "Paused" : bot ? "Active" : "—"}
          tone={bot?.muted ? "warn" : bot ? "good" : "neutral"}
          meta={pausedCount ? `${pausedCount} contact${pausedCount > 1 ? "s" : ""} muted` : null}
          href="/personal/auto-reply"
        />
        <Tile
          icon={FileText}
          label="Pending drafts"
          value={pendingDrafts === null ? "—" : String(pendingDrafts)}
          tone={pendingDrafts && pendingDrafts > 0 ? "warn" : "neutral"}
          meta={
            pendingDrafts && pendingDrafts > 0
              ? "VIPs awaiting your approval"
              : "VIP replies queue here"
          }
          href="/personal/drafts"
        />
        <Tile
          icon={Crown}
          label="VIP contacts"
          value={vipCount === null ? "—" : String(vipCount)}
          tone={vipCount && vipCount > 0 ? "good" : "neutral"}
          meta="auto-send OFF, draft for approval"
          href="/personal/vip"
        />
        <Tile
          icon={Users}
          label="Monitored groups"
          value={String(monitoredCount)}
          tone={monitoredCount > 0 ? "good" : "neutral"}
          meta="Auto-summary on mention"
          href="/personal/groups"
        />
        <Tile
          icon={Activity}
          label="Today"
          value={String(recentMessages)}
          tone="neutral"
          meta="incoming messages"
          href="/personal/activity"
        />
      </section>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title="Recent auto-replies"
            description="The last 5 messages your assistant sent on your behalf."
            action={
              <Link
                href="/personal/activity"
                className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
              >
                See all <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
            {recentReplies.length === 0 ? (
              <EmptyRow
                icon={Zap}
                label="No auto-replies yet"
                hint={
                  isLive
                    ? "When someone DMs you and you don't respond, the assistant takes over."
                    : "Pair your phone to start auto-replying."
                }
              />
            ) : (
              <ul className="divide-y divide-zinc-800/60">
                {recentReplies.map((r) => (
                  <ReplyRow key={r.id} event={r} />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Quick actions">
            <ul className="space-y-1">
              <QuickAction
                href="/personal/setup"
                icon={Phone}
                label={isLive ? "Manage device" : "Pair device"}
              />
              <QuickAction
                href="/personal/auto-reply"
                icon={Zap}
                label={bot?.muted ? "Resume auto-reply" : "Pause auto-reply"}
              />
              <QuickAction
                href="/personal/groups"
                icon={Users}
                label="Pick groups to monitor"
              />
              <QuickAction
                href="/personal/contacts"
                icon={UserMinus}
                label={pausedCount ? `Manage ${pausedCount} paused` : "Paused contacts"}
              />
            </ul>
          </Panel>

          <Panel title="What this does">
            <ul className="space-y-2 text-sm text-zinc-400">
              <Bullet>Replies to DMs the way you would, in your voice.</Bullet>
              <Bullet>Steps aside silently when you message a contact yourself.</Bullet>
              <Bullet>Watches the groups you pick and notifies you on @mentions.</Bullet>
              <Bullet>Sends important status to your email + WhatsApp.</Bullet>
            </ul>
          </Panel>
        </div>
      </section>

      {/* ── Your Life ── */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Your life</h2>
            <p className="mt-0.5 text-xs text-zinc-500">What your personal agents are handling across every domain.</p>
          </div>
          <Link href="/agents" className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200">
            All agents <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {/* Activation hint — shown when Gmail isn't connected and load is done */}
        {!loadingLife && !hasGmail && (
          <Banner tone="info" title="Connect Gmail to bring this to life">
            <p className="mt-1 text-sm text-zinc-400">
              Your agents can track bills, renewals, appointments, and commitments — but they need access to your inbox first.
            </p>
            <div className="mt-3 flex gap-2">
              <Link
                href="/connectors"
                className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-400"
              >
                Connect Gmail
              </Link>
              <Link
                href="/agents"
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800"
              >
                Enable agents
              </Link>
            </div>
          </Banner>
        )}

        {/* Life domains grid */}
        {loadingLife ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl border border-zinc-800/80 bg-surface-1" />
            ))}
          </div>
        ) : (
          <LifeDomainsGrid
            agents={lifeAgents}
            commitments={commitments}
            domainRecords={domainRecords}
          />
        )}

        {/* On your plate */}
        <Panel
          title="On your plate"
          description="Open commitments surfaced by your agents."
          action={
            commitments.length > 0 ? (
              <span className="inline-flex h-5 items-center justify-center rounded-full bg-amber-500/15 px-2 text-[11px] font-medium text-amber-300">
                {commitments.length}
              </span>
            ) : undefined
          }
        >
          {loadingLife ? (
            <div className="space-y-3 py-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-3/40" />
              ))}
            </div>
          ) : commitments.length === 0 ? (
            <EmptyRow
              icon={CheckCircle2}
              label="Nothing on your plate"
              hint={
                hasGmail
                  ? "Your agents will surface tasks as they find them."
                  : "Connect Gmail so your agents can start tracking bills, appointments, and renewals."
              }
            />
          ) : (
            <ul className="divide-y divide-zinc-800/60">
              {commitments.slice(0, 8).map((c) => (
                <CommitmentRow key={c.id} commitment={c} />
              ))}
            </ul>
          )}
        </Panel>
      </section>
    </div>
  );
}

// -------------------------------------------------------------------- tiles

interface TileProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  tone: "good" | "warn" | "bad" | "neutral";
  meta?: string | null;
  href?: string;
}

function Tile({ icon: Icon, label, value, tone, meta, href }: TileProps) {
  const toneClasses = {
    good: "text-emerald-300",
    warn: "text-amber-300",
    bad: "text-rose-300",
    neutral: "text-zinc-200",
  }[tone];
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          {label}
        </span>
        <Icon className="h-4 w-4 text-zinc-600" />
      </div>
      <div className={`mt-2 text-2xl font-medium ${toneClasses}`}>{value}</div>
      {meta && <div className="mt-1 text-xs text-zinc-500">{meta}</div>}
    </>
  );
  const className =
    "block rounded-xl border border-zinc-800/80 bg-surface-1 p-5 transition-colors hover:border-zinc-700";
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

// -------------------------------------------------------------------- panels

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-surface-1">
      <div className="flex items-start justify-between border-b border-zinc-800/60 px-5 py-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-zinc-500">{description}</p>
          )}
        </div>
        {action}
      </div>
      <div className="px-5 py-3">{children}</div>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center justify-between rounded-lg px-2 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-800/50 hover:text-zinc-50"
      >
        <span className="inline-flex items-center gap-2">
          <Icon className="h-4 w-4 text-zinc-500 group-hover:text-zinc-300" />
          {label}
        </span>
        <ArrowRight className="h-3.5 w-3.5 text-zinc-600 transition-colors group-hover:text-zinc-300" />
      </Link>
    </li>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500/60" />
      <span>{children}</span>
    </li>
  );
}

// -------------------------------------------------------------------- rows

function ReplyRow({ event }: { event: ActivityEvent }) {
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-sm text-zinc-200">{event.summary}</div>
        <time className="font-mono text-[10px] uppercase tracking-wide text-zinc-600">
          {timeAgo(event.timestamp)}
        </time>
      </div>
      {event.detail && (
        <div className="mt-1 line-clamp-2 text-xs text-zinc-500">{event.detail}</div>
      )}
    </li>
  );
}

function EmptyRow({
  icon: Icon,
  label,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon className="h-6 w-6 text-zinc-600" />
      <div className="mt-3 text-sm text-zinc-300">{label}</div>
      <div className="mt-1 max-w-sm text-xs text-zinc-500">{hint}</div>
    </div>
  );
}

// -------------------------------------------------------------------- banners

function NotLiveBanner({
  state,
  reason,
  pairing,
  onStart,
}: {
  state: ConnectionState;
  reason: string | null;
  pairing: boolean;
  onStart: () => void;
}) {
  if (state === "idle") {
    return (
      <Banner tone="info" title="Pair to start your assistant">
        <p className="mt-1 text-sm text-zinc-400">
          One QR scan. Your assistant replies to DMs in your voice, steps aside when you type, and watches the groups you choose.
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={onStart}
            disabled={pairing}
            className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-400 disabled:opacity-50"
          >
            {pairing ? "Starting…" : "Pair WhatsApp"}
          </button>
        </div>
      </Banner>
    );
  }
  if (state === "logged_out") {
    return (
      <Banner tone="warn" title="Your phone unlinked this device">
        <p className="mt-1 text-sm text-zinc-400">
          Pair again to resume — your settings (monitored groups, paused contacts) are preserved.
        </p>
        <div className="mt-3">
          <Link
            href="/personal/setup"
            className="rounded-lg bg-violet-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-400"
          >
            Pair again
          </Link>
        </div>
      </Banner>
    );
  }
  if (state === "conflict") {
    return (
      <Banner tone="warn" title="Another WhatsApp Web session is active">
        <p className="mt-1 text-sm text-zinc-400">
          Open WhatsApp on your phone → Settings → Linked Devices → log out the other session, then pair again.
        </p>
      </Banner>
    );
  }
  if (state === "bridge_offline") {
    return (
      <Banner tone="bad" title="Bridge offline">
        <p className="mt-1 text-sm text-zinc-400">
          The bridge service isn&apos;t running on this host. Run{" "}
          <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-xs text-zinc-300">
            make run-whatsapp-bridge
          </code>{" "}
          on your dev machine.
        </p>
      </Banner>
    );
  }
  if (state === "error") {
    return (
      <Banner tone="bad" title="Bridge reported an error">
        {reason && <p className="mt-1 text-sm text-zinc-400">{reason}</p>}
      </Banner>
    );
  }
  // starting / qr_ready / connecting / reconnecting — just nudge to setup page
  return (
    <Banner tone="info" title="Almost there">
      <p className="mt-1 text-sm text-zinc-400">
        Pairing in progress.{" "}
        <Link href="/personal/setup" className="text-violet-300 underline">
          Open setup
        </Link>{" "}
        to see the QR code or status.
      </p>
    </Banner>
  );
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "info" | "warn" | "bad";
  title: string;
  children: React.ReactNode;
}) {
  const cls = {
    info: "border-violet-500/30 bg-violet-500/5",
    warn: "border-amber-500/30 bg-amber-500/5",
    bad: "border-rose-500/30 bg-rose-500/5",
  }[tone];
  return (
    <div className={`rounded-xl border p-5 ${cls}`}>
      <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
      {children}
    </div>
  );
}

// -------------------------------------------------------------------- life domains

interface LifeDomain {
  id: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  agentNames: string[];
  hint: string;
}

const LIFE_DOMAINS: LifeDomain[] = [
  { id: "health",        label: "Health",        icon: Heart,     agentNames: ["health-coach"],                                               hint: "Health records & wellness" },
  { id: "vehicle",       label: "Vehicle",        icon: Car,       agentNames: ["garage"],                                                     hint: "Maintenance & renewals" },
  { id: "career",        label: "Career",         icon: Briefcase, agentNames: ["upskill"],                                                    hint: "Skills & career growth" },
  { id: "travel",        label: "Travel",         icon: Plane,     agentNames: ["travel-concierge"],                                           hint: "Trips & travel docs" },
  { id: "home",          label: "Home",           icon: Building2, agentNames: ["household", "energy-guardian"],                               hint: "Warranties & utilities" },
  { id: "finance",       label: "Finance",        icon: DollarSign,agentNames: ["financial-sentinel"],                                         hint: "Bills & subscriptions" },
  { id: "relationships", label: "Relationships",  icon: Users,     agentNames: ["relationship-keeper"],                                        hint: "Important contacts" },
  { id: "productivity",  label: "Productivity",   icon: Zap,       agentNames: ["focus-guardian", "morning-brief", "inbox-concierge", "commute-copilot"], hint: "Focus & routines" },
];

// source → domain mapping for coloring commitment rows
const SOURCE_TO_DOMAIN: Record<string, string> = {
  health: "health", vehicle: "vehicle", career: "career", travel: "travel",
  home: "home", bill: "finance", email: "productivity",
  spouse: "relationships", vip: "relationships",
};

function LifeDomainsGrid({
  agents,
  commitments,
  domainRecords,
}: {
  agents: Agent[];
  commitments: Commitment[];
  domainRecords: DomainRecord[];
}) {
  const agentByName = new Map(agents.map((a) => [a.name, a]));
  // count open commitments per domain (by source mapping)
  const commitCountByDomain: Record<string, number> = {};
  for (const c of commitments) {
    const d = SOURCE_TO_DOMAIN[c.source] ?? c.kind ?? "productivity";
    commitCountByDomain[d] = (commitCountByDomain[d] ?? 0) + 1;
  }
  // count records per domain
  const recordCountByDomain: Record<string, number> = {};
  for (const r of domainRecords) {
    recordCountByDomain[r.domain] = (recordCountByDomain[r.domain] ?? 0) + 1;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {LIFE_DOMAINS.map((domain) => {
        const domainAgents = domain.agentNames
          .map((n) => agentByName.get(n))
          .filter(Boolean) as Agent[];
        const active = domainAgents.some((a) => a.status === "active");
        const deployed = domainAgents.length > 0;
        const openCount = commitCountByDomain[domain.id] ?? 0;
        const recordCount = recordCountByDomain[domain.id] ?? 0;
        const Icon = domain.icon;

        const statusDot = !deployed
          ? "bg-zinc-700"
          : active
            ? "bg-emerald-400"
            : "bg-zinc-500";
        const statusLabel = !deployed ? "Not set up" : active ? "Active" : "Idle";

        return (
          <Link
            key={domain.id}
            href={`/agents?q=${encodeURIComponent(domain.agentNames[0] ?? "")}`}
            className="group block rounded-xl border border-zinc-800/80 bg-surface-1 p-4 transition-colors hover:border-zinc-700"
          >
            <div className="flex items-center justify-between">
              <Icon className="h-4 w-4 text-zinc-500 group-hover:text-zinc-300" />
              <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600">
                <span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
                {statusLabel}
              </span>
            </div>
            <div className="mt-2 text-sm font-medium text-zinc-200">{domain.label}</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">{domain.hint}</div>
            {(openCount > 0 || recordCount > 0) && (
              <div className="mt-2 flex gap-2">
                {openCount > 0 && (
                  <span className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                    {openCount} open
                  </span>
                )}
                {recordCount > 0 && (
                  <span className="inline-flex items-center rounded-full bg-zinc-700/40 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                    {recordCount} records
                  </span>
                )}
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function CommitmentRow({ commitment: c }: { commitment: Commitment }) {
  const urgencyDot: Record<string, string> = {
    now: "bg-rose-400",
    soon: "bg-amber-400",
    normal: "bg-zinc-500",
    fyi: "bg-zinc-700",
  };
  const deadlineStr = c.deadline ? new Date(c.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;

  return (
    <li className="flex items-start gap-3 py-3">
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${urgencyDot[c.urgency] ?? "bg-zinc-600"}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-200">{c.title}</p>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
          <span className="capitalize">{c.source}</span>
          {deadlineStr && (
            <>
              <span className="text-zinc-700">·</span>
              <span>{deadlineStr}</span>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

// -------------------------------------------------------------------- utils

function prettyState(s: ConnectionState): string {
  switch (s) {
    case "idle":
      return "Not paired";
    case "starting":
    case "qr_ready":
    case "connecting":
      return "Pairing";
    case "reconnecting":
      return "Reconnecting";
    case "logged_out":
      return "Unlinked";
    case "conflict":
      return "Conflict";
    case "error":
      return "Error";
    case "bridge_offline":
      return "Bridge offline";
    case "auth_required":
      return "Auth required";
    case "unknown":
    default:
      return "—";
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}
