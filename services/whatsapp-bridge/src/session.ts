import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys";
import { Boom } from "@hapi/boom";
import { WebSocket } from "ws";
import * as QRCode from "qrcode";
import { join } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import type { Logger } from "pino";
import { AgentClient } from "@lantern/bridge-core/agent";
import { AttentionClassifier } from "./attention.js";
import { authedFetch } from "@lantern/bridge-core/auth";
import { MediaHandler } from "./media.js";
import { PersonalClient } from "@lantern/bridge-core/personal";
import { CalendarLookup, needsCalendar } from "@lantern/bridge-core/calendar";
import {
  agentPersonaPrompt,
  defaultQuietHours,
  detectEscalation,
  inferStyle,
  isQuietHours,
  naturalize,
  shouldRespond,
} from "@lantern/bridge-core/natural";
import { parseNLCommand, type ParsedCommand } from "@lantern/bridge-core/nl-commands";
import { executeCommand } from "@lantern/bridge-core/command-executor";
import { parseVoiceCommand } from "@lantern/bridge-core/voice-commands";
import { reactionToAction, dispatchReaction } from "@lantern/bridge-core/reaction-commands";
import { scheduleDigest, defaultDigestConfig } from "@lantern/bridge-core/daily-digest";
import { OfflineMonitor, defaultOfflineMonitorConfig } from "@lantern/bridge-core/offline-monitor";
import { EmailMirror } from "@lantern/bridge-core/email-mirror";
import {
  PersonalDocs,
  defaultPersonalDocsConfig,
  looksLikeDocQuery,
  extractAttachMarkers,
} from "@lantern/bridge-core/personal-docs";
import { MacActions, extractActionMarkers } from "@lantern/bridge-core/mac-actions";
import { humanizeWithOffer, looksLikeConfirmation, type PendingOffer } from "@lantern/bridge-core/humanize";
import { extname } from "path";

// MIME map for sendDocument — WhatsApp's UI shows a file-type icon
// based on this. Falls back to application/octet-stream for unknown.
const MIME_FOR_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".rtf": "application/rtf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
};
import type { BotState } from "./types.js";

// Display name for the bot-owner used in attention prompts and log lines.
// Configurable so the classifier doesn't hardcode a single user's name.
const OWNER_NAME = process.env.LANTERN_OWNER_NAME || "the owner";

// Normalize a WhatsApp JID for comparison: strip the optional
// ":<device>" suffix from the id portion. Incoming msg.key.remoteJid
// usually omits the device, but multi-device sync can include it.
function normWaJid(jid: string): string {
  if (!jid) return "";
  const [id, server] = jid.split("@");
  return `${id.split(":")[0]}@${server || ""}`;
}

// Conservative estimate of how long a Baileys-issued QR stays scannable
// before WhatsApp's server rotates it. Baileys re-emits a new QR string
// when the previous one expires, so this is purely a UI hint for the
// dashboard's countdown ring; the bridge does not enforce it.
const QR_VALID_MS = 20_000;

const PAUSE_TTL_MS =
  Math.max(1, Number(process.env.LANTERN_AGENT_PAUSE_MIN) || 60) * 60_000;
// Explicit `/bot off` in a contact thread pauses that contact for a year —
// effectively indefinite until the owner sends `/bot on` there.
const INDEFINITE_MS = 365 * 24 * 60 * 60_000;

// Grace-period notification tuning. When a takeover pause is about to expire
// and the agent is about to resume auto-replying, we DM the owner at
// `until - PAUSE_WARN_LEAD_MS` so they can reply again (extending the pause)
// or type `/bot off` (converting to indefinite) before the agent kicks back
// in. The ticker fires on a fixed interval and buffers fires into a single
// batched message so a burst of concurrent expiries becomes one DM, not N.
const PAUSE_WARN_LEAD_MS = 5 * 60_000;
const PAUSE_WARN_FLUSH_MS = 30_000;
const PAUSE_TICK_MS = 30_000;

/**
 * Per-contact pause metadata. Kept richer than a bare epoch-ms so we can
 * render friendly names in grace-period warnings and avoid re-warning the
 * same pause twice. `warned` is reset every time the pause is extended.
 */
type PauseEntry = {
  until: number;
  pushName?: string;
  warned: boolean;
};

// Promise-returning setTimeout. Used by the natural-reply pacer to
// space out burst messages and to honor the per-message typing delay.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the process alive solely for these — graceful shutdown
    // can drop in-flight bursts safely; the next inbound retriggers.
    t.unref?.();
  });
}

// Render a small list of names with an overflow tail so the DM never becomes
// a wall of text. 3 names stay inline; everything beyond becomes "(+N more)".
function formatNameList(names: string[]): string {
  if (names.length <= 3) return names.join(", ");
  const head = names.slice(0, 3).join(", ");
  const extra = names.length - 3;
  return `${head} (+${extra} more)`;
}

// Short human-readable duration. Used by /lantern status replies so the
// uptime line ('2h 14m', '37s') is glanceable on a phone screen.
function formatUptimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Named connection states surfaced to the dashboard. The bridge owns the
// transitions; the dashboard renders them. Keep this list in sync with the
// `ConnectionState` type in apps/web/components/whatsapp-pairing.tsx.
export type ConnectionState =
  | "idle"
  | "starting"
  | "qr_ready"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  // Terminal: another WhatsApp Web session is active for this account
  // and keeps kicking us off. Reconnecting is futile until the user
  // closes the other session — the dashboard renders this as an
  // actionable "close other sessions" prompt rather than spinning forever.
  | "conflict"
  | "error";

export class WhatsAppSession {
  private tenantId: string;
  private logger: Logger;
  private agent: AgentClient;
  private docs: PersonalDocs | null = null;
  private macActions: MacActions | null = null;
  // Per-chat cache of the most recent offer (humanize follow-up).
  // On next-turn "yes" we execute it deterministically — bypasses
  // LLM hallucination where it claims an action happened without
  // emitting a marker.
  private pendingOffers: Map<string, PendingOffer> = new Map();
  private static readonly OFFER_TTL_MS = 10 * 60_000;
  private attention: AttentionClassifier;
  private media: MediaHandler;
  private personal: PersonalClient;
  private calendar: CalendarLookup;
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private listeners: Set<WebSocket> = new Set();
  private currentQR: string | null = null;
  // Wall-clock at which currentQR was generated; used so the dashboard
  // can render a countdown ring without having to ping for refreshes.
  private qrIssuedAt: number | null = null;
  private connected = false;
  private paired = false;
  private phoneNumber: string | null = null;
  private displayName: string | null = null;
  private authDir: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  // Decrypt-storm watchdog. When the Signal pre-key state corrupts
  // (bridge killed mid-write, multi-process race, etc.), Baileys's
  // libsignal logs continuous "failed to decrypt message" errors at
  // level=50. The bridge reports "connected" but receives ZERO
  // messages that reach messages.upsert because every inbound dies
  // in decryption. We hook the logger to count these errors and
  // force a socket-level reconnect when the storm crosses threshold.
  // Reconnect renegotiates the Signal session with WhatsApp and
  // clears most transient corruption without a full re-pair.
  private decryptErrorCount = 0;
  private decryptErrorWindowStart = Date.now();
  private static readonly DECRYPT_STORM_THRESHOLD = 20;
  private static readonly DECRYPT_STORM_WINDOW_MS = 60_000;
  private selfHealing = false;
  private lastSuccessfulInboundAt = 0;
  // Lifecycle telemetry surfaced via getDiagnostics() and the WS
  // `connection_state` event. lastError carries the most recent failure
  // reason (close code, exception message) so the dashboard can show a
  // specific recovery hint rather than a generic "connection failed".
  private startedAt = Date.now();
  private connectionState: ConnectionState = "idle";
  private lastStateChangeAt = Date.now();
  private lastError: string | null = null;
  private lastConnectionEventAt: number | null = null;
  // jid -> PauseEntry. Set whenever the owner types into a thread from their
  // own phone; suppresses the agent until it expires or the owner sends
  // "/bot on". We keep pushName on the entry so we can render friendly
  // grace-period warnings without relying on a separate contact cache.
  private pausedUntil: Map<string, PauseEntry> = new Map();
  // Global kill switch. Toggled via self-chat `/bot off`/`/bot on`,
  // via dashboard, or via REST.
  private muted = false;
  // Personal-docs Q&A toggle. Default ON. Owner toggles from
  // self-chat ("docs on" / "docs off"). Persisted.
  private personalDocsEnabled = true;
  // Master kill switch — separate from `muted`. Survives restart.
  // When ENGAGED the bridge ignores every inbound except a
  // "kill switch off" command from the owner's self-chat.
  private killSwitch = false;
  private stateFile: string;
  // Opted-in group JIDs. Groups not in this set are ignored entirely; in
  // opted-in groups the agent runs the attention classifier on every message
  // and auto-replies only when the owner is @mentioned or quoted.
  private monitoredGroups: Set<string> = new Set();
  // msg.key.id -> epoch_ms when the id was added. We suppress the echo that
  // comes back through messages.upsert (fromMe=true) for messages we sent
  // from the bridge. Stored with a timestamp so we can GC entries whose
  // echo never arrived — otherwise this Set would grow forever.
  private bridgeSentIds: Map<string, number> = new Map();
  private static readonly BRIDGE_SENT_TTL_MS = 5 * 60_000;
  private gcTimer: NodeJS.Timeout | null = null;
  // Ticker that looks for pauses near expiry and buffers warnings; the
  // flush timer is armed lazily when the first warning lands so an empty
  // buffer never wakes us up.
  private pauseTickerTimer: NodeJS.Timeout | null = null;
  private warningFlushTimer: NodeJS.Timeout | null = null;
  private pendingWarnings: Array<{ jid: string; pushName?: string }> = [];
  // jid -> last-seen display name for DMs. Populated from incoming
  // (non-fromMe) messages so that when the owner takes over a thread
  // manually — where msg.pushName is the owner's own name, not the
  // contact's — we can still address the grace-period warning by name.
  // Capped in size; the cap is generous (most users message <1k contacts).
  private contactNames: Map<string, string> = new Map();
  private static readonly CONTACT_NAMES_MAX = 5_000;
  // Rolling per-contact inbound history used to infer their conversational
  // style (formality, lowercase, emojis, brevity). Keeps the last N raw
  // texts only — no LLM, no PII beyond what they texted. We use this to
  // seed the natural-texting persona prompt every turn so the agent
  // sounds like a human matching their register.
  private inboundHistory: Map<string, string[]> = new Map();
  private static readonly INBOUND_HISTORY_PER_CONTACT = 12;
  // Per-contact "has this person been told they're talking to an assistant?"
  // We send the one-liner handoff disclosure exactly once per JID, the first
  // time the agent is about to reply on this thread. Groups are skipped —
  // group members can't have a meaningful 1:1 disclosure relationship.
  private disclosedJids: Set<string> = new Set();
  // Rolling per-contact buffer of the OWNER's actual sent messages (the
  // human, not the bridge) — fed as few-shot exemplars to the persona so
  // the agent learns "my voice" from real history. Capped per-contact;
  // persisted with state so the buffer survives restarts.
  private ownerSentHistory: Map<string, string[]> = new Map();
  private static readonly OWNER_SENT_PER_CONTACT = 10;

  constructor(tenantId: string, logger: Logger) {
    this.tenantId = tenantId;
    this.logger = logger.child({ tenant: tenantId });
    this.authDir = join(process.cwd(), "auth_sessions", tenantId);
    mkdirSync(this.authDir, { recursive: true });
    this.agent = new AgentClient(this.logger, {
      agentName: process.env.LANTERN_AGENT_NAME || "whatsapp-assistant",
      sessionsFile: join(this.authDir, "agent_sessions.json"),
    });
    this.attention = new AttentionClassifier(this.logger);
    this.media = new MediaHandler(this.logger);
    this.personal = new PersonalClient(this.logger);
    this.calendar = new CalendarLookup(this.logger);
    this.docs = new PersonalDocs(defaultPersonalDocsConfig(this.authDir), this.logger);
    this.macActions = new MacActions(this.logger);
    // User preferences (monitored groups, paused contacts, mute) live
    // OUTSIDE auth_sessions/ so `reset()` (which wipes auth creds for
    // re-pair) doesn't also nuke the user's settings. Previously they
    // were colocated and re-pairing silently cleared every preference.
    const stateDir = join(process.cwd(), "bridge_state", tenantId);
    mkdirSync(stateDir, { recursive: true });
    this.stateFile = join(stateDir, "agent_state.json");
    // One-time migration: if the legacy file exists in authDir but the
    // new location is empty, move it. Idempotent — runs once per tenant
    // and then never finds the source file again.
    const legacyStateFile = join(this.authDir, "agent_state.json");
    if (existsSync(legacyStateFile) && !existsSync(this.stateFile)) {
      try {
        const data = readFileSync(legacyStateFile, "utf8");
        writeFileSync(this.stateFile, data);
        this.logger.info(
          { from: legacyStateFile, to: this.stateFile },
          "migrated agent_state out of authDir",
        );
      } catch (err) {
        this.logger.warn({ err }, "agent_state migration failed (non-fatal)");
      }
    }
    this.loadState();
    // GC stale bridgeSentIds every minute so a missed echo doesn't leak mem.
    this.gcTimer = setInterval(() => this.gcBridgeSentIds(), 60_000);
    // unref so the timer doesn't keep the process alive on shutdown.
    this.gcTimer.unref?.();
    this.pauseTickerTimer = setInterval(
      () => this.checkPauseExpiries(),
      PAUSE_TICK_MS
    );
    this.pauseTickerTimer.unref?.();
  }

  private gcBridgeSentIds() {
    const cutoff = Date.now() - WhatsAppSession.BRIDGE_SENT_TTL_MS;
    for (const [id, ts] of this.bridgeSentIds) {
      if (ts < cutoff) this.bridgeSentIds.delete(id);
    }
  }

  // Transition the named connection state and broadcast. Idempotent — a
  // repeated transition to the same state is a no-op so we don't spam the
  // dashboard with redundant events. `reason` is surfaced to the UI for
  // states that benefit from it (e.g. `reconnecting` includes the close
  // code, `error` includes the exception message).
  private setConnectionState(state: ConnectionState, reason?: string) {
    if (this.connectionState === state && !reason) return;
    const prev = this.connectionState;
    this.connectionState = state;
    this.lastStateChangeAt = Date.now();
    if (reason) this.lastError = reason;
    this.broadcast({
      type: "connection_state",
      data: {
        state,
        since: this.lastStateChangeAt,
        attempt: this.reconnectAttempts,
        reason: reason ?? null,
      },
    });
    // Proactive alerts: fire email/telegram immediately when the bridge
    // enters a terminal or actionable error state. Don't wait for the
    // user to notice — the whole point of a 24/7 personal assistant is
    // they shouldn't have to check on it. De-duped + actionable
    // recovery hints inside the alert function itself.
    this.maybeFireCriticalAlert(prev, state, reason);
  }

  // Per-state cooldowns so a flapping connection (reconnecting →
  // conflict → reconnecting → conflict) doesn't send 20 alert emails.
  // Same state within 5 minutes is suppressed.
  private lastAlertAt: Map<ConnectionState, number> = new Map();
  private static readonly ALERT_COOLDOWN_MS = 5 * 60_000;
  private maybeFireCriticalAlert(
    prev: ConnectionState,
    next: ConnectionState,
    reason: string | undefined,
  ): void {
    // States worth alerting on. Don't alert on transient states like
    // 'reconnecting' / 'connecting' / 'qr_ready' — those are noisy and
    // not actionable.
    // 'bridge_offline' is a dashboard-only state (the dashboard can't
    // reach the bridge over HTTP) — by definition the bridge can't fire
    // an alert about itself being offline. That alert path lives in the
    // dashboard's heartbeat probe.
    const alertable: ConnectionState[] = [
      "conflict",
      "logged_out",
      "error",
    ];
    if (!alertable.includes(next)) return;
    if (prev === next) return; // no change → no new alert

    const lastAt = this.lastAlertAt.get(next) ?? 0;
    if (Date.now() - lastAt < WhatsAppSession.ALERT_COOLDOWN_MS) return;
    this.lastAlertAt.set(next, Date.now());

    // Map state → user-facing copy. Each carries a concrete recovery
    // action so the alert is actually useful, not just 'something broke'.
    const phone = this.phoneNumber ? `+${this.phoneNumber}` : "your account";
    const msg = (() => {
      switch (next) {
        case "conflict":
          return [
            "⚠️ *Lantern alert: WhatsApp conflict*",
            "",
            `Another WhatsApp Web session is active for ${phone} and keeps stealing the bridge's slot. The bridge has stopped retrying.`,
            "",
            "*Recovery:*",
            "1. On your phone: WhatsApp → Settings → Linked Devices",
            "2. Log out every device in the list",
            "3. Wait 60 seconds",
            "4. Open the Lantern dashboard → Channels → WhatsApp → Pair with QR",
            reason ? `\n_detail: ${reason}_` : "",
          ].filter(Boolean).join("\n");
        case "logged_out":
          return [
            "🚪 *Lantern alert: WhatsApp unlinked*",
            "",
            `Your phone unlinked the bridge from ${phone}. The bridge is no longer paired.`,
            "",
            "*Recovery:*",
            "1. Dashboard → Channels → WhatsApp → Pair with QR",
            "2. Scan with your phone",
            reason ? `\n_detail: ${reason}_` : "",
          ].filter(Boolean).join("\n");
        case "error":
          return [
            "🔴 *Lantern alert: WhatsApp bridge error*",
            "",
            `The bridge hit an error and may not be receiving messages.`,
            reason ? `\n_${reason}_\n` : "",
            "*Try:* dashboard → Channels → WhatsApp → click Pair to reconnect. If it persists, check the bridge log at `/tmp/lantern-whatsapp-bridge.log`.",
          ].filter(Boolean).join("\n");
        default:
          return null;
      }
    })();
    if (!msg) return;

    // Use the same mirror functions as normal status messages — they
    // already handle env-var gating + fire-and-forget semantics. Alerts
    // are tagged 'critical_alert' in the dashboard broadcast so the UI
    // can render them distinctly.
    this.broadcast({
      type: "activity",
      data: {
        kind: "system",
        summary: `Alert: bridge entered ${next}`,
        detail: reason ?? undefined,
        timestamp: Date.now(),
      },
    });
    void this.mirrorToEmail(msg);
    void this.mirrorToTelegram(msg);
  }

  // Structured activity event used by the dashboard's live feed. Every
  // entry is a human-readable summary plus a kind code so the dashboard
  // can group/icon them consistently.
  private logActivity(
    kind:
      | "bot_on"
      | "bot_off"
      | "monitor_on"
      | "monitor_off"
      | "contact_paused"
      | "contact_resumed"
      | "attention_dm"
      | "agent_skipped",
    summary: string,
    extra?: { jid?: string; pushName?: string; scope?: "self" | "contact" | "group" }
  ) {
    this.broadcast({
      type: "activity",
      data: {
        kind,
        summary,
        timestamp: Date.now(),
        ...extra,
      },
    });
  }

  async start() {
    this.setConnectionState("starting");
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      // Wrap our pino logger with a thin proxy that counts decrypt
      // errors. Baileys logs "failed to decrypt message" at level=50
      // when libsignal can't find/use a session. A burst of these
      // (>20 in 60s) means Signal state is corrupted — we force a
      // socket-level reconnect to renegotiate, no QR re-pair needed.
      const baseLogger = this.logger;
      const baileysLogger = baseLogger.child({}) as Logger & {
        error: (obj: unknown, msg?: string) => void;
      };
      const origError = baileysLogger.error.bind(baileysLogger);
      baileysLogger.error = (obj: unknown, msg?: string) => {
        let probe = "";
        try {
          const m = (typeof obj === "object" && obj && (obj as { msg?: string }).msg) || msg || "";
          probe = String(m);
          // Stringify is best-effort — Baileys logs can contain
          // Buffers/circular refs that throw. Failure here MUST NOT
          // break logging.
          probe += " " + JSON.stringify(obj, (_k, v) => (v instanceof Error ? v.message : v));
        } catch {
          // Probe falls back to just the msg string
        }
        if (/failed to decrypt message|No matching sessions|MessageCounterError|Bad MAC/i.test(probe)) {
          this.noteDecryptError();
        }
        origError(obj, msg);
      };

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        logger: baileysLogger,
        browser: ["Lantern", "Desktop", "1.0.0"],
        // Baileys' default (60s) spuriously trips fetchProps/history sync on
        // slow networks; undefined disables the per-query timeout.
        defaultQueryTimeoutMs: undefined,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 25_000,
        retryRequestDelayMs: 2_000,
      });

      // QR code event
      this.socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Convert QR string to data URL for the dashboard
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          this.currentQR = qrDataUrl;
          this.qrIssuedAt = Date.now();
          // `data` stays a plain dataUrl for backwards compatibility with
          // older dashboard builds; new fields are sibling keys.
          this.broadcast({
            type: "qr",
            data: qrDataUrl,
            issuedAt: this.qrIssuedAt,
            expiresInMs: QR_VALID_MS,
          });
          this.setConnectionState("qr_ready");
          this.logger.info("QR code generated -- scan with WhatsApp");
        }

        if (connection === "connecting") {
          // Baileys flips to "connecting" after we authenticate via QR and
          // before the socket is fully open. Surface that as a distinct
          // state so the dashboard can swap the QR view for a spinner.
          if (!this.connected) this.setConnectionState("connecting");
        }

        if (connection === "open") {
          const wasFirstPair = !this.paired;
          this.connected = true;
          this.paired = true;
          this.currentQR = null;
          this.qrIssuedAt = null;
          this.reconnectAttempts = 0;
          this.lastConnectionEventAt = Date.now();
          this.lastError = null;

          // Get user info
          const user = this.socket?.user;
          this.phoneNumber = user?.id?.split(":")[0] || null;
          this.displayName = user?.name || null;

          this.logger.info(
            { phone: this.phoneNumber, name: this.displayName },
            "WhatsApp connected"
          );
          this.broadcast({
            type: "connected",
            data: {
              phoneNumber: this.phoneNumber,
              name: this.displayName,
              connectedAt: this.lastConnectionEventAt,
            },
          });
          this.setConnectionState("connected");
          this.everConnected = true;

          // Start the daily morning digest scheduler. Sends a brief
          // self-chat summary every morning at LANTERN_DIGEST_HOUR.
          this.startDailyDigest();
          this.startOfflineMonitor();

          // Pre-warm group metadata so group session keys are initialized
          // BEFORE the first message arrives. Without this, the first
          // group message after a fresh pair hits libsignal with no
          // session record → "failed to decrypt message" loop. We have
          // a real user-reported case where /bot monitor on in a group
          // sat undelivered for an hour because the group's sender keys
          // hadn't been bootstrapped on the bridge side. Calling
          // groupFetchAllParticipating() (fire-and-forget) triggers the
          // WhatsApp client to send sender-key distribution messages to
          // this device for every group the user is in.
          void this.refreshGroupSessions("pair");

          // Self-chat confirmation. Closes the proof loop — the user
          // sees the dashboard go green AND receives a WhatsApp message
          // from themselves saying the bridge is alive. On subsequent
          // reconnects we send a quieter "🔁 reconnected" line so the
          // user knows the bridge survived a network hiccup, but only
          // if it was offline more than 30s (avoids spamming on flaky
          // wifi).
          //
          // Wrapped in a small delay because confirmToSelf can race the
          // open-state flip on Baileys' side and silently drop.
          setTimeout(() => {
            if (wasFirstPair) {
              void this.confirmToSelf(
                [
                  "🟢 *Lantern is connected*",
                  "",
                  "I'll auto-reply to DMs (and @mentions in monitored groups).",
                  "Reply `/lantern status` anytime to verify I'm still alive.",
                  "Reply `/lantern help` for the full command list.",
                ].join("\n")
              );
            }
          }, 1500);
        }

        if (connection === "close") {
          this.connected = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output
            ?.statusCode;
          const reason = (lastDisconnect?.error as Error | undefined)?.message;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          // 'Stream Errored (conflict)' / connectionReplaced (440) means
          // another WhatsApp Web session is active for the same account
          // and kicked us off. Reconnecting just steals the slot back,
          // which then gets stolen again — an infinite ping-pong. Treat
          // this as terminal: stop reconnecting, surface a clear state
          // the dashboard can render with "close other sessions" guidance.
          const isConflict =
            statusCode === DisconnectReason.connectionReplaced ||
            statusCode === 440 ||
            (reason?.toLowerCase().includes("conflict") ?? false);
          const shouldReconnect = !loggedOut && !isConflict;
          this.lastConnectionEventAt = Date.now();

          this.logger.info(
            { statusCode, shouldReconnect, isConflict },
            "WhatsApp disconnected"
          );
          this.broadcast({
            type: "disconnected",
            data: { statusCode, reason: reason ?? null, loggedOut, conflict: isConflict },
          });

          try {
            this.socket?.ev.removeAllListeners("connection.update");
            this.socket?.ev.removeAllListeners("creds.update");
            this.socket?.ev.removeAllListeners("messages.upsert");
          } catch {}
          this.socket = null;
          // Cancel any pending retry — we're entering a terminal state.
          if (this.reconnectTimer && (loggedOut || isConflict)) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }

          if (loggedOut) {
            // Phone unlinked us — auth dir is now useless; pairing must
            // start over. Surface this as a terminal state so the dashboard
            // can prompt for a fresh QR rather than spin forever.
            this.paired = false;
            this.setConnectionState(
              "logged_out",
              "WhatsApp on your phone unlinked this device"
            );
            return;
          }

          if (isConflict) {
            this.setConnectionState(
              "conflict",
              "Another WhatsApp Web session is active for this number. Close it (e.g. web.whatsapp.com or another Linked Device) and click Reconnect."
            );
            this.reconnectAttempts = 0;
            return;
          }

          if (shouldReconnect && !this.reconnectTimer) {
            this.reconnectAttempts += 1;
            const delay = Math.min(
              30_000,
              1_000 * 2 ** Math.min(this.reconnectAttempts, 5)
            );
            this.setConnectionState(
              "reconnecting",
              reason ?? (statusCode ? `close ${statusCode}` : undefined)
            );
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              this.start();
            }, delay);
          }
        }
      });

      // Save credentials on update
      this.socket.ev.on("creds.update", saveCreds);

      // Incoming messages
      this.socket.ev.on("messages.upsert", async (m) => {
        for (const msg of m.messages) {
          const from = msg.key.remoteJid || "";
          if (!from) continue;

          // KILL SWITCH gate. When engaged the bridge IGNORES
          // everything except a "kill switch off" command from the
          // owner's self-chat. We parse early — before bodyguard
          // text-extraction logic — to keep the rejection path cheap.
          if (this.killSwitch) {
            const probe =
              msg.message?.conversation
              || msg.message?.extendedTextMessage?.text
              || "";
            const cmd = probe ? parseNLCommand(probe.trim()) : null;
            const isOwnerChan = this.isOwnerChat(from);
            const releasing = !!cmd && cmd.action === "killswitch-off";
            // In self-chat mode, fromMe=true (owner authored it). In
            // dedicated-bot mode the owner DMs the bot from another
            // number → fromMe=false. Accept both.
            if (!(isOwnerChan && releasing)) {
              continue; // total silence
            }
            // Release: fall through to normal handling so the
            // command executor fires + confirms back.
          }

          // Reaction commands. If the owner reacts to a message
          // (typically a bot-sent reply) with a recognized emoji,
          // we treat it as a command on that thread:
          //   ⏸ / 🔇 → pause this contact
          //   ▶️ / 🟢 → resume
          //   📊 → status reply
          //   ❤️ → mark contact as VIP
          //   🗑 → forget contact
          // Reactions arrive as a separate Baileys event with
          // `reactionMessage.text` (the emoji) + key pointing to the
          // reacted-to message. Only OWNER reactions count.
          const reactionMsg = msg.message?.reactionMessage;
          if (reactionMsg && msg.key.fromMe) {
            const emoji = reactionMsg.text || "";
            const action = reactionToAction(emoji);
            if (action) {
              const targetKeyId = reactionMsg.key?.id || undefined;
              const onBotReply = !!(targetKeyId && this.bridgeSentIds.has(targetKeyId));
              this.logger.info({ emoji, action, threadJid: from, onBotReply }, "reaction command");
              void dispatchReaction(
                { action, threadJid: from, onBotReply },
                {
                  pauseContact: (jid) => { this.pauseContact(jid, INDEFINITE_MS); },
                  resumeContact: (jid) => { this.resumeContact(jid); },
                  markVIP: async (jid) => {
                    try {
                      await authedFetch("/v1/whatsapp/vips", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ jid, displayName: this.contactNames.get(jid) ?? "" }),
                      });
                    } catch (err) {
                      this.logger.warn({ err, jid }, "markVIP via reaction failed");
                    }
                  },
                  forgetContact: (jid) => {
                    this.resumeContact(jid);
                    this.agent.clearHistory(jid);
                  },
                  sendStatus: async () => {
                    await this.handleSelfChatCommand({ action: "status", echo: "status", explicit: true });
                  },
                  approveDraft: async () => { /* WhatsApp reaction-to-draft path is dashboard-only for now */ },
                  discardDraft: async () => {},
                  acknowledge: async (jid, ack) => {
                    if (reactionMsg.key) await this.sendReaction(jid, reactionMsg.key, ack);
                  },
                },
              );
            }
            continue; // reactions don't fall through to text processing
          }

          let text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";
          const isGroup = this.isGroupJid(from);

          // Voice command path: if the OWNER sent themselves a voice
          // note that starts with "lantern, ..." we transcribe + parse
          // + dispatch. Whisper round-trip is cheaper than an LLM
          // round-trip and the wake-word guard prevents misfires.
          if (msg.key.fromMe && !text && this.media.hasMedia(msg) && this.isSelfChat(from)) {
            const annotation = await this.media.annotate(msg);
            if (annotation.kind === "voice" && annotation.ok) {
              const transcript = annotation.syntheticText.replace(/^\[voice note transcribed\]\s*/i, "");
              const voiceCmd = parseVoiceCommand(transcript);
              if (voiceCmd) {
                this.logger.info({ transcript: transcript.slice(0, 80) }, "voice command detected");
                this.broadcast({
                  type: "activity",
                  data: { kind: "system", summary: `🎙️ voice cmd: ${voiceCmd.action}`, detail: transcript.slice(0, 200), jid: from, timestamp: Date.now() },
                });
                await this.handleSelfChatCommand(voiceCmd);
                continue;
              }
            }
            // Non-command voice from owner self-chat — let it fall
            // through; the bridge can still record it as exemplar etc.
          }

          // Media: voice notes → Whisper transcription; images → vision
          // LLM description. Treat the resulting text as the inbound so
          // the reply pipeline doesn't need to care about media.
          // Skip for fromMe (already handled above) and for groups where
          // we're not on the monitor list. Run async — we await the
          // annotation before falling through to the rest of the
          // pipeline so the LLM sees the synthetic text.
          if (!msg.key.fromMe && !text && this.media.hasMedia(msg)) {
            const annotation = await this.media.annotate(msg);
            if (annotation.syntheticText) {
              text = annotation.syntheticText;
              // Broadcast a separate activity event so the dashboard
              // shows "🎙️ voice note transcribed" / "📷 image saw …"
              this.broadcast({
                type: "activity",
                data: {
                  kind: "message_in",
                  summary:
                    annotation.kind === "voice"
                      ? "voice note transcribed"
                      : annotation.kind === "image"
                        ? "image described"
                        : `received ${annotation.kind}`,
                  detail: annotation.syntheticText.slice(0, 200),
                  jid: from,
                  pushName: msg.pushName,
                  timestamp: Date.now(),
                },
              });
            }
          }

          // Messages flagged fromMe include both:
          //   (a) replies the bridge itself just sent — echo back; skip.
          //   (b) replies the owner typed from native WhatsApp on phone —
          //       treat as command or takeover.
          if (msg.key.fromMe) {
            if (msg.key.id && this.bridgeSentIds.has(msg.key.id)) {
              this.bridgeSentIds.delete(msg.key.id);
              continue;
            }
            if (!text) continue;
            // Capture the owner's real outgoing messages as few-shot
            // exemplars for the persona. Skip self-chat (commands), groups
            // (mixed register), and /bot commands themselves.
            if (
              !isGroup &&
              !this.isSelfChat(from) &&
              !text.trim().toLowerCase().startsWith("/bot")
            ) {
              this.rememberOwnerSent(from, text);
            }
            await this.handleOwnerMessage(from, text, msg.key);
            continue;
          }

          // DEDICATED-BOT MODE: owner DMs the bot from their primary
          // WhatsApp number. msg.key.fromMe is false here (the bot's
          // session didn't author it), but isOwnerChat(from) is true
          // (the sender JID matches LANTERN_WA_OWNER_JID). Route the
          // same owner-control + docs + commands path used in
          // self-chat mode so all features (status, /bot off, doc
          // queries, agentic actions) work identically.
          if (!isGroup && text && this.isOwnerChat(from)) {
            this.rememberOwnerSent(from, text);
            await this.handleOwnerMessage(from, text, msg.key);
            continue;
          }

          // Remember the sender's display name for later — we'll use it in
          // the grace-period warning DM, where we only have the JID and no
          // fresh message context. Non-DM JIDs (groups) are skipped; we
          // never pause groups so we'd never read from that slot.
          if (!isGroup && msg.pushName) {
            this.rememberContactName(from, msg.pushName);
          }

          if (m.type !== "notify" || !text) continue;

          // Groups are opt-in: silently skip anything not on the monitor list.
          if (isGroup && !this.isMonitoredGroup(from)) continue;

          // Track inbound for style inference. Groups share a single bucket
          // because group register tends to be uniform; DMs are per-contact.
          this.rememberInbound(from, text);

          this.logger.info(
            { from, isGroup, text: text.slice(0, 100) },
            "Incoming message"
          );
          this.broadcast({
            type: "message",
            data: {
              from,
              text,
              timestamp: msg.messageTimestamp,
              pushName: msg.pushName,
              isGroup,
            },
          });

          // Classify attention independently of the auto-reply path — we want
          // to notify the owner even when the bot is globally muted or paused
          // for this contact (that's exactly when a heads-up matters most).
          const senderName = msg.pushName || undefined;
          this.checkAttention(from, text, senderName, isGroup).catch((err) =>
            this.logger.warn({ err, from }, "attention check failed")
          );

          if (!this.agent.enabled()) continue;
          if (this.muted) {
            this.logger.info({ from }, "agent skipped — globally muted");
            continue;
          }
          if (this.isPaused(from)) {
            this.logger.info({ from }, "agent skipped — contact paused");
            continue;
          }
          // In groups, only reply when the owner is @mentioned or the
          // message is a quote-reply to one of the owner's messages.
          // Noise guard: replying to every group message would be awful.
          if (isGroup && !this.isOwnerTargeted(msg)) {
            this.logger.info({ from }, "group message not addressed to owner");
            continue;
          }
          this.handleAgentReply(from, text, {
            isGroup,
            senderName,
            msgKey: msg.key,
            // Full proto message → so we can quote-reply in groups
            // (real-human behavior in noisy threads).
            quotedMsg: msg,
          }).catch(
            (err) => this.logger.error({ err, from }, "agent reply failed")
          );
        }
      });
    } catch (err) {
      this.logger.error({ err }, "Failed to start WhatsApp session");
      const message = err instanceof Error ? err.message : String(err);
      this.broadcast({ type: "error", data: { message } });
      this.setConnectionState("error", message);
    }
  }

  async sendMessage(
    to: string,
    text: string,
    opts: {
      // When set, the outgoing message becomes a WhatsApp reply that
      // quotes this inbound message — exactly how a human would tap
      // "reply" on an old message in a busy thread. Skip when null/
      // undefined to send a normal message.
      quoted?: import("baileys").proto.IWebMessageInfo;
    } = {},
  ) {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }
    // Ensure the JID format is correct
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const sendOpts = opts.quoted ? { quoted: opts.quoted } : undefined;
    const sent = await this.socket.sendMessage(jid, { text }, sendOpts);
    if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
  }

  // Send a message to the bridge owner's own WhatsApp self-chat. Used
  // by the control-plane to deliver agent output (Morning Brief,
  // inbox-concierge summary, etc.) to the user's phone. Also fires the
  // email + telegram mirrors so the message reaches the user even when
  // WhatsApp's Signal session is in stale-key purgatory. Returns the
  // owner JID on success so the caller can journal it.
  async sendSelf(text: string): Promise<string> {
    const own = this.ownJid();
    if (!own) throw new Error("not paired");
    if (!this.socket || !this.connected) throw new Error("not connected");
    if (typeof text !== "string" || text.length === 0) {
      throw new Error("text required");
    }
    const sent = await this.socket.sendMessage(own, { text });
    if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
    // Mirror to email + telegram so the user still gets it if WA
    // itself is degraded. mirrorToEmail is throttled per-text.
    void this.mirrorToEmail(text);
    void this.mirrorToTelegram(text);
    return own;
  }

  /**
   * True if the agent is currently paused for this JID. Expired pauses are
   * cleaned up lazily here; the background ticker is only responsible for
   * delivering the grace-period heads-up DM, not for expiring state.
   */
  isPaused(jid: string): boolean {
    const entry = this.pausedUntil.get(jid);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      this.pausedUntil.delete(jid);
      this.saveState();
      return false;
    }
    return true;
  }

  /** True if the global mute is on. */
  isMuted() {
    return this.muted;
  }

  /**
   * Set the global mute. Persists to disk so restarts pick up the same
   * state. No-op (and no disk write) when the value doesn't change.
   */
  setMuted(value: boolean) {
    if (this.muted === value) return;
    this.muted = value;
    this.saveState();
    this.logger.info({ muted: value }, "bot mute toggled");
  }

  /**
   * Pause agent auto-replies for one contact until now + ttlMs. Default TTL
   * is LANTERN_AGENT_PAUSE_MIN (60 min) which matches the "owner took over"
   * heuristic; callers can pass INDEFINITE_MS for an explicit indefinite pause.
   *
   * pushName for the grace-period warning is resolved in priority order:
   * explicit argument > previous entry's pushName > contactNames cache
   * (populated from inbound messages). `warned` is always reset to false so
   * a rolling takeover triggers a fresh warning near the new expiry.
   */
  pauseContact(jid: string, ttlMs: number = PAUSE_TTL_MS, pushName?: string) {
    const prev = this.pausedUntil.get(jid);
    const resolvedName =
      pushName || prev?.pushName || this.contactNames.get(jid);
    this.pausedUntil.set(jid, {
      until: Date.now() + ttlMs,
      pushName: resolvedName,
      warned: false,
    });
    this.saveState();
  }

  private rememberContactName(jid: string, name: string) {
    // Basic bound — if we've learned too many names, drop the oldest
    // (insertion-order) until we're back under the cap.
    this.contactNames.set(jid, name);
    while (this.contactNames.size > WhatsAppSession.CONTACT_NAMES_MAX) {
      const oldest = this.contactNames.keys().next().value;
      if (oldest === undefined) break;
      this.contactNames.delete(oldest);
    }
  }

  /** Clear the pause for a single JID. No-op if the JID wasn't paused. */
  resumeContact(jid: string) {
    if (this.pausedUntil.delete(jid)) this.saveState();
  }

  /**
   * Clear every per-contact pause. Returns the number of pauses cleared so
   * the UI can surface "resumed N contacts". Does NOT affect the global mute.
   */
  resumeAll(): number {
    const count = this.pausedUntil.size;
    if (count === 0) return 0;
    this.pausedUntil.clear();
    this.saveState();
    this.logger.info({ count }, "cleared all paused contacts");
    return count;
  }

  /**
   * Opt a group in to monitoring. Silently refuses non-group JIDs — groups
   * are the only thing with an explicit opt-in because auto-replying in
   * every group the owner is in would be a disaster.
   */
  monitorGroup(jid: string) {
    if (!this.isGroupJid(jid)) return;
    if (this.monitoredGroups.has(jid)) return;
    this.monitoredGroups.add(jid);
    this.saveState();
    this.logger.info({ jid }, "started monitoring group");
  }

  /** Remove a group from the monitored set. No-op if not present. */
  unmonitorGroup(jid: string) {
    if (this.monitoredGroups.delete(jid)) this.saveState();
  }

  /** True if we're currently monitoring this group. */
  isMonitoredGroup(jid: string) {
    return this.monitoredGroups.has(jid);
  }

  // jid -> {name, fetchedAt}. Cached so /lantern groups doesn't hit
  // Baileys' groupMetadata RPC for every entry on every command. TTL is
  // generous since group names rarely change.
  private groupNameCache: Map<string, { name: string; fetchedAt: number }> = new Map();
  private static readonly GROUP_NAME_TTL_MS = 60 * 60_000;

  /**
   * Best-effort group name lookup. Returns null when Baileys can't reach
   * WhatsApp, the group metadata isn't cached yet, or the JID isn't a
   * group. Used by /lantern groups so the listing shows readable names
   * instead of raw `120363...@g.us` JIDs.
   */
  async resolveGroupName(jid: string): Promise<string | null> {
    if (!this.isGroupJid(jid) || !this.socket) return null;
    const cached = this.groupNameCache.get(jid);
    if (cached && Date.now() - cached.fetchedAt < WhatsAppSession.GROUP_NAME_TTL_MS) {
      return cached.name;
    }
    try {
      const meta = await this.socket.groupMetadata(jid);
      const name = (meta?.subject || "").trim();
      if (!name) return null;
      this.groupNameCache.set(jid, { name, fetchedAt: Date.now() });
      return name;
    } catch (err) {
      this.logger.debug({ err, jid }, "resolveGroupName failed");
      return null;
    }
  }

  /**
   * Returns every group the bridge knows about with {jid, name,
   * participantCount, monitored}. Used by the dashboard to render a
   * checkbox list — no more curl-with-JID workaround for opting groups
   * in. Sorted: monitored first (so the active ones surface), then
   * alphabetical by name.
   */
  async listGroups(): Promise<Array<{ jid: string; name: string; participants: number; monitored: boolean }>> {
    if (!this.socket) return [];
    let metas: Record<string, { id?: string; subject?: string; participants?: unknown[] }> = {};
    try {
      metas = (await this.socket.groupFetchAllParticipating()) as typeof metas;
    } catch (err) {
      this.logger.warn({ err }, "listGroups: groupFetchAllParticipating failed");
      return [];
    }
    const out = Object.values(metas).map((m) => {
      const jid = m.id || "";
      const name = (m.subject || "").trim() || jid.split("@")[0];
      const participants = Array.isArray(m.participants) ? m.participants.length : 0;
      // Refresh cache while we're at it.
      if (name && jid) this.groupNameCache.set(jid, { name, fetchedAt: Date.now() });
      return { jid, name, participants, monitored: this.monitoredGroups.has(jid) };
    });
    out.sort((a, b) => {
      if (a.monitored !== b.monitored) return a.monitored ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  /**
   * Pre-warm group sessions by fetching metadata for every group the
   * user is in. Fire-and-forget — failures are logged but never thrown
   * because the bridge can still function (1-on-1s) without it.
   *
   * Why this matters: after a fresh pair, group messages from the
   * owner's phone fail to decrypt with "SessionError: No session record"
   * until the phone re-distributes its sender key for each group to the
   * bridge. groupFetchAllParticipating() touches every group, which
   * triggers WhatsApp to push the missing keys.
   *
   * Reason is a free-form string used purely for log context
   * ('pair', 'manual', 'on-decrypt-failure' etc.).
   */
  async refreshGroupSessions(reason: string): Promise<{ ok: boolean; count: number; error?: string }> {
    if (!this.socket) {
      return { ok: false, count: 0, error: "not connected" };
    }
    try {
      // Baileys returns { jid: GroupMetadata } map. We don't need the
      // metadata itself — just the side effect of the fetch triggering
      // sender-key distribution.
      const groups = await this.socket.groupFetchAllParticipating();
      const count = Object.keys(groups || {}).length;
      this.logger.info({ count, reason }, "refreshed group sessions");
      return { ok: true, count };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: msg, reason }, "refreshGroupSessions failed");
      return { ok: false, count: 0, error: msg };
    }
  }

  /**
   * Snapshot of everything the dashboard / commands need to render.
   * Expired pauses are filtered out before publishing. The wire format
   * keeps `paused` as a plain `jid -> until_ms` map so existing clients
   * (dashboard, CLI) don't have to care about the internal pushName/warned
   * bookkeeping.
   */
  getBotState(): BotState {
    const paused: Record<string, number> = {};
    const now = Date.now();
    for (const [jid, entry] of this.pausedUntil) {
      if (entry.until > now) paused[jid] = entry.until;
    }
    return {
      muted: this.muted,
      paused,
      monitoredGroups: [...this.monitoredGroups],
    };
  }

  private loadState() {
    // Load new unified state file if present; otherwise migrate from
    // the legacy agent_paused.json (which held just the pause map).
    //
    // pausedUntil has two on-disk shapes:
    //   (a) number          — v1 (pre-PauseEntry). Migrated transparently.
    //   (b) { until, ... }  — current. pushName/warned preserved.
    const legacyFile = join(this.authDir, "agent_paused.json");
    let loaded = false;
    if (existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
          muted?: boolean;
          pausedUntil?: Record<string, unknown>;
          monitoredGroups?: string[];
          disclosedJids?: string[];
          ownerSentHistory?: Record<string, string[]>;
          personalDocsEnabled?: boolean;
          killSwitch?: boolean;
        };
        this.muted = !!raw.muted;
        // Toggles default to safe values: docs ON, killswitch OFF.
        if (typeof raw.personalDocsEnabled === "boolean") this.personalDocsEnabled = raw.personalDocsEnabled;
        if (typeof raw.killSwitch === "boolean") this.killSwitch = raw.killSwitch;
        const now = Date.now();
        for (const [jid, v] of Object.entries(raw.pausedUntil ?? {})) {
          const entry = this.coercePauseEntry(v);
          if (entry && entry.until > now) {
            this.pausedUntil.set(jid, entry);
          }
        }
        for (const g of raw.monitoredGroups ?? []) {
          if (typeof g === "string") this.monitoredGroups.add(g);
        }
        for (const jid of raw.disclosedJids ?? []) {
          if (typeof jid === "string") this.disclosedJids.add(jid);
        }
        for (const [jid, msgs] of Object.entries(raw.ownerSentHistory ?? {})) {
          if (!Array.isArray(msgs)) continue;
          const clean = msgs.filter((m): m is string => typeof m === "string");
          if (clean.length > 0) this.ownerSentHistory.set(jid, clean);
        }
        loaded = true;
      } catch (err) {
        this.logger.warn({ err }, "could not load agent_state.json");
      }
    }
    if (!loaded && existsSync(legacyFile)) {
      try {
        const raw = JSON.parse(readFileSync(legacyFile, "utf8")) as Record<
          string,
          number
        >;
        const now = Date.now();
        for (const [jid, until] of Object.entries(raw)) {
          if (typeof until === "number" && until > now) {
            this.pausedUntil.set(jid, { until, warned: false });
          }
        }
        this.saveState();
      } catch (err) {
        this.logger.warn({ err }, "could not migrate agent_paused.json");
      }
    }
  }

  private coercePauseEntry(v: unknown): PauseEntry | null {
    if (typeof v === "number" && Number.isFinite(v)) {
      return { until: v, warned: false };
    }
    if (v && typeof v === "object") {
      const o = v as { until?: unknown; pushName?: unknown; warned?: unknown };
      if (typeof o.until !== "number" || !Number.isFinite(o.until)) return null;
      return {
        until: o.until,
        pushName: typeof o.pushName === "string" ? o.pushName : undefined,
        warned: o.warned === true,
      };
    }
    return null;
  }

  private saveState() {
    try {
      const pausedUntil: Record<string, PauseEntry> = {};
      for (const [jid, entry] of this.pausedUntil) pausedUntil[jid] = entry;
      const ownerSentHistory: Record<string, string[]> = {};
      for (const [jid, msgs] of this.ownerSentHistory) ownerSentHistory[jid] = msgs;
      const payload = {
        muted: this.muted,
        pausedUntil,
        monitoredGroups: [...this.monitoredGroups],
        disclosedJids: [...this.disclosedJids],
        ownerSentHistory,
        personalDocsEnabled: this.personalDocsEnabled,
        killSwitch: this.killSwitch,
      };
      writeFileSync(this.stateFile, JSON.stringify(payload, null, 2));
    } catch (err) {
      this.logger.warn({ err }, "could not persist agent_state.json");
    }
  }

  private ownJid(): string | null {
    const id = this.socket?.user?.id;
    if (!id) return null;
    // id is "<phone>:<device>@<server>"; self-chat jid is "<phone>@<server>"
    const [num, server] = id.split("@");
    const phone = num.split(":")[0];
    return `${phone}@${server || "s.whatsapp.net"}`;
  }

  // All JIDs that WhatsApp might use to refer to the owner:
  // - phone-format (s.whatsapp.net) from socket.user.id
  // - lid-format (newer privacy IDs), if Baileys exposes it
  // Mentions in groups typically use @lid now; we accept either.
  private ownIds(): string[] {
    const user = this.socket?.user as
      | { id?: string; lid?: string }
      | undefined
      | null;
    const ids: string[] = [];
    const own = this.ownJid();
    if (own) ids.push(own);
    if (user?.lid) {
      // user.lid can be "<id>:<device>@lid"; strip device like we do for id.
      const [n, s] = user.lid.split("@");
      const core = n.split(":")[0];
      ids.push(`${core}@${s || "lid"}`);
    }
    return ids;
  }

  // True when the owner is @mentioned in the message, or the message is a
  // quote-reply to one of the owner's own messages. Used only in groups —
  // in 1-on-1 chats every message is implicitly addressed to the owner.
  private isOwnerTargeted(msg: {
    message?: {
      extendedTextMessage?: {
        contextInfo?: {
          mentionedJid?: string[] | null;
          participant?: string | null;
          quotedMessage?: unknown;
        } | null;
      } | null;
    } | null;
  }): boolean {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (!ctx) return false;
    const own = this.ownIds();
    if (own.length === 0) return false;
    const mentioned = ctx.mentionedJid || [];
    if (mentioned.some((m) => own.includes(m))) return true;
    if (ctx.quotedMessage && ctx.participant && own.includes(ctx.participant)) {
      return true;
    }
    return false;
  }

  // Increment decrypt-error counter; trigger self-heal when the
  // storm crosses threshold inside the rolling window.
  private noteDecryptError(): void {
    const now = Date.now();
    if (now - this.decryptErrorWindowStart > WhatsAppSession.DECRYPT_STORM_WINDOW_MS) {
      this.decryptErrorWindowStart = now;
      this.decryptErrorCount = 0;
    }
    this.decryptErrorCount++;
    if (this.decryptErrorCount >= WhatsAppSession.DECRYPT_STORM_THRESHOLD && !this.selfHealing) {
      this.selfHealing = true;
      this.logger.warn(
        { count: this.decryptErrorCount, windowMs: now - this.decryptErrorWindowStart },
        "decrypt storm detected — forcing socket reconnect to renegotiate Signal state",
      );
      this.triggerSelfHeal().catch((err) =>
        this.logger.error({ err }, "self-heal threw"),
      );
    }
  }

  // Force a socket-level reconnect WITHOUT wiping auth creds.
  // Baileys will re-handshake with WhatsApp using existing creds,
  // which usually renegotiates Signal pre-keys + clears transient
  // session-state corruption. Distinct from /reset which wipes
  // creds and requires a QR re-pair.
  private async triggerSelfHeal(): Promise<void> {
    try {
      // Close current socket — Baileys' connection.update handler
      // already auto-reconnects with backoff (see the close handler
      // around line 640+). After reconnect, decryptErrorCount resets
      // when the next successful message lands.
      this.socket?.ws?.close();
      this.setConnectionState("reconnecting", "self-heal: decrypt storm");
      // Email-mirror the user so they know recovery is in flight.
      void this.mirrorToEmail?.("⚠️ WhatsApp bridge auto-recovery: Signal state was corrupted (20+ decrypt failures in 60s). Forcing socket reconnect — no QR needed. Should resume in <30s.").catch(() => {});
    } catch (err) {
      this.logger.error({ err }, "self-heal close failed");
    } finally {
      // Reset gate after a delay so a NEW storm can re-trigger.
      setTimeout(() => {
        this.selfHealing = false;
        this.decryptErrorCount = 0;
        this.decryptErrorWindowStart = Date.now();
      }, 60_000);
    }
  }

  private isSelfChat(jid: string): boolean {
    if (!jid) return false;
    const target = normWaJid(jid);
    // ownIds() returns BOTH JID forms WhatsApp uses for the owner:
    //   - phone-format: "<phone>@s.whatsapp.net"
    //   - LID-format:   "<id>@lid"  (newer privacy IDs)
    for (const own of this.ownIds()) {
      if (normWaJid(own) === target) return true;
    }
    return false;
  }

  // Owner-chat check — the SECURITY gate for personal-docs, agentic
  // actions, the killswitch-release command, etc. Two topologies:
  //
  //   (A) DEDICATED BOT MODE — bridge paired to a SEPARATE WhatsApp
  //       number (Google Voice / Twilio / spare SIM) acting as the
  //       bot. Owner DMs the bot from their primary WhatsApp.
  //       Set LANTERN_WA_OWNER_JID to the owner's primary JID,
  //       either "<phone>@s.whatsapp.net" or just "<phone>".
  //   (B) SELF-CHAT MODE — single number; owner messages themselves.
  //
  // Both accepted. Group chats are never owner-chats.
  private isOwnerChat(jid: string): boolean {
    if (!jid) return false;
    if (this.isGroupJid(jid)) return false;
    const target = normWaJid(jid);
    // Mode A: explicit owner-JID env var
    const ownerEnv = (process.env.LANTERN_WA_OWNER_JID || "").trim();
    if (ownerEnv) {
      const ownerJid = ownerEnv.includes("@") ? ownerEnv : `${ownerEnv.replace(/\D/g, "")}@s.whatsapp.net`;
      if (normWaJid(ownerJid) === target) return true;
    }
    // Mode B: self-chat fallback
    return this.isSelfChat(jid);
  }

  private async handleOwnerMessage(
    jid: string,
    text: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }
  ) {
    const trimmed = text.trim().toLowerCase();
    // `self` here means "the owner-control channel" — either the
    // owner's own self-chat (single-account mode) OR a DM from the
    // owner's primary number to this dedicated bot (LANTERN_WA_OWNER_JID).
    // Both topologies route through the same command + docs paths
    // since the semantics are identical: it's the owner addressing
    // the bot directly.
    const self = this.isOwnerChat(jid);
    const group = this.isGroupJid(jid);

    // Natural-language command parsing. Two contexts:
    //
    //   - Self-chat: parse + dispatch ANY command (status, help,
    //     pause, mute, resume, etc.) → global control.
    //
    //   - Contact thread (not group): parse for non-mute commands
    //     (status, help, resume-all, ping, list-paused, list-chats).
    //     For mute/unmute in a contact thread we DO NOT use the NL
    //     path — those need the per-contact pause semantics below
    //     ("/bot off" in a friend's thread pauses just that friend).
    //
    //   - Group: no NL parsing (group-scoped commands handled below).
    if ((self || !group) && trimmed) {
      const parsed = parseNLCommand(text);
      if (parsed) {
        // Mute/unmute in a non-self contact thread falls through to
        // the per-contact logic. Everything else dispatches globally.
        const globalActions = new Set(["status", "help", "ping", "list-paused", "list-chats", "resume-all"]);
        if (self || globalActions.has(parsed.action)) {
          // Instant reaction so the user sees their command was
          // received even if WhatsApp self-chat delivery is lossy
          // (Signal pre-key drift). Reaction is a different protocol
          // path from regular messages and is more reliable.
          const reactionFor: Record<string, string> = {
            mute: "🔇", unmute: "🟢", status: "🟢", help: "💡",
            ping: "🏓", "list-paused": "⏸", "list-chats": "👀",
            "resume-all": "▶️",
          };
          const emoji = reactionFor[parsed.action] || "✅";
          await this.sendReaction(jid, key, emoji);
          await this.handleSelfChatCommand(parsed);
          await this.deleteCommand(jid, key, self);
          return;
        }
      }
    }

    // Personal-docs Q&A — owner asking about local files in self-chat.
    // SECURITY: triple-gated:
    //   1) personalDocsEnabled toggle ON (owner-controlled, persisted)
    //   2) `self` flag — message is in the owner's self-chat (jid
    //      matches the bridge's own paired number)
    //   3) NOT a group
    // No DM from a contact or group message can reach this code path.
    // CONFIRMATION INTERCEPT: pending offer + user says "yes" →
    // execute the action deterministically, no LLM round trip.
    if (this.personalDocsEnabled && self && !group && this.docs && this.macActions) {
      this.gcPendingOffers();
      const cachedOffer = this.pendingOffers.get(jid);
      if (cachedOffer && looksLikeConfirmation(text)) {
        this.logger.info({ kind: cachedOffer.kind, jid }, "executing cached offer on confirmation");
        this.pendingOffers.delete(jid);
        void this.executeCachedOffer(jid, cachedOffer);
        return;
      }
    }

    if (this.personalDocsEnabled && self && !group && this.docs && looksLikeDocQuery(text)) {
      void this.handleOwnerDocQuery(jid, text, key);
      return;
    }

    // Group-scoped: /bot monitor on|off opts a group in / out of the agent.
    if (group && trimmed === "/bot monitor on") {
      this.monitorGroup(jid);
      await this.deleteCommand(jid, key, false);
      await this.confirmToSelf(
        `👀 monitoring this group — I'll flag urgent msgs and auto-reply when you're @mentioned or quoted.`
      );
      this.logActivity("monitor_on", `Started monitoring group ${jid.split("@")[0]}`, {
        jid,
        scope: "group",
      });
      return;
    }
    if (group && trimmed === "/bot monitor off") {
      this.unmonitorGroup(jid);
      await this.deleteCommand(jid, key, false);
      await this.confirmToSelf(`🙈 stopped monitoring this group.`);
      this.logActivity("monitor_off", `Stopped monitoring group ${jid.split("@")[0]}`, {
        jid,
        scope: "group",
      });
      return;
    }

    // `/bot monitor on|off` outside a group is a no-op silently before
    // this commit — the message looked normal in the user's chat and
    // they assumed it worked. Give explicit feedback in self-chat so the
    // user knows the command was misplaced + suggests the right action.
    if (!group && (trimmed === "/bot monitor on" || trimmed === "/bot monitor off")) {
      await this.sendReaction(jid, key, "🤷");
      await this.confirmToSelf(
        `⚠️ \`${text.trim()}\` only works in *group* chats — that's where the agent decides whether to auto-reply on @mentions.\n\nFor a 1-on-1 contact, use:\n• \`/bot off\` (in their thread) — pause auto-reply for this contact\n• \`/bot on\` — un-pause\n• \`/bot off\` in self-chat — mute everywhere`
      );
      return;
    }

    if (trimmed === "/bot off") {
      if (self) this.setMuted(true);
      else this.pauseContact(jid, INDEFINITE_MS);
      // Emoji reaction first — gives instant tactile feedback that the
      // bridge HEARD the command, before the reply (which the user might
      // miss if they're not looking).
      await this.sendReaction(jid, key, "🔇");
      await this.deleteCommand(jid, key, self);
      await this.confirmToSelf(
        self
          ? "🔇 bot off — I won't auto-reply to anyone until `/bot on`."
          : `🔇 bot off for ${jid.split("@")[0]}.`
      );
      this.logActivity(
        "bot_off",
        self
          ? "Auto-reply turned off (global)"
          : `Auto-reply turned off for ${jid.split("@")[0]}`,
        { jid: self ? undefined : jid, scope: self ? "self" : "contact" }
      );
      return;
    }

    if (trimmed === "/bot on") {
      if (self) {
        this.setMuted(false);
      } else {
        this.resumeContact(jid);
      }
      await this.sendReaction(jid, key, "🟢");
      await this.deleteCommand(jid, key, self);
      await this.confirmToSelf(
        self
          ? "🔊 bot on — auto-reply resumed everywhere."
          : `🔊 bot on for ${jid.split("@")[0]}.`
      );
      this.logActivity(
        "bot_on",
        self
          ? "Auto-reply turned on (global)"
          : `Auto-reply turned on for ${jid.split("@")[0]}`,
        { jid: self ? undefined : jid, scope: self ? "self" : "contact" }
      );
      return;
    }

    if (trimmed === "/bot status" && self) {
      const state = this.getBotState();
      const pausedCount = Object.keys(state.paused).length;
      const groupCount = state.monitoredGroups.length;
      await this.confirmToSelf(
        `bot: ${state.muted ? "muted (global)" : "active"} · paused contacts: ${pausedCount} · monitored groups: ${groupCount}`
      );
      return;
    }

    // ---- /lantern command suite -------------------------------------------
    //
    // Mobile-first status surface. Lets the user verify bridge health from
    // their phone without opening the dashboard. Works in any chat, but
    // status/help/ping replies always go to self-chat so they don't leak
    // into a friend's thread.
    if (trimmed === "/lantern" || trimmed === "/lantern help") {
      await this.sendReaction(jid, key, "📖");
      await this.confirmToSelf(
        [
          "🤖 *Lantern commands*",
          "",
          "`/lantern status` — bridge uptime + agent state",
          "`/lantern ping` — quick echo, confirms I'm alive",
          "`/lantern groups` — list the groups I'm monitoring",
          "`/bot off` — silence me everywhere (or in this thread)",
          "`/bot on` — un-silence me",
          "`/bot status` — show paused contacts + monitored groups",
          "`/bot monitor on` — in a group, opt it in (group only)",
          "`/bot monitor off` — opt the current group out (group only)",
        ].join("\n")
      );
      return;
    }

    // /lantern groups — list monitored groups with friendly names.
    // Falls back to bare JID when name lookup fails (e.g. metadata not
    // cached yet). Self-chat only so the list doesn't leak into a friend's
    // thread.
    if (trimmed === "/lantern groups" && self) {
      await this.sendReaction(jid, key, "👥");
      const monitored = [...this.monitoredGroups];
      if (monitored.length === 0) {
        await this.confirmToSelf(
          "no groups monitored yet.\n\nto opt a group in:\n• type `/bot monitor on` IN the group (most natural), or\n• from the dashboard → Channels → WhatsApp",
        );
        return;
      }
      const lines: string[] = [`👥 *${monitored.length} group${monitored.length === 1 ? "" : "s"} monitored*`, ""];
      for (const groupJid of monitored.slice(0, 25)) {
        const name = await this.resolveGroupName(groupJid);
        lines.push(name ? `• ${name}` : `• \`${groupJid}\``);
      }
      if (monitored.length > 25) {
        lines.push(`…and ${monitored.length - 25} more`);
      }
      await this.confirmToSelf(lines.join("\n"));
      return;
    }

    if (trimmed === "/lantern status") {
      const uptimeMs = Date.now() - this.startedAt;
      const uptimeStr = formatUptimeShort(uptimeMs);
      const state = this.getBotState();
      const pausedCount = Object.keys(state.paused).length;
      const lastEventMs = this.lastConnectionEventAt
        ? Date.now() - this.lastConnectionEventAt
        : null;
      await this.sendReaction(jid, key, "✅");
      const lines = [
        `🤖 *Lantern* · ${state.muted ? "🔇 muted" : "🟢 active"}`,
        `uptime ${uptimeStr}${this.phoneNumber ? ` · 📞 +${this.phoneNumber}` : ""}`,
        `paused contacts: ${pausedCount} · monitored groups: ${state.monitoredGroups.length}`,
      ];
      if (lastEventMs !== null && lastEventMs > 60_000) {
        lines.push(`last connection event: ${formatUptimeShort(lastEventMs)} ago`);
      }
      if (this.lastError) {
        lines.push(`⚠️ last error: ${this.lastError}`);
      }
      await this.confirmToSelf(lines.join("\n"));
      return;
    }

    if (trimmed === "/lantern ping") {
      // Cheapest possible health check — emoji-only. Confirms the bridge
      // received + processed the message round-trip.
      await this.sendReaction(jid, key, "🏓");
      return;
    }

    // Non-command manual reply in a friend's thread = rolling takeover pause.
    // Skip for groups — the owner typing in a group is normal conversation,
    // not a handoff signal.
    if (!self && !group) {
      this.pauseContact(jid, PAUSE_TTL_MS);
      this.logger.info(
        { from: jid, ttlMs: PAUSE_TTL_MS },
        "agent paused — owner took over"
      );
      this.logActivity(
        "contact_paused",
        `You took over the thread with ${jid.split("@")[0]} — auto-reply paused 60m`,
        { jid, scope: "contact" }
      );
    }
  }

  // Auto-resume timer for time-bounded mutes (e.g. "pause for 2 hours").
  // Replaced on every new time-bounded mute so the most recent wins.
  private autoUnmuteTimer: ReturnType<typeof setTimeout> | null = null;

  // Daily digest tracking — counts since the last digest fired.
  // Counters reset inside the scheduler's collectData callback.
  private repliesSentToday = 0;
  private escalationsToday = 0;
  private digestStopFn: (() => void) | null = null;

  // Set to true once the bridge has been in `connected` state at least
  // once. OfflineMonitor uses this to distinguish first-boot idle
  // (expected, no alert) from post-disconnect idle (worth alerting on).
  private everConnected = false;
  private offlineMonitor: OfflineMonitor | null = null;

  private startOfflineMonitor(): void {
    if (this.offlineMonitor) return;
    const mirror = new EmailMirror(this.logger, { subjectPrefix: "Lantern WhatsApp" });
    this.offlineMonitor = new OfflineMonitor(
      this.logger,
      defaultOfflineMonitorConfig("WhatsApp"),
      mirror,
      {
        getState: () => ({
          state: this.connectionState,
          everConnected: this.everConnected,
          reason: this.lastError,
        }),
      },
    );
    this.offlineMonitor.start();
  }

  private startDailyDigest(): void {
    this.digestStopFn?.();
    const handle = scheduleDigest({
      logger: this.logger,
      cfg: defaultDigestConfig(),
      collectData: () => {
        const now = Date.now();
        const pausedContacts = [...this.pausedUntil.entries()]
          .filter(([, e]) => e.until > now)
          .map(([j, e]) => ({
            label: e.pushName || this.contactNames.get(j) || j.split("@")[0],
            resumesAtMs: e.until,
          }));
        const data = {
          repliesSent: this.repliesSentToday,
          pausedContacts,
          monitoredChats: this.monitoredGroups.size,
          escalations: this.escalationsToday,
          channelLabel: "WhatsApp",
        };
        this.repliesSentToday = 0;
        this.escalationsToday = 0;
        return data;
      },
      deliver: async (body) => {
        await this.confirmToSelf(body);
      },
    });
    this.digestStopFn = handle.stop;
  }

  // Dispatch a parsed NL command from self-chat through the shared
  // executor. The bridge supplies WhatsApp-flavored callbacks (mute,
  // unmute, status, list, etc.) — same shape iMessage uses, so future
  // command additions need exactly one edit (in nl-commands.ts +
  // command-executor.ts) and both channels pick them up.
  private async handleSelfChatCommand(parsed: ParsedCommand): Promise<void> {
    await executeCommand(parsed, {
      channelLabel: "WhatsApp",
      reply: async (text: string) => {
        // confirmToSelf already broadcasts + mirrors via email/telegram.
        await this.confirmToSelf(text);
      },
      mute: async (durationMs?: number) => {
        this.setMuted(true);
        if (this.autoUnmuteTimer) { clearTimeout(this.autoUnmuteTimer); this.autoUnmuteTimer = null; }
        if (durationMs && durationMs > 0) {
          this.autoUnmuteTimer = setTimeout(() => {
            this.setMuted(false);
            this.autoUnmuteTimer = null;
            void this.confirmToSelf("✅ auto-resumed — i'm back online.");
            this.logActivity("bot_on", "Auto-resumed after timed mute", { scope: "self" });
          }, durationMs);
        }
        this.logActivity("bot_off", "Auto-reply turned off via NL command", { scope: "self" });
      },
      unmute: async () => {
        this.setMuted(false);
        if (this.autoUnmuteTimer) { clearTimeout(this.autoUnmuteTimer); this.autoUnmuteTimer = null; }
        this.logActivity("bot_on", "Auto-reply turned on via NL command", { scope: "self" });
      },
      statusBody: () => {
        const now = Date.now();
        const pausedCount = [...this.pausedUntil.entries()].filter(([, e]) => e.until > now).length;
        const phone = this.phoneNumber ? `+${this.phoneNumber}` : "(not paired)";
        return [
          `🟢 *Lantern WhatsApp*`,
          `• bot: ${this.killSwitch ? "🚨 KILL SWITCH ENGAGED" : this.muted ? "off" : "on"}`,
          `• personal-docs: ${this.personalDocsEnabled ? "on" : "off"}`,
          `• paired: ${phone}`,
          `• paused contacts: ${pausedCount}`,
          `• monitored groups: ${this.monitoredGroups.size}`,
          `• uptime: ${Math.round((now - this.startedAt) / 60_000)}m`,
        ].join("\n");
      },
      listPaused: () => {
        const now = Date.now();
        const entries = [...this.pausedUntil.entries()].filter(([, e]) => e.until > now);
        if (entries.length === 0) return "📭 nothing paused.";
        return [
          `⏸ paused contacts (${entries.length}):`,
          ...entries.map(([j, e]) => `• ${e.pushName || j.split("@")[0]} — resumes in ${Math.round((e.until - now) / 60_000)}m`),
        ].join("\n");
      },
      listChats: () => {
        const ids = [...this.monitoredGroups];
        if (ids.length === 0) {
          return "🪙 no monitored groups. open /personal/groups in the dashboard to pick some.";
        }
        return [`👀 monitored groups (${ids.length}):`, ...ids.map((j) => `• ${j.split("@")[0]}`)].join("\n");
      },
      resumeAll: async () => {
        const n = this.pausedUntil.size;
        this.pausedUntil.clear();
        this.saveState();
        this.logActivity("bot_on", `Cleared ${n} per-contact pauses`, { scope: "self" });
      },
      setDocsEnabled: async (enabled: boolean) => {
        this.personalDocsEnabled = enabled;
        this.saveState();
        this.logActivity(enabled ? "bot_on" : "bot_off", `personal-docs ${enabled ? "ENABLED" : "DISABLED"}`, { scope: "self" });
      },
      setKillSwitch: async (engaged: boolean) => {
        this.killSwitch = engaged;
        this.saveState();
        this.logActivity(engaged ? "bot_off" : "bot_on", `🚨 kill switch ${engaged ? "ENGAGED" : "RELEASED"}`, { scope: "self" });
      },
    });
  }

  // Personal-docs Q&A in WhatsApp self-chat. Owner asked about a
  // local file. Search → inject into LLM → reply → optionally attach
  // the file via Baileys's document message type.
  private async handleOwnerDocQuery(
    jid: string,
    query: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null },
  ): Promise<void> {
    if (!this.docs) return;
    this.logger.info({ query: query.slice(0, 80) }, "owner doc query (whatsapp)");
    this.logActivity("attention_dm", `📁 doc query: ${query.slice(0, 60)}`, { scope: "self" });
    // Acknowledge so the user sees instant feedback. We do BOTH a
    // reaction (subtle, on their message) AND a text ack (impossible
    // to miss). Doc queries can take 10-15s for OCR'd PDFs and the
    // reaction alone isn't loud enough.
    try { await this.sendReaction(jid, key, "📁"); } catch {}
    await this.confirmToSelf("📁 one sec — looking through your files…");

    // If the heavy work runs long (>6s), nudge once so the user
    // knows we're still chewing. Cancelled when the work finishes.
    const startedAt = Date.now();
    let progressFired = false;
    const progressTimer = setTimeout(() => {
      progressFired = true;
      void this.confirmToSelf("📷 still scanning — almost there…");
    }, 6000);
    const clearProgress = () => {
      clearTimeout(progressTimer);
      if (progressFired) { /* already informed */ }
    };

    const contextBlock = await this.docs.buildContextBlock(query, { includeBodies: true });
    this.logger.info({ ms: Date.now() - startedAt }, "doc context built (whatsapp)");
    const today = new Date().toISOString().slice(0, 10);
    const systemHint = [
      `You are Lantern — Shekhar's personal agent, replying in his WhatsApp self-chat.`,
      `Today is ${today}. You can search his Mac, read local files (incl. OCR scanned PDFs), and take native actions on his behalf.`,
      ``,
      `STYLE — sophisticated, natural, agentic. Like Jarvis: warm, concise, never robotic.`,
      `  • Direct answers first. No "I'd be happy to" / "feel free".`,
      `  • Lowercase, conversational. 1-3 short lines max.`,
      `  • State the FACT directly when you have it. If the OCR'd content gives the answer, give it. Don't say "check the file".`,
      ``,
      `AGENTIC FOLLOW-UPS — MANDATORY when applicable:`,
      `  • Answer mentions an EXPIRY/DUE DATE/DEADLINE → ALWAYS add a second line offering a calendar reminder.`,
      `    Example: "want me to add a renewal reminder to your calendar 60 days before?"`,
      `  • Answer mentions a NUMBER worth remembering (passport #, license #, account #) → offer to save it as a Note.`,
      `  • Answer references a FILE the user might want → offer to attach it.`,
      `  • If the answer is purely factual and none of the above apply, no offer is needed.`,
      ``,
      `ACTIONS — emit ONE marker per action on its own line at the END of your reply. The bridge executes them.`,
      `  • Attach file:    [ATTACH:/exact/absolute/path] — COPY paths VERBATIM from the context block. Never fabricate.`,
      `  • Calendar event: [CALENDAR:Title|2026-08-19T09:00:00|2026-08-19T10:00:00|Optional notes]  (local TZ, ISO format)`,
      `  • Note:           [NOTE:Title|Body text]`,
      `  • Mail draft:     [MAIL:to@x.com,b@y.com|Subject|Body]  (opens draft in Mail.app for review)`,
      ``,
      `OFFER-then-CONFIRM rule: Don't fire an action on first mention. End reply with a short suggestion. If user confirms next turn ("yes", "sure", "do it"), THEN emit the marker.`,
      ``,
      `PATHS: Many files live under iCloud Drive at /Users/shakes/Library/Mobile Documents/com~apple~CloudDocs/...  — never substitute /Users/shakes/Documents/...`,
      ``,
      contextBlock,
    ].join("\n");

    const draft = await this.agent.respondTo(jid, query, systemHint);
    clearProgress();
    this.logger.info({ totalMs: Date.now() - startedAt, hadDraft: !!draft }, "doc query done (whatsapp)");
    if (!draft) {
      await this.confirmToSelf("(couldn't reach the agent — try again in a sec.)");
      return;
    }

    const { cleanedText: textNoAttach, paths } = extractAttachMarkers(draft);
    const { cleanedText: finalText, calendarEvents, notes, mailDrafts } = extractActionMarkers(textNoAttach);
    // Humanize: friendly dates + guaranteed offer + deterministic
    // execution path on next-turn confirmation.
    const { reply: polished, offer } = humanizeWithOffer(finalText);
    if (polished) {
      await this.confirmToSelf(polished);
    }
    if (offer && jid) {
      this.pendingOffers.set(jid, offer);
    }
    for (const claimedPath of paths) {
      const resolved = await this.docs.resolveAttachPath(claimedPath);
      if (!resolved.ok) {
        this.logger.warn({ claimedPath, reason: resolved.reason }, "ATTACH path unresolved — skipped");
        await this.confirmToSelf(`(couldn't attach — ${resolved.reason})`);
        continue;
      }
      const path = resolved.path;
      if (resolved.rescued) {
        this.logger.info({ claimedPath, rescuedPath: path }, "ATTACH path rescued by basename");
      }
      try {
        await this.sendDocument(jid, path);
      } catch (err) {
        this.logger.warn({ err, path }, "WhatsApp doc send failed");
        await this.confirmToSelf(`(couldn't attach ${path.split("/").pop() || path})`);
      }
    }
    if (this.macActions) {
      for (const ev of calendarEvents) {
        try {
          const res = await this.macActions.createCalendarEvent(ev);
          await this.confirmToSelf(res.ok ? `📅 added to calendar — ${res.detail || ev.title}` : `(calendar failed: ${res.reason})`);
        } catch (err) { this.logger.warn({ err }, "calendar action exception"); }
      }
      for (const n of notes) {
        try {
          const res = await this.macActions.createNote(n);
          await this.confirmToSelf(res.ok ? `🗒 saved as a note — "${n.title}"` : `(note failed: ${res.reason})`);
        } catch (err) { this.logger.warn({ err }, "note action exception"); }
      }
      for (const m of mailDrafts) {
        try {
          const res = await this.macActions.createMailDraft(m);
          await this.confirmToSelf(res.ok ? `✉️ draft opened in Mail — review + send when ready` : `(mail draft failed: ${res.reason})`);
        } catch (err) { this.logger.warn({ err }, "mail action exception"); }
      }
    }
  }

  // Execute a cached offer (calendar reminder / save note).
  // Deterministic, bypasses the LLM. Sends a natural confirmation.
  private async executeCachedOffer(jid: string, offer: PendingOffer): Promise<void> {
    if (!this.macActions) return;
    if (offer.kind === "calendar-reminder" && offer.targetIsoDate && offer.leadDays) {
      const target = new Date(`${offer.targetIsoDate}T09:00:00`);
      const reminderDate = new Date(target.getTime() - offer.leadDays * 86_400_000);
      const startIso = reminderDate.toISOString().slice(0, 19);
      const endIso = new Date(reminderDate.getTime() + 30 * 60_000).toISOString().slice(0, 19);
      try {
        const res = await this.macActions.createCalendarEvent({
          title: offer.title || "Renewal reminder",
          start: startIso,
          end: endIso,
          notes: `Auto-set by Lantern. Original expiration: ${offer.targetIsoDate}.`,
        });
        if (res.ok) {
          const friendly = reminderDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          await this.confirmToSelf(`📅 done — reminder set for ${friendly} (${offer.leadDays} days before). ${res.detail || ""}`);
        } else {
          await this.confirmToSelf(`(couldn't add to calendar: ${res.reason})`);
        }
      } catch (err) {
        this.logger.error({ err }, "calendar offer execution failed");
        await this.confirmToSelf(`(calendar add failed — try again)`);
      }
      return;
    }
    if (offer.kind === "save-note" && offer.noteTitle && offer.noteBody) {
      try {
        const res = await this.macActions.createNote({
          title: offer.noteTitle,
          body: offer.noteBody,
        });
        if (res.ok) {
          await this.confirmToSelf(`🗒 saved as a note — "${offer.noteTitle}". find it in Notes.app.`);
        } else {
          await this.confirmToSelf(`(couldn't save the note: ${res.reason})`);
        }
      } catch (err) {
        this.logger.error({ err }, "note offer execution failed");
        await this.confirmToSelf(`(note save failed — try again)`);
      }
      return;
    }
  }

  // GC pendingOffers — sweep entries older than OFFER_TTL_MS.
  private gcPendingOffers(): void {
    if (this.pendingOffers.size === 0) return;
    const cutoff = Date.now() - WhatsAppSession.OFFER_TTL_MS;
    for (const [key, offer] of this.pendingOffers) {
      if (offer.issuedAt < cutoff) this.pendingOffers.delete(key);
    }
  }

  // Send a local file as a WhatsApp document attachment. Uses
  // Baileys's document message type. Attaches a sensible mimetype
  // based on extension.
  private async sendDocument(jid: string, filePath: string): Promise<void> {
    if (!this.socket || !this.connected) {
      throw new Error("WhatsApp not connected");
    }
    const data = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_FOR_EXT[ext] || "application/octet-stream";
    const fileName = filePath.split("/").pop() || "file";
    const sent = await this.socket.sendMessage(jid, {
      document: data,
      mimetype: mime,
      fileName,
    });
    if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
  }

  private async deleteCommand(
    jid: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null },
    self: boolean
  ) {
    // In self-chat, leave the command visible — it's the owner's own log.
    // In friend threads / groups, delete-for-everyone so others don't see it.
    if (self || !this.socket || !key.id) {
      this.logger.info(
        { self, hasSocket: !!this.socket, hasKeyId: !!key.id },
        "delete-for-everyone skipped"
      );
      return;
    }
    // Baileys needs a complete WAMessageKey. For groups, `participant` is
    // required — without it WhatsApp silently ignores the delete.
    const deleteKey = {
      remoteJid: key.remoteJid || jid,
      fromMe: true,
      id: key.id,
      ...(key.participant ? { participant: key.participant } : {}),
    };
    this.logger.info({ deleteKey }, "sending delete-for-everyone");
    try {
      await this.socket.sendMessage(jid, { delete: deleteKey as never });
      this.logger.info({ id: key.id }, "delete-for-everyone sent");
    } catch (err) {
      this.logger.warn({ err, deleteKey }, "could not delete command message");
    }
  }

  private async confirmToSelf(text: string) {
    // Four parallel delivery channels — fire each so the user sees the
    // bridge's response on at least one channel that happens to be
    // working today. They're independent: failures on one don't gate
    // the others; each is opt-in via its own env vars (except the
    // always-on dashboard broadcast).
    //
    //   1. Dashboard activity feed (always; broadcast over the WS)
    //   2. Email (LANTERN_OWNER_EMAIL — universal, push via Mail app)
    //   3. Telegram bot (LANTERN_OWNER_TELEGRAM_* — when configured)
    //   4. WhatsApp self-chat (best-effort; lossy via Signal pre-key
    //      drift on the user's phone — channels 1-3 are the safety net)
    this.broadcast({
      type: "agent_reply",
      data: { to: this.ownJid() || "self", text, kind: "self_reply", timestamp: Date.now() },
    });
    void this.mirrorToEmail(text);
    void this.mirrorToTelegram(text);

    const own = this.ownJid();
    if (!own || !this.socket) return;
    try {
      const sent = await this.socket.sendMessage(own, { text });
      if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
    } catch (err) {
      this.logger.warn({ err }, "could not send confirmation to self");
    }
  }

  // Email fallback for bridge status messages. Universal — every phone
  // has email + push notifications. Routes through the control-plane's
  // Gmail connector (re-uses the OAuth credentials the user already
  // configured at /connectors), so the bridge doesn't need its own SMTP
  // setup.
  //
  // Throttling: we don't want the user's inbox flooded with one email
  // per /lantern ping reaction. Skip when the SAME text was emailed
  // within the last 30s (covers the retry-storm case). Also skip very
  // short messages (single emojis from reactions etc).
  private lastEmailedAt: Map<string, number> = new Map();
  private static readonly EMAIL_DEDUP_MS = 30_000;
  private static readonly EMAIL_MIN_LEN = 8;
  // Label every Lantern mail with this so the user can filter all
  // status messages out of their main inbox with one Gmail rule. The
  // connector creates the label on first use. Together with
  // `skipInbox: true` below, status mail lands directly under the
  // label without touching INBOX.
  private static readonly EMAIL_LABEL = "lantern";

  // Sanitize a string for use in a mail Subject: header. Strips emoji,
  // markdown asterisks/underscores, control chars and anything outside
  // ASCII printable so Gmail's web view renders cleanly. Subjects with
  // non-ASCII bytes get re-interpreted as Latin-1 by some clients,
  // producing the `Ã,Â·` mojibake seen in screenshots. The backend
  // also RFC-2047-encodes non-ASCII as a defense in depth, but
  // stripping at the source keeps the inbox listing tidy too.
  private sanitizeSubject(raw: string): string {
    // 1. Drop everything past the first newline — subjects are one line.
    let s = raw.split("\n", 1)[0];
    // 2. Strip markdown bold/italic markers — they're noise in subjects.
    s = s.replace(/[*_`~]+/g, "");
    // 3. Strip emoji and any non-printable/non-ASCII byte. The Unicode
    //    'Extended_Pictographic' class covers emoji; we also belt-and-
    //    suspenders strip the whole supplementary-plane range.
    s = s.replace(/\p{Extended_Pictographic}/gu, "");
    s = s.replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
    s = s.replace(/[\u{2600}-\u{27BF}]/gu, ""); // misc symbols/dingbats
    s = s.replace(/[\u{2300}-\u{23FF}]/gu, ""); // technical/misc tech
    // 4. Replace non-ASCII bytes (e.g. `·` U+00B7) with a clean ASCII
    //    dash so we don't lose structure.
    s = s.replace(/[^\x20-\x7E]/g, "-");
    // 5. Collapse runs of dashes/spaces and trim.
    s = s.replace(/[-\s]{2,}/g, " ").replace(/^[-\s]+|[-\s]+$/g, "");
    return s.slice(0, 100).trim();
  }

  private async mirrorToEmail(text: string): Promise<void> {
    const to = process.env.LANTERN_OWNER_EMAIL;
    if (!to) return;
    if (text.length < WhatsAppSession.EMAIL_MIN_LEN) return;
    const lastAt = this.lastEmailedAt.get(text);
    if (lastAt && Date.now() - lastAt < WhatsAppSession.EMAIL_DEDUP_MS) return;
    this.lastEmailedAt.set(text, Date.now());

    // First non-empty line becomes the subject, sanitized to ASCII so
    // Gmail renders it without mojibake. The full text (with emoji +
    // markdown intact) goes in the body — that part is rendered as
    // UTF-8 plain-text which Gmail handles fine.
    const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
    const cleaned = this.sanitizeSubject(firstLine) || "status";
    const subject = `Lantern: ${cleaned}`;
    try {
      const res = await authedFetch(
        `/v1/connectors/gmail/execute?action=send_message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to,
            subject,
            body: text,
            // Connector creates this label on first use, then applies
            // it to the sent message and strips INBOX so the user's
            // main inbox stays clean. See connector_executor.go
            // applyGmailLabel.
            label: WhatsAppSession.EMAIL_LABEL,
            skipInbox: true,
          }),
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn(
          { status: res.status, body: body.slice(0, 200) },
          "email mirror failed",
        );
      } else {
        // Backend swallows label-application failures so the send
        // itself never fails — but it surfaces them in the response as
        // `labelWarning`. Log that here so users notice when the OAuth
        // token lacks gmail.modify (the scope needed to remove INBOX
        // and apply the lantern label). Fix is to reconnect Gmail at
        // /connectors so the new scope gets included.
        try {
          const json = (await res.clone().json()) as Record<string, any>;
          const warn = json?.result?.labelWarning ?? json?.labelWarning;
          if (warn) {
            this.logger.warn(
              { warn },
              "email mirror sent but label/skip-inbox failed — reconnect Gmail at /connectors so the new OAuth scope (gmail.modify) is granted",
            );
          }
        } catch {
          // not fatal — labelWarning is best-effort
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "email mirror request errored");
    }
  }

  // Telegram fallback for bridge status messages. Reliable delivery on
  // mobile when WhatsApp's Signal session is in stale-key purgatory
  // (the 'Waiting for this message' loop). Setup: BotFather → /newbot
  // → paste the token into LANTERN_OWNER_TELEGRAM_BOT_TOKEN, get your
  // chat id (any of multiple methods — message @userinfobot or just
  // hit api.telegram.org/bot<token>/getUpdates after you DM the bot)
  // → set LANTERN_OWNER_TELEGRAM_CHAT_ID.
  //
  // Fire-and-forget: failures log a warning but never block the WA
  // path or throw to the caller. Skipped silently when env not set so
  // users who don't want telegram never see noise.
  private async mirrorToTelegram(text: string): Promise<void> {
    const token = process.env.LANTERN_OWNER_TELEGRAM_BOT_TOKEN;
    const chatId = process.env.LANTERN_OWNER_TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          // Markdown to match WhatsApp's *bold* / `code` rendering we
          // use in /lantern status / help replies.
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.warn(
          { status: res.status, body: body.slice(0, 200) },
          "telegram mirror failed",
        );
      }
    } catch (err) {
      this.logger.warn({ err }, "telegram mirror request errored");
    }
  }

  private isGroupJid(jid: string) {
    return jid.endsWith("@g.us");
  }

  // Scan pauses on every tick. For each entry:
  //  - if it's already expired, drop it.
  //  - if the owner hasn't been warned yet AND we're inside the lead window
  //    (`until - now <= PAUSE_WARN_LEAD_MS`), mark warned and buffer a DM.
  // Entries deep in the future are ignored. An indefinite pause (`/bot off`
  // for a contact) never hits the lead window so no warning fires for it,
  // which is exactly what we want.
  private checkPauseExpiries() {
    const now = Date.now();
    let buffered = false;
    for (const [jid, entry] of this.pausedUntil) {
      if (entry.until <= now) {
        this.pausedUntil.delete(jid);
        continue;
      }
      if (entry.warned) continue;
      const remaining = entry.until - now;
      if (remaining > PAUSE_WARN_LEAD_MS) continue;
      entry.warned = true;
      this.pendingWarnings.push({ jid, pushName: entry.pushName });
      buffered = true;
    }
    if (buffered) {
      this.saveState();
      this.scheduleWarningFlush();
    }
  }

  private scheduleWarningFlush() {
    if (this.warningFlushTimer) return;
    this.warningFlushTimer = setTimeout(() => {
      this.warningFlushTimer = null;
      void this.flushWarnings();
    }, PAUSE_WARN_FLUSH_MS);
    this.warningFlushTimer.unref?.();
  }

  // Emit a single batched DM for every pause that crossed the warn lead
  // threshold in this flush window. We filter against the current pause map
  // to skip jids the owner resumed (`/bot on`) or re-paused explicitly —
  // either action already replaced the warning with an authoritative signal.
  private async flushWarnings() {
    const drained = this.pendingWarnings;
    this.pendingWarnings = [];
    if (drained.length === 0) return;

    const live = drained.filter((w) => this.pausedUntil.has(w.jid));
    if (live.length === 0) return;

    const names = live.map(
      (w) => w.pushName || `+${w.jid.split("@")[0]}`
    );
    const leadMin = Math.round(PAUSE_WARN_LEAD_MS / 60_000);
    const body =
      live.length === 1
        ? `⏰ auto-replies resume in ~${leadMin}m for ${names[0]}.\nreply there to extend, or type \`/bot off\` in their thread to keep the bot off.`
        : `⏰ auto-replies resume in ~${leadMin}m for: ${formatNameList(names)}.\nreply in each thread to extend, or type \`/bot off\` to keep the bot off.`;

    const own = this.ownJid();
    if (!own || !this.socket) {
      // No self-chat yet (not paired) — silently drop; a fresh warning will
      // fire on the next tick if the pauses are still in the window.
      for (const w of live) {
        const entry = this.pausedUntil.get(w.jid);
        if (entry) entry.warned = false;
      }
      return;
    }

    try {
      const sent = await this.socket.sendMessage(own, { text: body });
      if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
      this.logger.info({ count: live.length }, "pause expiry warning sent");
    } catch (err) {
      this.logger.warn({ err }, "could not send pause expiry warning");
      // On send failure, un-warn so the next tick re-tries once (we stop
      // re-trying after the pause actually expires because expired entries
      // are dropped in checkPauseExpiries before re-warning).
      for (const w of live) {
        const entry = this.pausedUntil.get(w.jid);
        if (entry) entry.warned = false;
      }
    }
  }

  private async checkAttention(
    from: string,
    text: string,
    pushName?: string,
    isGroup = false
  ) {
    if (!this.attention.enabled()) return;
    if (!this.attention.shouldNotify(from)) return;

    const verdict = await this.attention.classify(text, pushName, isGroup);
    if (!verdict || !verdict.urgent) return;

    const own = this.ownJid();
    if (!own || !this.socket) return;

    const who = pushName || from.split("@")[0];
    const origin = isGroup ? ` in group ${from.split("@")[0]}` : "";
    const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
    const body =
      `⚠️ heads up — ${who}${origin} might need you\n\n` +
      `"${preview}"\n\n` +
      `why: ${verdict.reason || verdict.summary || "flagged as urgent"}`;

    try {
      const sent = await this.socket.sendMessage(own, { text: body });
      if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
      this.attention.markNotified(from);
      this.logger.info(
        { from, reason: verdict.reason },
        "attention DM sent to owner"
      );
      this.logActivity(
        "attention_dm",
        `Flagged urgent message from ${pushName || from.split("@")[0]}`,
        { jid: from, pushName, scope: isGroup ? "group" : "contact" }
      );
    } catch (err) {
      this.logger.warn({ err }, "could not DM attention notice");
    }
  }

  private async handleAgentReply(
    from: string,
    text: string,
    opts: {
      isGroup?: boolean;
      senderName?: string;
      msgKey?: {
        id?: string | null;
        remoteJid?: string | null;
        fromMe?: boolean | null;
        participant?: string | null;
      };
      // Full Baileys IWebMessageInfo — used as `quoted` so the reply
      // visually quotes the inbound in WhatsApp. Helpful in busy
      // group threads.
      quotedMsg?: import("baileys").proto.IWebMessageInfo;
    } = {}
  ) {
    if (!this.socket) return;

    // First pass: maybe this doesn't deserve a full reply at all. Cheap
    // text-only check — no LLM round-trip. If they sent "k" or "👍" we
    // mirror back a reaction (or stay silent) instead of typing back a
    // chatbot-style sentence. This is the single biggest "feel natural"
    // lever in the whole pipeline.
    const verdict = shouldRespond(text);
    if (!verdict.respond) {
      if (verdict.reaction && opts.msgKey?.id) {
        await this.sendReaction(from, opts.msgKey, verdict.reaction);
      }
      this.broadcast({
        type: "agent_reply",
        data: {
          to: from,
          text: verdict.reaction ?? "(no reply — ack)",
          reaction: verdict.reaction,
          skipped: !verdict.reaction,
          reason: verdict.reason,
          timestamp: Date.now(),
        },
      });
      return;
    }

    // Escalation guard: urgent/health/money/legal/emotional content MUST
    // route to the human, not a bot. Skip auto-reply + DM the owner via
    // the existing mirror channels so they see the heads-up immediately.
    const escalation = detectEscalation(text);
    if (escalation.escalate && !opts.isGroup) {
      this.escalationsToday += 1;
      const senderLabel = opts.senderName || from.split("@")[0];
      const alertBody = [
        `🚨 *Escalation: ${senderLabel}*`,
        "",
        `Reason: _${escalation.reason}_`,
        "",
        `> ${text.slice(0, 300)}`,
        "",
        "Auto-reply was suppressed — please respond yourself.",
      ].join("\n");
      void this.mirrorToEmail(alertBody);
      void this.mirrorToTelegram(alertBody);
      this.broadcast({
        type: "activity",
        data: {
          kind: "attention_dm",
          summary: `escalated to you: ${escalation.reason}`,
          detail: text.slice(0, 200),
          jid: from,
          pushName: opts.senderName,
          timestamp: Date.now(),
        },
      });
      // Also pause auto-reply for this contact so a follow-up message
      // doesn't get auto-replied to before the user has handled it.
      this.pauseContact(from);
      return;
    }

    // Quiet hours: skip auto-reply during sleeping hours so contacts
    // don't see "you" replying at 3am — biggest bot-tell short of an
    // instant typing indicator. The user gets the inbound notification
    // on their phone like normal; the assistant just stays silent until
    // morning. Group threads are exempt (groups already require the
    // owner be @mentioned to trigger a reply).
    if (!opts.isGroup) {
      const qh = defaultQuietHours();
      if (isQuietHours(new Date(), qh)) {
        this.logger.info({ from, hour: new Date().getHours() }, "agent skipped — quiet hours");
        this.broadcast({
          type: "activity",
          data: {
            kind: "agent_skipped",
            summary: "quiet hours — auto-reply paused",
            jid: from,
            timestamp: Date.now(),
          },
        });
        return;
      }
    }

    // Build the persona prompt from this contact's recent inbound style.
    // Groups share a single style bucket — see rememberInbound.
    const styleKey = opts.isGroup ? `group:${from}` : from;
    const history = this.inboundHistory.get(styleKey) ?? [];
    const style = inferStyle(history);
    const ownerName =
      this.displayName || process.env.LANTERN_OWNER_NAME || OWNER_NAME;
    // (Removed: the upfront "Hey, X's assistant here — I'll keep things
    //  moving" disclosure that previously fired on first contact. It read
    //  like spam, scared contacts, and broke the natural flow. The persona
    //  prompt below tells the LLM to text AS the owner by default; if a
    //  contact directly asks "is this a bot / are you really X", the
    //  persona allows a casual acknowledgement instead of a formal
    //  announcement. To opt back in to the old behavior, set
    //  LANTERN_AGENT_HANDOFF_MESSAGE — but think hard before doing it.)
    if (
      !opts.isGroup &&
      !this.disclosedJids.has(from) &&
      process.env.LANTERN_AGENT_HANDOFF_MESSAGE?.trim()
    ) {
      const disclosure = process.env.LANTERN_AGENT_HANDOFF_MESSAGE.trim();
      try {
        await this.sendMessage(from, disclosure);
        this.broadcast({
          type: "agent_reply",
          data: {
            to: from,
            text: disclosure,
            kind: "handoff_disclosure",
            timestamp: Date.now(),
          },
        });
      } catch (err) {
        this.logger.warn({ err, jid: from }, "handoff disclosure failed");
      }
      this.disclosedJids.add(from);
      this.saveState();
    }
    const ownerSamples = opts.isGroup
      ? []
      : this.ownerSentHistory.get(from) ?? [];
    const stylePrompt = await this.agent.getStylePrompt();
    let systemHint = agentPersonaPrompt(
      ownerName,
      style,
      !!opts.isGroup,
      {
        ownerSamples,
        disclosed: this.disclosedJids.has(from),
        stylePrompt,
      }
    );

    // Inject durable contact facts ("her daughter is Maya", "works at
    // Stripe") so the assistant doesn't cold-start each conversation.
    // Empty string when no facts exist — zero overhead.
    if (!opts.isGroup) {
      const factsBlock = await this.personal.factsBlock(from);
      if (factsBlock) systemHint += factsBlock;
    }

    // Calendar-aware availability: cheap keyword probe gates the
    // calendar call so we don't fetch on every reply.
    if (!opts.isGroup && needsCalendar(text)) {
      const calBlock = await this.calendar.upcomingBlock(8);
      if (calBlock) systemHint += calBlock;
    }

    // In groups, annotate the user message so the agent knows it's in a group
    // and who sent it — otherwise the prompt has no way to tell 1-on-1 from
    // group context, and no way to reference the speaker by name.
    const userText = opts.isGroup
      ? `[group message from ${opts.senderName || "a participant"}]\n${text}`
      : text;

    // Kick off the LLM call IMMEDIATELY but do NOT show "composing…"
    // yet. A bot-tell is the typing indicator appearing instantly —
    // humans don't start typing the moment a message arrives. The LLM
    // round-trip happens in parallel with the natural read delay below;
    // by the time the read delay ends, the draft is usually already
    // available so we can switch on "composing" then.
    const draftPromise = this.agent.respondTo(from, userText, systemHint);

    // Wait for draft + naturalize, but don't block on it during the
    // read phase — we'll respect the pacer's read delay below.
    const draft = await draftPromise;

    if (!draft) {
      // No reply needed — never expose a "composing" tell.
      return;
    }

    // VIP gate: if this contact is on the user's VIP list (boss,
    // parents, top customers, etc.), DON'T send. Queue the draft to
    // the dashboard for one-tap approval instead. This stops the
    // single most-feared scenario: the bot sending something off-tone
    // to the wrong person.
    if (!opts.isGroup && (await this.personal.isVIP(from))) {
      const queued = await this.personal.queueDraft(
        from,
        opts.senderName ?? this.contactNames.get(from) ?? undefined,
        text,
        draft,
        { channel: "whatsapp" },
      );
      this.broadcast({
        type: "activity",
        data: {
          kind: "agent_skipped",
          summary: queued
            ? `VIP draft queued for approval`
            : `VIP — auto-reply suppressed (queue failed)`,
          detail: draft.slice(0, 200),
          jid: from,
          pushName: opts.senderName,
          timestamp: Date.now(),
        },
      });
      this.logger.info({ from, queued: !!queued }, "VIP draft queued");
      return;
    }

    // Naturalize: clean assistantisms, apply style, split into a burst,
    // pace it. The result is the actual sequence of WhatsApp messages.
    const burst = naturalize(draft, { inbound: text, style });
    if (burst.length === 0) {
      return;
    }

    for (let i = 0; i < burst.length; i++) {
      const msg = burst[i];
      // Delay BEFORE showing the composing indicator. For the first
      // message this is "I just saw your message + maybe I was busy"
      // lag (read + optional away). For subsequent burst messages it's
      // the inter-message gap. The composing indicator only fires AFTER
      // the delay so contacts don't see "typing…" appear instantly.
      if (msg.delayBeforeMs > 0) {
        await sleep(msg.delayBeforeMs);
      }
      try {
        await this.socket.sendPresenceUpdate("composing", from);
      } catch {}
      // Typing duration proportional to the message length.
      if (msg.typingMs > 0) {
        await sleep(msg.typingMs);
      }
      // Quote-reply: in noisy group threads humans quote the message
      // they're addressing. In 1-on-1 the next message is implicitly
      // the reply. Only the FIRST burst message quotes — subsequent
      // ones are part of the same thought.
      const quoteThis = i === 0 && opts.isGroup ? opts.quotedMsg : undefined;
      await this.sendMessage(from, msg.text, { quoted: quoteThis });
      // Counted ONCE per burst (only on the first piece) so a 3-message
      // burst still counts as one "reply" in the morning digest.
      if (i === 0) this.repliesSentToday += 1;
      this.broadcast({
        type: "agent_reply",
        data: {
          to: from,
          text: msg.text,
          burstIndex: i,
          burstSize: burst.length,
          timestamp: Date.now(),
        },
      });
    }

    try {
      await this.socket.sendPresenceUpdate("paused", from);
    } catch {}
  }

  // Send a WhatsApp reaction to a specific message — used by the natural
  // layer to mirror "k" / 👍 with a 👍 reaction instead of replying.
  private async sendReaction(
    jid: string,
    key: {
      id?: string | null;
      remoteJid?: string | null;
      fromMe?: boolean | null;
      participant?: string | null;
    },
    emoji: string
  ): Promise<void> {
    if (!this.socket || !key.id) return;
    const reactKey = {
      remoteJid: key.remoteJid || jid,
      fromMe: !!key.fromMe,
      id: key.id,
      ...(key.participant ? { participant: key.participant } : {}),
    };
    try {
      await this.socket.sendMessage(jid, {
        react: { text: emoji, key: reactKey as never },
      });
    } catch (err) {
      this.logger.warn({ err, jid, emoji }, "reaction send failed");
    }
  }

  private rememberInbound(from: string, text: string) {
    const key = this.isGroupJid(from) ? `group:${from}` : from;
    let bucket = this.inboundHistory.get(key);
    if (!bucket) {
      bucket = [];
      this.inboundHistory.set(key, bucket);
    }
    bucket.push(text);
    if (bucket.length > WhatsAppSession.INBOUND_HISTORY_PER_CONTACT) {
      bucket.splice(0, bucket.length - WhatsAppSession.INBOUND_HISTORY_PER_CONTACT);
    }
  }

  // Remember a message the owner just typed from their phone in a 1:1 thread.
  // Drives the few-shot exemplars in the persona — "this is how the human
  // actually writes". Skipped for the self-chat, groups, and slash commands
  // upstream. We persist with state so the buffer survives restarts.
  private rememberOwnerSent(jid: string, text: string) {
    const t = text.trim();
    if (!t || t.length > 280) return;
    let bucket = this.ownerSentHistory.get(jid);
    if (!bucket) {
      bucket = [];
      this.ownerSentHistory.set(jid, bucket);
    }
    bucket.push(t);
    if (bucket.length > WhatsAppSession.OWNER_SENT_PER_CONTACT) {
      bucket.splice(0, bucket.length - WhatsAppSession.OWNER_SENT_PER_CONTACT);
    }
    this.saveState();
  }

  async disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    if (this.pauseTickerTimer) {
      clearInterval(this.pauseTickerTimer);
      this.pauseTickerTimer = null;
    }
    if (this.warningFlushTimer) {
      clearTimeout(this.warningFlushTimer);
      this.warningFlushTimer = null;
    }
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connected = false;
    this.currentQR = null;
  }

  // reset is `disconnect` + nuke the on-disk auth credentials so the next
  // `start()` issues a fresh QR. Required when the user wants to pair a
  // DIFFERENT WhatsApp account — vanilla disconnect leaves the credentials
  // in place and Baileys silently reconnects to the previous account.
  //
  // Also clears the in-memory paired/phoneNumber/displayName so the
  // dashboard stops showing stale identity.
  async reset() {
    await this.disconnect();
    this.paired = false;
    this.phoneNumber = null;
    this.displayName = null;
    this.lastError = null;
    this.lastConnectionEventAt = null;
    this.reconnectAttempts = 0;
    // Wipe the auth directory on disk. Baileys' useMultiFileAuthState
    // restores from `creds.json` + the keys/ subdirectory; remove them
    // both. We rebuild the empty dir so the next start() can write to it
    // without an extra mkdir round-trip.
    try {
      rmSync(this.authDir, { recursive: true, force: true });
      mkdirSync(this.authDir, { recursive: true });
      this.logger.info({ authDir: this.authDir }, "auth credentials wiped");
    } catch (err) {
      this.logger.warn({ err }, "failed to wipe auth credentials");
    }
    this.setConnectionState("idle", "Credentials wiped — ready for fresh pairing");
  }

  isConnected() {
    return this.connected;
  }
  isPaired() {
    return this.paired;
  }
  getPhoneNumber() {
    return this.phoneNumber;
  }
  getName() {
    return this.displayName;
  }
  getCurrentQR() {
    return this.currentQR;
  }
  getQRIssuedAt() {
    return this.qrIssuedAt;
  }
  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  /**
   * Full diagnostic snapshot for the dashboard's "trouble pairing" expander
   * and any future support tooling. Cheap to compute; safe to call from a
   * health probe loop.
   */
  getDiagnostics() {
    return {
      tenantId: this.tenantId,
      state: this.connectionState,
      connected: this.connected,
      paired: this.paired,
      phoneNumber: this.phoneNumber,
      displayName: this.displayName,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      lastStateChangeAt: this.lastStateChangeAt,
      lastConnectionEventAt: this.lastConnectionEventAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      qrIssuedAt: this.qrIssuedAt,
      qrValidMs: QR_VALID_MS,
      authDirPresent: existsSync(this.authDir),
      listeners: this.listeners.size,
    };
  }

  addListener(ws: WebSocket) {
    this.listeners.add(ws);
  }
  removeListener(ws: WebSocket) {
    this.listeners.delete(ws);
  }

  // Wire event for the dashboard's WebSocket stream. `type` and `data` are
  // the required core fields; additional sibling keys (e.g. `issuedAt` on
  // a `qr` event) are forwarded as-is to give clients enough metadata to
  // render countdowns and timing without a follow-up fetch.
  private broadcast(event: { type: string; data: unknown } & Record<string, unknown>) {
    const msg = JSON.stringify(event);
    for (const ws of this.listeners) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
