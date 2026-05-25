"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  HelpCircle,
  Loader2,
  LogOut,
  MessageSquare,
  Pause,
  Play,
  Power,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserMinus,
  WifiOff,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import { Button } from "@/components/button";
import { useToast } from "@/components/toast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Mirror of the bridge's `ConnectionState` union (see session.ts). Two extra
// dashboard-only states sit out front of the wire states:
//   - `unknown`         — initial mount, before bridge probe has answered.
//   - `bridge_offline`  — bridge unreachable on this host.
//   - `auth_required`   — bridge reachable but the shared token is wrong.
// Everything below `idle` is what the bridge emits over the connection_state
// WebSocket event.
type ConnectionState =
  | "unknown"
  | "bridge_offline"
  | "auth_required"
  | "idle"
  | "starting"
  | "qr_ready"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  // Terminal: another WhatsApp Web session is active for this number
  // and keeps stealing our slot. The bridge stops retrying and we
  // render an actionable "close other sessions" panel.
  | "conflict"
  | "error";

// Stepper stages — the four "wide" milestones the user walks through.
type Stage = "bridge" | "auth" | "pairing" | "connected";

const STATE_TO_STAGE: Record<ConnectionState, Stage> = {
  unknown: "bridge",
  bridge_offline: "bridge",
  auth_required: "auth",
  idle: "auth",
  starting: "pairing",
  qr_ready: "pairing",
  connecting: "pairing",
  connected: "connected",
  reconnecting: "connected",
  logged_out: "pairing",
  conflict: "pairing",
  error: "pairing",
};

interface BotState {
  muted: boolean;
  paused: Record<string, number>;
  monitoredGroups?: string[];
}

// Live activity feed entries — derived from `message`, `agent_reply`, and
// `activity` WS events. We keep them flattened in one timeline so the user
// sees the full conversation context (who messaged, what the bot did, etc.).
type ActivityKind =
  | "bot_on"
  | "bot_off"
  | "monitor_on"
  | "monitor_off"
  | "contact_paused"
  | "contact_resumed"
  | "attention_dm"
  | "agent_skipped"
  | "message_in"
  | "agent_reply"
  | "system";

interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  summary: string;
  detail?: string;
  jid?: string;
  pushName?: string;
  timestamp: number;
}

interface WhatsAppPairingProps {
  // Real tenant UUID. Bridge keys `auth_sessions/` by this string, so it
  // must match between dashboard and bridge — otherwise pairing happens
  // against an empty auth dir every time.
  tenantId: string;
  bridgeUrl?: string;
  onConnected?: (info: { phoneNumber: string; name: string }) => void;
  onDisconnected?: () => void;
  // Optional agent identity. When set, agent_reply rows in the activity
  // timeline render the avatar instead of the generic lightning icon so
  // the operator can tell at a glance which turns were the agent's.
  agentAvatarUrl?: string;
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

// Optional shared token sent on every bridge request. The bridge enforces
// it iff LANTERN_BRIDGE_TOKEN is set on its side; both must match. We do
// NOT inline it into the WS URL when empty so the URL stays clean.
const BRIDGE_TOKEN = process.env.NEXT_PUBLIC_LANTERN_BRIDGE_TOKEN || "";

function authHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { ...(extra as Record<string, string> | undefined) };
  if (BRIDGE_TOKEN) h["Authorization"] = `Bearer ${BRIDGE_TOKEN}`;
  return h;
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

const STAGE_ORDER: Stage[] = ["bridge", "auth", "pairing", "connected"];
const STAGE_LABEL: Record<Stage, string> = {
  bridge: "Bridge",
  auth: "Auth",
  pairing: "Pairing",
  connected: "Connected",
};

function Stepper({ stage, error }: { stage: Stage; error?: boolean }) {
  const activeIdx = STAGE_ORDER.indexOf(stage);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      {STAGE_ORDER.map((s, idx) => {
        const isActive = idx === activeIdx;
        const isDone = idx < activeIdx;
        return (
          <div key={s} className="flex items-center gap-2">
            <span
              className={clsx(
                "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold transition-colors",
                isDone && "bg-emerald-500/15 text-emerald-400",
                isActive && !error && "bg-lantern-500/20 text-lantern-300 ring-2 ring-lantern-500/30",
                isActive && error && "bg-red-500/20 text-red-300 ring-2 ring-red-500/30",
                !isDone && !isActive && "bg-surface-2 text-zinc-600"
              )}
            >
              {isDone ? <Check className="h-3 w-3" /> : idx + 1}
            </span>
            <span
              className={clsx(
                "font-medium transition-colors",
                isActive ? "text-zinc-200" : isDone ? "text-zinc-400" : "text-zinc-600"
              )}
            >
              {STAGE_LABEL[s]}
            </span>
            {idx < STAGE_ORDER.length - 1 && (
              <span className="mx-1 h-px w-6 bg-zinc-800" />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StatePill({ state }: { state: ConnectionState }) {
  const map: Record<
    ConnectionState,
    { label: string; cls: string; dot: string }
  > = {
    unknown: { label: "Checking", cls: "bg-zinc-500/10 text-zinc-400", dot: "bg-zinc-500" },
    bridge_offline: { label: "Bridge offline", cls: "bg-red-500/10 text-red-300", dot: "bg-red-500" },
    auth_required: { label: "Auth required", cls: "bg-amber-500/10 text-amber-300", dot: "bg-amber-500" },
    idle: { label: "Ready", cls: "bg-zinc-500/10 text-zinc-300", dot: "bg-zinc-400" },
    starting: { label: "Starting", cls: "bg-lantern-500/10 text-lantern-300", dot: "bg-lantern-400 animate-pulse" },
    qr_ready: { label: "Scan QR", cls: "bg-lantern-500/10 text-lantern-300", dot: "bg-lantern-400 animate-pulse" },
    connecting: { label: "Connecting", cls: "bg-lantern-500/10 text-lantern-300", dot: "bg-lantern-400 animate-pulse" },
    connected: { label: "Connected", cls: "bg-emerald-500/10 text-emerald-300", dot: "bg-emerald-400" },
    reconnecting: { label: "Reconnecting", cls: "bg-amber-500/10 text-amber-300", dot: "bg-amber-400 animate-pulse" },
    logged_out: { label: "Unlinked", cls: "bg-red-500/10 text-red-300", dot: "bg-red-500" },
    conflict: { label: "Conflict", cls: "bg-amber-500/10 text-amber-300", dot: "bg-amber-500" },
    error: { label: "Error", cls: "bg-red-500/10 text-red-300", dot: "bg-red-500" },
  };
  const v = map[state];
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
        v.cls
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", v.dot)} />
      {v.label}
    </span>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Searchable group picker. Replaces the static monitored-only list with
// a real UX where the user sees EVERY group the bridge knows about,
// can search by name, and toggles monitoring with a single click. No
// more curl-with-JID workarounds.
function GroupPicker({
  monitoredCount,
  allGroups,
  loading,
  togglingJid,
  onToggle,
  onRefresh,
}: {
  monitoredCount: number;
  allGroups: Array<{ jid: string; name: string; participants: number; monitored: boolean }> | null;
  loading: boolean;
  togglingJid: string | null;
  onToggle: (jid: string, isCurrentlyMonitored: boolean) => void;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const q = search.trim().toLowerCase();
  const filtered = (allGroups ?? []).filter((g) =>
    q === "" ? true : g.name.toLowerCase().includes(q) || g.jid.includes(q),
  );
  // Cap to 12 by default; "Show all" reveals the rest. Most users care
  // about the top of the list (monitored first, then alpha).
  const visible = showAll ? filtered : filtered.slice(0, 12);
  const remaining = Math.max(0, filtered.length - visible.length);

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-zinc-200">Monitored groups</p>
        <div className="flex items-center gap-2">
          <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
            {monitoredCount} / {allGroups?.length ?? "?"}
          </span>
          <button
            onClick={onRefresh}
            disabled={loading}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200 disabled:opacity-50"
            title="Refresh from WhatsApp"
            aria-label="Refresh groups"
          >
            <RefreshCw className={clsx("h-3 w-3", loading && "animate-spin")} />
          </button>
        </div>
      </div>

      {allGroups === null && loading ? (
        <p className="mt-3 text-[11px] text-zinc-500">Loading groups from WhatsApp…</p>
      ) : (allGroups?.length ?? 0) === 0 ? (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
          No groups found. If you're definitely in groups on WhatsApp,
          click the refresh icon — sometimes Baileys takes a moment to
          sync the group list after pairing.
        </p>
      ) : (
        <>
          <div className="relative mt-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${allGroups?.length ?? 0} groups…`}
              className="w-full rounded-md border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-lantern-500/50"
            />
          </div>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
            {visible.map((g) => {
              const busy = togglingJid === g.jid;
              return (
                <li key={g.jid}>
                  <button
                    onClick={() => onToggle(g.jid, g.monitored)}
                    disabled={busy}
                    className={clsx(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-50",
                      g.monitored
                        ? "border border-emerald-500/30 bg-emerald-500/[0.06] hover:bg-emerald-500/10"
                        : "border border-zinc-800 bg-surface-0 hover:bg-surface-2",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className={clsx(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          g.monitored ? "border-emerald-500/50 bg-emerald-500/30" : "border-zinc-700 bg-surface-0",
                        )}
                      >
                        {g.monitored && <Check className="h-3 w-3 text-emerald-300" />}
                      </span>
                      <span className="truncate text-[12px] text-zinc-200">{g.name}</span>
                    </div>
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>{g.participants} 👤</>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 && (
              <li className="px-2 py-3 text-center text-[11px] text-zinc-500">
                No matches for &ldquo;{search}&rdquo;.
              </li>
            )}
          </ul>
          {remaining > 0 && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 w-full text-center text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Show {remaining} more
            </button>
          )}
          <p className="mt-2 text-[11px] text-zinc-500">
            Checked groups auto-reply when you&apos;re @mentioned or quoted.
            Unchecked groups are ignored entirely.
          </p>
        </>
      )}
    </div>
  );
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function initialsFor(name: string | null, phone: string | null): string {
  const src = (name || phone || "?").trim();
  if (!src) return "?";
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CopyableCommand({ cmd }: { cmd: string }) {
  const toast = useToast();
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(cmd);
        toast.success("Copied to clipboard");
      }}
      className="group inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-surface-0 px-2 py-1 font-mono text-[11px] text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
    >
      <span className="truncate">{cmd}</span>
      <Copy className="h-3 w-3 shrink-0 text-zinc-500 group-hover:text-zinc-300" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Activity feed row
// ---------------------------------------------------------------------------

const ACTIVITY_ICON: Record<ActivityKind, { icon: typeof Bell; cls: string }> = {
  bot_on: { icon: Play, cls: "text-emerald-400" },
  bot_off: { icon: Pause, cls: "text-zinc-500" },
  monitor_on: { icon: Bell, cls: "text-sky-400" },
  monitor_off: { icon: Bell, cls: "text-zinc-500" },
  contact_paused: { icon: UserMinus, cls: "text-amber-400" },
  contact_resumed: { icon: Play, cls: "text-emerald-400" },
  attention_dm: { icon: AlertTriangle, cls: "text-amber-300" },
  agent_skipped: { icon: ChevronRight, cls: "text-zinc-500" },
  message_in: { icon: MessageSquare, cls: "text-zinc-400" },
  agent_reply: { icon: Zap, cls: "text-lantern-400" },
  system: { icon: HelpCircle, cls: "text-zinc-500" },
};

function ActivityRow({
  event,
  now,
  onPauseContact,
  pausing,
  agentAvatarUrl,
  agentName,
}: {
  event: ActivityEvent;
  now: number;
  onPauseContact?: (jid: string) => void;
  pausing?: string | null;
  agentAvatarUrl?: string;
  agentName?: string;
}) {
  const { icon: Icon, cls } = ACTIVITY_ICON[event.kind] ?? ACTIVITY_ICON.system;
  const isAgentReply = event.kind === "agent_reply";
  const showAvatar = isAgentReply && !!agentAvatarUrl;
  // The "pause this contact" action only makes sense on inbound DMs — you
  // can't pause the bot for a group, and pausing an outbound row is
  // meaningless. We render the action inline (WATI pattern) on hover.
  const showPause =
    event.kind === "message_in" &&
    !!event.jid &&
    !event.jid.endsWith("@g.us") &&
    !!onPauseContact;
  const isPausing = pausing === event.jid;
  return (
    <li className="group flex items-start gap-2.5 px-3 py-2 hover:bg-surface-2">
      {showAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={agentAvatarUrl}
          alt={agentName ? `${agentName} avatar` : "Agent avatar"}
          className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-zinc-700 object-cover"
          onError={(e) => {
            // Fall back to the icon if the URL fails to load.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <Icon className={clsx("mt-0.5 h-3.5 w-3.5 shrink-0", cls)} />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12px] text-zinc-200">
          {isAgentReply && agentName ? (
            <span className="mr-1 font-medium text-lantern-300">{agentName}</span>
          ) : null}
          {event.summary}
        </p>
        {event.detail && (
          <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-zinc-500">
            {event.detail}
          </p>
        )}
      </div>
      {showPause && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPauseContact!(event.jid!);
          }}
          disabled={isPausing}
          className="shrink-0 rounded-md border border-zinc-700/60 px-1.5 py-0.5 text-[10px] text-zinc-400 opacity-0 transition-all hover:border-amber-500/40 hover:text-amber-300 group-hover:opacity-100 disabled:opacity-50"
          title="Pause auto-reply for this contact for 60 minutes"
        >
          {isPausing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            "Pause"
          )}
        </button>
      )}
      <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums">
        {formatRelative(event.timestamp, now)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WhatsAppPairing({
  tenantId,
  bridgeUrl = "http://localhost:3100",
  onConnected,
  onDisconnected,
  agentAvatarUrl,
  agentName,
}: WhatsAppPairingProps) {
  const toast = useToast();

  const [state, setState] = useState<ConnectionState>("unknown");
  const [stateReason, setStateReason] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  // QR data + expiry. issuedAt + expiresInMs come from the bridge so we
  // can show a countdown and refresh hint without any client-side polling.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrIssuedAt, setQrIssuedAt] = useState<number | null>(null);
  const [qrExpiresInMs, setQrExpiresInMs] = useState<number>(20_000);

  const [botState, setBotState] = useState<BotState | null>(null);
  const [togglingMute, setTogglingMute] = useState(false);
  const [clearingPauses, setClearingPauses] = useState(false);
  const [unmonitoring, setUnmonitoring] = useState<string | null>(null);
  const [pausingContact, setPausingContact] = useState<string | null>(null);

  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [serviceDiagnostics, setServiceDiagnostics] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [sessionDiagnostics, setSessionDiagnostics] = useState<Record<
    string,
    unknown
  > | null>(null);

  // Quick test: prompts the user to send a message from their phone and
  // watches the activity feed for the first inbound message.
  const [testMode, setTestMode] = useState<"idle" | "waiting" | "received">(
    "idle"
  );

  // Has-creds probe. When true, the on-disk auth dir already holds a
  // paired session — the dashboard shows "Reconnect" (idempotent
  // /start that reuses creds) instead of "Pair with QR" so the user
  // doesn't have to scan again after every code restart.
  const [hasCreds, setHasCreds] = useState<boolean | null>(null);

  // Wall-clock ticker so countdowns and "just now" labels update without
  // re-mounting children. 500ms is smooth enough; lower has no benefit.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const testModeRef = useRef(testMode);
  testModeRef.current = testMode;

  // ---- activity helpers ----

  const pushActivity = useCallback((event: Omit<ActivityEvent, "id">) => {
    setActivity((prev) => {
      const id = `${event.timestamp}-${Math.random().toString(36).slice(2, 8)}`;
      const next = [{ ...event, id }, ...prev];
      // Cap at 50; the feed is for context, not full history.
      return next.slice(0, 50);
    });
  }, []);

  // ---- bridge HTTP helpers ----

  const refreshBotState = useCallback(async () => {
    try {
      const res = await fetch(`${bridgeUrl}/session/${tenantId}/bot`, {
        signal: AbortSignal.timeout(3000),
        headers: authHeaders(),
      });
      if (!res.ok) return;
      const data = (await res.json()) as BotState;
      setBotState(data);
    } catch {
      // bridge unreachable — leave state as is, user can hit "refresh"
    }
  }, [bridgeUrl, tenantId]);

  const refreshDiagnostics = useCallback(async () => {
    try {
      const [svc, sess] = await Promise.all([
        fetch(`${bridgeUrl}/diagnostics`, {
          signal: AbortSignal.timeout(3000),
        }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${bridgeUrl}/session/${tenantId}/diagnostics`, {
          signal: AbortSignal.timeout(3000),
          headers: authHeaders(),
        }).then((r) => (r.ok ? r.json() : null)),
      ]);
      setServiceDiagnostics(svc);
      setSessionDiagnostics(sess);
    } catch {
      // best effort
    }
  }, [bridgeUrl, tenantId]);

  // Probe the bridge on mount. Distinguishes:
  //   - bridge unreachable      → bridge_offline
  //   - bridge says auth required and our token is missing/wrong → auth_required
  //   - bridge already paired   → connected (replay from /status)
  //   - bridge reachable, idle  → idle
  const probeBridge = useCallback(async () => {
    setState("unknown");
    try {
      const healthRes = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!healthRes.ok) {
        setState("bridge_offline");
        return;
      }
      const health = (await healthRes.json()) as { authRequired?: boolean };
      if (health.authRequired && !BRIDGE_TOKEN) {
        setState("auth_required");
        setStateReason(
          "Bridge requires NEXT_PUBLIC_LANTERN_BRIDGE_TOKEN to match its LANTERN_BRIDGE_TOKEN."
        );
        return;
      }

      // Probe per-session status. Treat a 401 as auth_required (wrong token).
      const statusRes = await fetch(
        `${bridgeUrl}/session/${tenantId}/status`,
        { signal: AbortSignal.timeout(3000), headers: authHeaders() }
      );
      if (statusRes.status === 401) {
        setState("auth_required");
        setStateReason("Bridge rejected the shared token.");
        return;
      }
      if (!statusRes.ok) {
        setState("idle");
        return;
      }
      const s = (await statusRes.json()) as {
        status: string;
        paired: boolean;
        phoneNumber?: string | null;
        name?: string | null;
      };
      if (s.paired && s.status === "connected") {
        setState("connected");
        setPhoneNumber(s.phoneNumber ?? null);
        setDisplayName(s.name ?? null);
        setConnectedAt(Date.now());
        refreshBotState();
      } else {
        setState("idle");
      }
      refreshDiagnostics();

      // Probe whether the bridge has saved creds on disk. When true,
      // the "idle" CTA shifts from "Pair with QR" to "Reconnect"
      // (idempotent /start that reuses existing creds — no scan).
      try {
        const credsRes = await fetch(
          `${bridgeUrl}/session/${tenantId}/has-creds`,
          { signal: AbortSignal.timeout(3000), headers: authHeaders() }
        );
        if (credsRes.ok) {
          const c = (await credsRes.json()) as { hasCreds?: boolean };
          setHasCreds(!!c.hasCreds);
        } else {
          setHasCreds(false);
        }
      } catch {
        setHasCreds(false);
      }
    } catch {
      setState("bridge_offline");
    }
  }, [bridgeUrl, tenantId, refreshBotState, refreshDiagnostics]);

  useEffect(() => {
    probeBridge();
  }, [probeBridge]);

  // Cleanup WS on unmount or tenant change.
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [tenantId]);

  // ---- WS event handling ----

  const connectWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const wsUrl = bridgeUrl.replace(/^http/, "ws");
    const qs = new URLSearchParams({ tenantId });
    if (BRIDGE_TOKEN) qs.set("token", BRIDGE_TOKEN);
    const ws = new WebSocket(`${wsUrl}/ws?${qs.toString()}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "connection_state": {
            const next = msg.data?.state as ConnectionState | undefined;
            if (next) {
              setState(next);
              setStateReason(msg.data?.reason ?? null);
            }
            break;
          }
          case "qr": {
            setState("qr_ready");
            setQrDataUrl(typeof msg.data === "string" ? msg.data : null);
            setQrIssuedAt(typeof msg.issuedAt === "number" ? msg.issuedAt : Date.now());
            setQrExpiresInMs(
              typeof msg.expiresInMs === "number" ? msg.expiresInMs : 20_000
            );
            break;
          }
          case "connected": {
            setState("connected");
            setQrDataUrl(null);
            setQrIssuedAt(null);
            setPhoneNumber(msg.data?.phoneNumber ?? null);
            setDisplayName(msg.data?.name ?? null);
            setConnectedAt(
              typeof msg.data?.connectedAt === "number"
                ? msg.data.connectedAt
                : Date.now()
            );
            refreshBotState();
            refreshDiagnostics();
            pushActivity({
              kind: "system",
              summary: "Connected to WhatsApp",
              timestamp: Date.now(),
            });
            onConnected?.({
              phoneNumber: msg.data?.phoneNumber ?? "",
              name: msg.data?.name ?? "",
            });
            break;
          }
          case "disconnected": {
            // logged_out is a terminal state; reconnects are transient.
            if (msg.data?.loggedOut) {
              setState("logged_out");
              setStateReason(
                "WhatsApp on your phone unlinked this device. Pair again to continue."
              );
            } else {
              setState((curr) => (curr === "connected" ? "reconnecting" : curr));
            }
            onDisconnected?.();
            break;
          }
          case "error": {
            setState("error");
            setStateReason(msg.data?.message ?? "Bridge returned an error");
            break;
          }
          case "message": {
            const text: string = msg.data?.text ?? "";
            const from: string = msg.data?.from ?? "";
            const push: string | undefined = msg.data?.pushName;
            pushActivity({
              kind: "message_in",
              summary: `${push || from.split("@")[0]} → you`,
              detail: text,
              jid: from,
              pushName: push,
              timestamp:
                typeof msg.data?.timestamp === "number"
                  ? msg.data.timestamp * 1000
                  : Date.now(),
            });
            if (testModeRef.current === "waiting") setTestMode("received");
            break;
          }
          case "agent_reply": {
            const text: string = msg.data?.text ?? "";
            const to: string = msg.data?.to ?? "";
            pushActivity({
              kind: "agent_reply",
              summary: `Agent replied to ${to.split("@")[0]}`,
              detail: text,
              jid: to,
              timestamp:
                typeof msg.data?.timestamp === "number"
                  ? msg.data.timestamp
                  : Date.now(),
            });
            break;
          }
          case "activity": {
            const kind = (msg.data?.kind as ActivityKind) ?? "system";
            pushActivity({
              kind,
              summary: msg.data?.summary ?? "Activity",
              jid: msg.data?.jid,
              pushName: msg.data?.pushName,
              timestamp: msg.data?.timestamp ?? Date.now(),
            });
            // Bot toggles change the BotState — refresh.
            if (
              kind === "bot_on" ||
              kind === "bot_off" ||
              kind === "monitor_on" ||
              kind === "monitor_off" ||
              kind === "contact_paused" ||
              kind === "contact_resumed"
            ) {
              refreshBotState();
            }
            break;
          }
        }
      } catch {
        // malformed event — ignore rather than crash the feed
      }
    };

    ws.onerror = () => {
      setState((curr) =>
        curr === "connected" || curr === "qr_ready" || curr === "starting"
          ? "error"
          : curr
      );
      setStateReason("WebSocket dropped — bridge may have restarted.");
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [bridgeUrl, tenantId, refreshBotState, refreshDiagnostics, onConnected, onDisconnected, pushActivity]);

  // ---- actions ----

  const startPairing = useCallback(async () => {
    setState("starting");
    setStateReason(null);
    setQrDataUrl(null);
    try {
      const res = await fetch(`${bridgeUrl}/session/${tenantId}/start`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.status === 401) {
        setState("auth_required");
        setStateReason("Bridge rejected the shared token.");
        return;
      }
      if (!res.ok) {
        setState("error");
        setStateReason(`Bridge returned ${res.status}`);
        return;
      }
      connectWebSocket();
    } catch (err) {
      setState("error");
      setStateReason(err instanceof Error ? err.message : "Failed to start session");
    }
  }, [bridgeUrl, tenantId, connectWebSocket]);

  const handleDisconnect = useCallback(async () => {
    try {
      await fetch(`${bridgeUrl}/session/${tenantId}/disconnect`, {
        method: "POST",
        headers: authHeaders(),
      });
    } catch {
      // best effort
    }
    wsRef.current?.close();
    wsRef.current = null;
    setState("idle");
    setQrDataUrl(null);
    setPhoneNumber(null);
    setDisplayName(null);
    setConnectedAt(null);
    setBotState(null);
    setActivity([]);
    onDisconnected?.();
    toast.info("Disconnected from WhatsApp");
  }, [bridgeUrl, tenantId, onDisconnected, toast]);

  // handleReset is "disconnect + wipe credentials so the next pair is
  // fresh". Without this the bridge silently reconnects to the previously
  // paired phone number — confusing if the user wanted to pair a different
  // account. Confirmed before firing because it's destructive.
  const handleReset = useCallback(async () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        "Forget this WhatsApp device? You'll need to scan a new QR code on your phone to pair again."
      )
    ) {
      return;
    }
    try {
      await fetch(`${bridgeUrl}/session/${tenantId}/reset`, {
        method: "POST",
        headers: authHeaders(),
      });
    } catch {
      // best effort
    }
    wsRef.current?.close();
    wsRef.current = null;
    setState("idle");
    setQrDataUrl(null);
    setPhoneNumber(null);
    setDisplayName(null);
    setConnectedAt(null);
    setBotState(null);
    setActivity([]);
    onDisconnected?.();
    toast.success("Device forgotten. Click Pair to start fresh.");
  }, [bridgeUrl, tenantId, onDisconnected, toast]);

  const toggleMute = useCallback(async () => {
    if (!botState) return;
    setTogglingMute(true);
    const path = botState.muted ? "unmute" : "mute";
    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/bot/${path}`,
        { method: "POST", headers: authHeaders() }
      );
      if (res.ok) setBotState(await res.json());
    } finally {
      setTogglingMute(false);
    }
  }, [bridgeUrl, tenantId, botState]);

  const clearAllPauses = useCallback(async () => {
    if (!botState || Object.keys(botState.paused).length === 0) return;
    setClearingPauses(true);
    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/bot/resume-all`,
        { method: "POST", headers: authHeaders() }
      );
      if (res.ok) {
        const data = (await res.json()) as BotState & { cleared?: number };
        setBotState(data);
        if (data.cleared) toast.success(`Resumed ${data.cleared} paused contacts`);
      }
    } finally {
      setClearingPauses(false);
    }
  }, [bridgeUrl, tenantId, botState, toast]);

  const unmonitorGroup = useCallback(
    async (jid: string) => {
      setUnmonitoring(jid);
      try {
        const res = await fetch(
          `${bridgeUrl}/session/${tenantId}/bot/group/unmonitor`,
          {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ jid }),
          }
        );
        if (res.ok) setBotState(await res.json());
      } finally {
        setUnmonitoring(null);
      }
    },
    [bridgeUrl, tenantId]
  );

  // Monitor a group — same shape as unmonitor. Used by the searchable
  // group picker so users can toggle groups in/out from the dashboard
  // without ever needing the in-group /bot monitor on (which doesn't
  // reliably propagate to the bridge for accounts in many groups).
  const monitorGroup = useCallback(
    async (jid: string) => {
      setUnmonitoring(jid); // reuse the spinner state — only one in flight at a time
      try {
        const res = await fetch(
          `${bridgeUrl}/session/${tenantId}/bot/group/monitor`,
          {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ jid }),
          }
        );
        if (res.ok) setBotState(await res.json());
      } finally {
        setUnmonitoring(null);
      }
    },
    [bridgeUrl, tenantId]
  );

  // All groups the bridge can see (not just the monitored ones), with
  // friendly names + participant counts. Powers the searchable picker.
  // Refreshed on connect + every 30s while the modal is open so newly-
  // joined groups appear without a manual refresh.
  type GroupRow = { jid: string; name: string; participants: number; monitored: boolean };
  const [allGroups, setAllGroups] = useState<GroupRow[] | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const refreshAllGroups = useCallback(async () => {
    if (state !== "connected") return;
    setGroupsLoading(true);
    try {
      const res = await fetch(`${bridgeUrl}/session/${tenantId}/groups`, {
        headers: authHeaders(),
      });
      if (res.ok) {
        const body = (await res.json()) as { groups?: GroupRow[] };
        setAllGroups(body.groups ?? []);
      }
    } catch {
      // best effort — the existing monitored-only list still renders.
    } finally {
      setGroupsLoading(false);
    }
  }, [bridgeUrl, tenantId, state]);
  useEffect(() => {
    if (state !== "connected") return;
    void refreshAllGroups();
    const id = setInterval(refreshAllGroups, 30_000);
    return () => clearInterval(id);
  }, [state, refreshAllGroups]);

  // Pause auto-reply for a single contact for 60 minutes — the WATI pattern.
  // Triggered from the per-message "Pause" button in the activity feed,
  // which is *where* the user notices they want the bot to stop replying
  // ("my wife just texted, agent shouldn't take over").
  const pauseContact = useCallback(
    async (jid: string) => {
      setPausingContact(jid);
      try {
        const res = await fetch(
          `${bridgeUrl}/session/${tenantId}/bot/pause`,
          {
            method: "POST",
            headers: authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ jid, ttlMs: 60 * 60 * 1000 }),
          }
        );
        if (res.ok) {
          setBotState(await res.json());
          toast.success(`Paused auto-reply for ${jid.split("@")[0]} (60 min)`);
        }
      } finally {
        setPausingContact(null);
      }
    },
    [bridgeUrl, tenantId, toast]
  );

  // ---- derived ----

  const stage = STATE_TO_STAGE[state];
  const qrExpiresAt = qrIssuedAt ? qrIssuedAt + qrExpiresInMs : null;
  const qrRemainingMs = qrExpiresAt ? Math.max(0, qrExpiresAt - now) : 0;
  const qrRemainingSec = Math.ceil(qrRemainingMs / 1000);
  const qrProgress = qrExpiresAt
    ? Math.min(1, Math.max(0, (qrExpiresAt - now) / qrExpiresInMs))
    : 0;

  const pausedCount = botState ? Object.keys(botState.paused).length : 0;
  const groups = botState?.monitoredGroups ?? [];
  const uptime = connectedAt ? now - connectedAt : 0;

  // Liveness + latency derived from the activity stream. The bridge tags
  // each agent_reply with a burstIndex so we can correlate the *first*
  // reply of each burst with the preceding inbound to compute response
  // time. Median over the last 10 pairs gives a stable badge value.
  const lastActivityAt = useMemo(() => {
    return activity.length > 0 ? activity[0].timestamp : null;
  }, [activity]);

  const medianLatencyMs = useMemo(() => {
    const pairs: number[] = [];
    // activity is newest-first; walk it pairing each agent_reply with the
    // closest preceding (older) message_in event.
    for (let i = 0; i < activity.length; i++) {
      const ev = activity[i];
      if (ev.kind !== "agent_reply") continue;
      // Find the next-older message_in to this jid.
      for (let j = i + 1; j < activity.length; j++) {
        const prev = activity[j];
        if (prev.kind !== "message_in") continue;
        if (prev.jid && ev.jid && prev.jid !== ev.jid) continue;
        const delta = ev.timestamp - prev.timestamp;
        if (delta > 0 && delta < 5 * 60_000) pairs.push(delta);
        break;
      }
      if (pairs.length >= 10) break;
    }
    if (pairs.length === 0) return null;
    const sorted = pairs.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }, [activity]);

  // ===========================================================================
  // Render
  // ===========================================================================

  return (
    <div className="space-y-4">
      {/* Stepper header */}
      <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-surface-1 px-4 py-3">
        <Stepper stage={stage} error={state === "error" || state === "logged_out"} />
        <StatePill state={state} />
      </div>

      {/* State-specific body */}
      {state === "unknown" && (
        <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-surface-1 p-4">
          <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
          <p className="text-xs text-zinc-500">Checking WhatsApp bridge…</p>
        </div>
      )}

      {state === "bridge_offline" && (
        <div className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-red-200">
                WhatsApp bridge isn&apos;t running on{" "}
                <code className="rounded bg-surface-0 px-1 text-zinc-300">{bridgeUrl}</code>
              </p>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                Start the bridge service in a terminal from the repo root:
              </p>
              <CopyableCommand cmd="make run-whatsapp-bridge" />
              <p className="text-[11px] leading-relaxed text-zinc-500">
                The bridge listens on <code className="text-zinc-400">:3100</code> and runs on
                your machine — your WhatsApp credentials never leave this host.
              </p>
            </div>
          </div>
          <Button onClick={probeBridge} icon={<RefreshCw className="h-3 w-3" />} size="sm">
            Check again
          </Button>
        </div>
      )}

      {state === "auth_required" && (
        <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-amber-200">Bridge requires a shared token</p>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                {stateReason ?? "Add the token to your dashboard env and reload."}
              </p>
              <CopyableCommand cmd="NEXT_PUBLIC_LANTERN_BRIDGE_TOKEN=<same as bridge LANTERN_BRIDGE_TOKEN>" />
            </div>
          </div>
          <Button onClick={probeBridge} icon={<RefreshCw className="h-3 w-3" />} size="sm">
            Check again
          </Button>
        </div>
      )}

      {state === "idle" && (
        <div className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
              {hasCreds ? (
                <RefreshCw className="h-4 w-4 text-emerald-400" />
              ) : (
                <Smartphone className="h-4 w-4 text-emerald-400" />
              )}
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-zinc-100">
                {hasCreds ? "Reconnect to your paired WhatsApp" : "Pair your WhatsApp to start"}
              </p>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                {hasCreds
                  ? <>This Mac is already paired — click to resume the existing session. No QR scan needed. Auth lives in <code className="text-zinc-300">auth_sessions/{tenantId}/</code>.</>
                  : <>Generates a QR code you scan from your phone — same flow as WhatsApp Web. Auth stays local in <code className="text-zinc-300">auth_sessions/{tenantId}/</code>.</>
                }
              </p>
            </div>
          </div>
          <Button
            onClick={startPairing}
            variant="primary"
            size="md"
            icon={hasCreds ? <RefreshCw className="h-3.5 w-3.5" /> : <Smartphone className="h-3.5 w-3.5" />}
          >
            {hasCreds ? "Reconnect" : "Pair with QR code"}
          </Button>
        </div>
      )}

      {(state === "starting" || state === "qr_ready" || state === "connecting") && (
        <PairingPanel
          state={state}
          qrDataUrl={qrDataUrl}
          qrRemainingSec={qrRemainingSec}
          qrProgress={qrProgress}
          onCancel={handleDisconnect}
          onRestart={startPairing}
          tenantId={tenantId}
        />
      )}

      {state === "reconnecting" && (
        <div className="space-y-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-amber-300" />
            <p className="text-sm font-medium text-amber-200">Reconnecting to WhatsApp…</p>
          </div>
          {stateReason && (
            <p className="text-[11px] text-zinc-500">{stateReason}</p>
          )}
        </div>
      )}

      {state === "logged_out" && (
        <div className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <LogOut className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-red-200">Device unlinked from WhatsApp</p>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                {stateReason ??
                  "Your phone unlinked this Linked Device. Pair again to continue."}
              </p>
            </div>
          </div>
          <Button onClick={startPairing} variant="primary" size="sm" icon={<RefreshCw className="h-3 w-3" />}>
            Pair again
          </Button>
        </div>
      )}

      {state === "conflict" && (
        <div className="space-y-3 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="space-y-2">
              <p className="text-sm font-medium text-amber-200">
                Another WhatsApp Web session is active
              </p>
              <p className="text-[12px] leading-relaxed text-zinc-400">
                Your WhatsApp account can only be linked to one web session
                at a time and something else is currently holding the slot,
                kicking the bridge off every reconnect. Close it before
                retrying:
              </p>
              <ol className="ml-4 list-decimal space-y-1 text-[12px] text-zinc-400">
                <li>
                  Close any <code className="rounded bg-surface-2 px-1 text-zinc-300">web.whatsapp.com</code> browser tabs.
                </li>
                <li>
                  On your phone: WhatsApp → Settings → Linked Devices → tap
                  any unrecognized device → Log Out.
                </li>
                <li>Then click Retry below.</li>
              </ol>
            </div>
          </div>
          <Button onClick={startPairing} variant="primary" size="sm" icon={<RefreshCw className="h-3 w-3" />}>
            Retry connection
          </Button>
        </div>
      )}

      {state === "error" && (
        <div className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-red-200">Connection failed</p>
              {stateReason && (
                <p className="break-words text-[12px] text-zinc-400">{stateReason}</p>
              )}
            </div>
          </div>
          <Button onClick={startPairing} icon={<RefreshCw className="h-3 w-3" />} size="sm">
            Try again
          </Button>
        </div>
      )}

      {state === "connected" && (
        <>
          <ConnectedPanel
            phoneNumber={phoneNumber}
            displayName={displayName}
            uptime={uptime}
            lastActivityAt={lastActivityAt}
            medianLatencyMs={medianLatencyMs}
            botState={botState}
            pausedCount={pausedCount}
            groups={groups}
            activity={activity}
            now={now}
            togglingMute={togglingMute}
            clearingPauses={clearingPauses}
            unmonitoring={unmonitoring}
            pausingContact={pausingContact}
            testMode={testMode}
            onToggleMute={toggleMute}
            onClearAll={clearAllPauses}
            onUnmonitor={unmonitorGroup}
            onMonitor={monitorGroup}
            onPauseContact={pauseContact}
            onDisconnect={handleDisconnect}
            onStartTest={() => setTestMode("waiting")}
            onClearTest={() => setTestMode("idle")}
            allGroups={allGroups}
            groupsLoading={groupsLoading}
            onRefreshGroups={refreshAllGroups}
            agentAvatarUrl={agentAvatarUrl}
            agentName={agentName}
          />

          {/* Mobile commands — the killer feature for verifying bridge
              health without leaving WhatsApp. Each row is a command the
              user can send to their own chat, with a one-line description
              of what it does + what it replies. */}
          <section className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
            <header className="mb-3 flex items-center gap-2">
              <span className="text-base">📱</span>
              <h3 className="text-sm font-semibold text-zinc-100">
                Check from your phone
              </h3>
              <span className="text-[11px] text-zinc-500">
                · text these to yourself anytime
              </span>
            </header>
            <ul className="space-y-2 text-[12px]">
              {[
                { cmd: "/lantern status", what: "Bridge uptime, agent state, last error if any." },
                { cmd: "/lantern ping", what: "Quickest health check — replies with 🏓 reaction." },
                { cmd: "/lantern help", what: "Full command reference, replied as a self-message." },
                { cmd: "/bot off", what: "Silence the agent everywhere (or in a specific thread)." },
                { cmd: "/bot on", what: "Un-silence — works alongside /bot off." },
                { cmd: "/bot status", what: "Mute state + paused-contacts + monitored-groups counts." },
              ].map((row) => (
                <li
                  key={row.cmd}
                  className="flex items-start gap-3 rounded-lg border border-zinc-800/60 bg-surface-2/40 px-3 py-2"
                >
                  <code className="shrink-0 rounded bg-surface-3 px-2 py-0.5 font-mono text-[11px] text-lantern-300">
                    {row.cmd}
                  </code>
                  <span className="text-zinc-400">{row.what}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-zinc-500">
              These commands work in your self-chat. The bridge reacts with
              an emoji so you know it received them even when offline.
            </p>
          </section>

          {/* Danger zone: forget device. Distinct from Disconnect — wipes
              the on-disk auth credentials so the next pair issues a fresh
              QR. Required when switching to a different WhatsApp number. */}
          <section className="rounded-xl border border-red-500/15 bg-red-500/[0.03] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-red-300">Forget this device</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
                  Wipes the stored WhatsApp credentials. The next time you
                  pair, you'll get a fresh QR — use this to switch to a
                  different WhatsApp account, or if your current session is
                  stuck in a conflict loop.
                </p>
              </div>
              <Button
                onClick={handleReset}
                variant="danger"
                size="sm"
                icon={<Trash2 className="h-3 w-3" />}
              >
                Forget device
              </Button>
            </div>
          </section>
        </>
      )}

      {/* Diagnostics expander — always available so support can grab data
          even from the success path. */}
      <details
        open={diagnosticsOpen}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setDiagnosticsOpen(open);
          if (open) refreshDiagnostics();
        }}
        className="rounded-xl border border-zinc-800 bg-surface-1"
      >
        <summary className="flex cursor-pointer items-center justify-between px-4 py-2.5 text-[12px] text-zinc-400 hover:text-zinc-200">
          <span className="inline-flex items-center gap-2">
            {diagnosticsOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Diagnostics
          </span>
          <span className="text-[11px] text-zinc-600">
            tenant <code className="text-zinc-400">{tenantId.slice(0, 8)}…</code>
          </span>
        </summary>
        <div className="space-y-2 border-t border-zinc-800 px-4 py-3 text-[11px] text-zinc-400">
          <DiagRow label="Bridge URL" value={bridgeUrl} />
          <DiagRow label="State" value={`${state}${stateReason ? ` — ${stateReason}` : ""}`} />
          <DiagRow
            label="Bridge version"
            value={(serviceDiagnostics?.version as string | undefined) ?? "?"}
          />
          <DiagRow
            label="Bridge uptime"
            value={
              serviceDiagnostics?.uptimeMs != null
                ? formatUptime(Number(serviceDiagnostics.uptimeMs))
                : "?"
            }
          />
          <DiagRow
            label="Token required"
            value={
              serviceDiagnostics?.authRequired
                ? `yes ${BRIDGE_TOKEN ? "(configured)" : "(missing in dashboard)"}`
                : "no"
            }
          />
          <DiagRow
            label="Control-plane heartbeat"
            value={serviceDiagnostics?.controlPlaneHeartbeat ? "enabled" : "disabled"}
          />
          <DiagRow
            label="Agent auto-reply"
            value={serviceDiagnostics?.agentEnabled ? "enabled" : "disabled (set LANTERN_API_TOKEN on bridge)"}
          />
          {sessionDiagnostics?.lastError ? (
            <DiagRow
              label="Last error"
              value={String(sessionDiagnostics.lastError)}
            />
          ) : null}
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-panels
// ---------------------------------------------------------------------------

function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className="text-right text-zinc-300 break-words">{value}</span>
    </div>
  );
}

function PairingPanel({
  state,
  qrDataUrl,
  qrRemainingSec,
  qrProgress,
  onCancel,
  onRestart,
  tenantId,
}: {
  state: ConnectionState;
  qrDataUrl: string | null;
  qrRemainingSec: number;
  qrProgress: number;
  onCancel: () => void;
  onRestart: () => void;
  tenantId: string;
}) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * qrProgress;

  return (
    <div className="rounded-xl border border-zinc-800 bg-surface-1 p-5">
      <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
        {/* QR / spinner */}
        <div className="flex shrink-0 flex-col items-center gap-2">
          <div className="relative">
            <div className="rounded-2xl border border-zinc-800 bg-white p-3">
              {qrDataUrl && state === "qr_ready" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={qrDataUrl}
                  alt="WhatsApp pairing QR code"
                  width={224}
                  height={224}
                  className="block h-56 w-56"
                />
              ) : (
                <div className="flex h-56 w-56 flex-col items-center justify-center gap-2 text-zinc-500">
                  <Loader2 className="h-6 w-6 animate-spin" />
                  <span className="text-[11px]">
                    {state === "connecting" ? "Finishing up…" : "Generating QR…"}
                  </span>
                </div>
              )}
              {state === "qr_ready" && qrRemainingSec > 0 && (
                <div className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold text-white">
                  <svg width="14" height="14" viewBox="0 0 50 50" className="-rotate-90">
                    <circle
                      cx="25"
                      cy="25"
                      r={radius}
                      fill="none"
                      stroke="rgba(255,255,255,0.2)"
                      strokeWidth="4"
                    />
                    <circle
                      cx="25"
                      cy="25"
                      r={radius}
                      fill="none"
                      stroke="#a78bfa"
                      strokeWidth="4"
                      strokeDasharray={circumference}
                      strokeDashoffset={circumference - dash}
                      strokeLinecap="round"
                    />
                  </svg>
                  {qrRemainingSec}s
                </div>
              )}
            </div>
          </div>
          <p className="text-[10px] text-zinc-500">
            Auto-refreshes if the code expires
          </p>
        </div>

        {/* Instructions */}
        <div className="min-w-0 flex-1 space-y-3">
          <h3 className="text-sm font-semibold text-zinc-100">
            Scan with your phone
          </h3>
          <ol className="space-y-2 text-[12px] leading-relaxed text-zinc-300">
            <li className="flex gap-2">
              <span className="font-semibold text-lantern-400">1.</span>
              Open <span className="font-medium">WhatsApp</span> on your phone.
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-lantern-400">2.</span>
              Tap <span className="font-medium">⋮</span> or{" "}
              <span className="font-medium">Settings</span>, then{" "}
              <span className="font-medium">Linked devices</span>.
            </li>
            <li className="flex gap-2">
              <span className="font-semibold text-lantern-400">3.</span>
              Tap <span className="font-medium">Link a device</span> and point your camera here.
            </li>
          </ol>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw className="h-3 w-3" />}
              onClick={onRestart}
            >
              Refresh code
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
          <p className="pt-2 text-[11px] leading-relaxed text-zinc-500">
            Pairing creates a Linked Device under your WhatsApp account — same as
            WhatsApp Web. You can unlink it at any time from your phone or with
            the Disconnect button after pairing.
          </p>
        </div>
      </div>
    </div>
  );
}

function ConnectedPanel({
  phoneNumber,
  displayName,
  uptime,
  lastActivityAt,
  medianLatencyMs,
  botState,
  pausedCount,
  groups,
  activity,
  now,
  togglingMute,
  clearingPauses,
  unmonitoring,
  pausingContact,
  testMode,
  onToggleMute,
  onClearAll,
  onUnmonitor,
  onMonitor,
  onPauseContact,
  onDisconnect,
  onStartTest,
  onClearTest,
  allGroups,
  groupsLoading,
  onRefreshGroups,
  agentAvatarUrl,
  agentName,
}: {
  phoneNumber: string | null;
  displayName: string | null;
  uptime: number;
  lastActivityAt: number | null;
  medianLatencyMs: number | null;
  botState: BotState | null;
  pausedCount: number;
  groups: string[];
  activity: ActivityEvent[];
  now: number;
  togglingMute: boolean;
  clearingPauses: boolean;
  unmonitoring: string | null;
  pausingContact: string | null;
  testMode: "idle" | "waiting" | "received";
  onToggleMute: () => void;
  onClearAll: () => void;
  onUnmonitor: (jid: string) => void;
  onMonitor: (jid: string) => void;
  onPauseContact: (jid: string) => void;
  onDisconnect: () => void;
  onStartTest: () => void;
  onClearTest: () => void;
  // All groups the bridge can see — for the searchable picker.
  // Null while the first fetch is in flight; [] when there are no groups.
  allGroups: Array<{ jid: string; name: string; participants: number; monitored: boolean }> | null;
  groupsLoading: boolean;
  onRefreshGroups: () => void;
  agentAvatarUrl?: string;
  agentName?: string;
}) {
  const muted = botState?.muted ?? false;
  const initials = useMemo(
    () => initialsFor(displayName, phoneNumber),
    [displayName, phoneNumber]
  );
  // Latency badge — shown only after we have at least one inbound→reply
  // pair. Sub-second times are rendered as "1.4s" not "1408ms" so the
  // number reads at a glance.
  const latencyLabel = medianLatencyMs != null
    ? medianLatencyMs < 10_000
      ? `${(medianLatencyMs / 1000).toFixed(1)}s`
      : `${Math.round(medianLatencyMs / 1000)}s`
    : null;

  return (
    <div className="space-y-4">
      {/* Identity card — single line on desktop, wraps on mobile. The
          row is built to compress: avatar | name+phone+uptime | latency
          + last-active badges | disconnect. */}
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-sm font-semibold text-emerald-300">
              {initials}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-zinc-100">
                {displayName || "WhatsApp account"}
              </p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-zinc-400">
                <span>{phoneNumber ? `+${phoneNumber}` : "Phone number unavailable"}</span>
                <span className="text-zinc-700">·</span>
                <span>paired {formatUptime(uptime)} ago</span>
                {latencyLabel && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <span title="Median reply latency (inbound → first agent reply)">
                      reply p50 <span className="font-semibold text-zinc-200">{latencyLabel}</span>
                    </span>
                  </>
                )}
                {lastActivityAt && (
                  <>
                    <span className="text-zinc-700">·</span>
                    <span title="Most recent message or agent action">
                      last activity {formatRelative(lastActivityAt, now)}
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>
          <Button
            onClick={onDisconnect}
            variant="danger"
            size="sm"
            icon={<Power className="h-3 w-3" />}
          >
            Disconnect
          </Button>
        </div>
      </div>

      {/* Bot controls + monitored groups side-by-side on wider screens */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-zinc-200">Auto-reply</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {muted
                  ? "Silent for every contact."
                  : pausedCount > 0
                    ? `Active — paused for ${pausedCount} contact${pausedCount === 1 ? "" : "s"}.`
                    : "Replying to every inbound DM."}
              </p>
            </div>
            <button
              onClick={onToggleMute}
              disabled={togglingMute}
              className={clsx(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                muted ? "bg-zinc-700" : "bg-emerald-500"
              )}
              aria-label={muted ? "Turn auto-reply on" : "Turn auto-reply off"}
            >
              <span
                className={clsx(
                  "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                  muted ? "translate-x-1" : "translate-x-6"
                )}
              />
            </button>
          </div>
          {pausedCount > 0 && (
            <Button
              onClick={onClearAll}
              loading={clearingPauses}
              size="sm"
              variant="secondary"
              className="mt-3"
              icon={<Play className="h-3 w-3" />}
            >
              Resume all {pausedCount} paused
            </Button>
          )}
        </div>

        <GroupPicker
          monitoredCount={groups.length}
          allGroups={allGroups}
          loading={groupsLoading}
          togglingJid={unmonitoring}
          onToggle={(jid, isMonitored) => isMonitored ? onUnmonitor(jid) : onMonitor(jid)}
          onRefresh={onRefreshGroups}
        />
      </div>

      {/* Send-test card — sticks until first inbound message arrives */}
      <div className="rounded-xl border border-zinc-800 bg-surface-1 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <p className="text-[12px] font-semibold text-zinc-200">Send a test message</p>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              {testMode === "idle" &&
                "Send any message to your own WhatsApp number to confirm the bridge is receiving."}
              {testMode === "waiting" && (
                <>
                  Send <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot status</code>{" "}
                  to <span className="font-medium text-zinc-300">Message Yourself</span> in
                  WhatsApp — I&apos;ll watch for it.
                </>
              )}
              {testMode === "received" && (
                <span className="text-emerald-300">
                  Got it — message received end-to-end.
                </span>
              )}
            </p>
          </div>
          {testMode === "idle" && (
            <Button size="sm" variant="secondary" onClick={onStartTest}>
              Start
            </Button>
          )}
          {testMode === "waiting" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-lantern-500/10 px-2 py-1 text-[11px] font-medium text-lantern-300">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting
            </span>
          )}
          {testMode === "received" && (
            <Button size="sm" variant="ghost" onClick={onClearTest}>
              Done
            </Button>
          )}
        </div>
      </div>

      {/* Activity feed */}
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-surface-1">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <p className="text-[12px] font-semibold text-zinc-200">Live activity</p>
          <span className="text-[10px] text-zinc-600">
            Streaming · last {activity.length}
          </span>
        </div>
        {activity.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-[12px] text-zinc-500">
              No activity yet — messages, agent replies, and bot commands will appear here.
            </p>
          </div>
        ) : (
          <ul className="max-h-72 divide-y divide-zinc-800 overflow-y-auto">
            {activity.map((ev) => (
              <ActivityRow
                key={ev.id}
                event={ev}
                now={now}
                onPauseContact={onPauseContact}
                pausing={pausingContact}
                agentAvatarUrl={agentAvatarUrl}
                agentName={agentName}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Cheat sheet — small, foldable */}
      <details className="rounded-xl border border-zinc-800 bg-surface-1">
        <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-zinc-400 hover:text-zinc-200">
          Quick commands (from your phone)
        </summary>
        <div className="space-y-1.5 border-t border-zinc-800 px-4 py-3 text-[11px] leading-relaxed text-zinc-400">
          <p>
            In <span className="font-medium text-zinc-300">Message Yourself</span>:{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot off</code> ·{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot on</code> ·{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot status</code>
          </p>
          <p>
            In any friend&apos;s thread:{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot off</code> ·{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot on</code>{" "}
            (per-contact). Typing any reply auto-pauses the bot for that contact for 60 min.
          </p>
          <p>
            In any group:{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot monitor on</code>{" "}
            ·{" "}
            <code className="rounded bg-surface-0 px-1 text-zinc-300">/bot monitor off</code>
          </p>
        </div>
      </details>
    </div>
  );
}
