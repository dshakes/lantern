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
import { AgentClient } from "./agent.js";
import { AttentionClassifier } from "./attention.js";
import {
  agentPersonaPrompt,
  inferStyle,
  naturalize,
  shouldRespond,
} from "./natural.js";
import type { BotState } from "./types.js";

// Display name for the bot-owner used in attention prompts and log lines.
// Configurable so the classifier doesn't hardcode a single user's name.
const OWNER_NAME = process.env.LANTERN_OWNER_NAME || "the owner";

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
  private attention: AttentionClassifier;
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
    this.agent = new AgentClient(this.logger, this.authDir);
    this.attention = new AttentionClassifier(this.logger);
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

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        logger: this.logger,
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
          const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";
          const isGroup = this.isGroupJid(from);

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
          this.handleAgentReply(from, text, { isGroup, senderName, msgKey: msg.key }).catch(
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

  async sendMessage(to: string, text: string) {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }
    // Ensure the JID format is correct
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    const sent = await this.socket.sendMessage(jid, { text });
    if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
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
        };
        this.muted = !!raw.muted;
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

  private isSelfChat(jid: string): boolean {
    const own = this.ownJid();
    return !!own && jid === own;
  }

  private async handleOwnerMessage(
    jid: string,
    text: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null }
  ) {
    const trimmed = text.trim().toLowerCase();
    const self = this.isSelfChat(jid);
    const group = this.isGroupJid(jid);

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
    // Three parallel delivery channels — fire all of them so the user
    // sees the bridge's response regardless of which one happens to be
    // working today:
    //   1. Dashboard activity feed (always — broadcast over the WS)
    //   2. Telegram bot (when LANTERN_OWNER_TELEGRAM_* env vars are set)
    //   3. WhatsApp self-chat (best-effort; can silently lose to stale
    //      Signal keys, which is the whole reason we have channels 1 + 2)
    //
    // No await between them — each is independent. WhatsApp send still
    // gets awaited so we can register bridgeSentIds for echo suppression.
    this.broadcast({
      type: "agent_reply",
      data: { to: this.ownJid() || "self", text, kind: "self_reply", timestamp: Date.now() },
    });
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
    const systemHint = agentPersonaPrompt(
      ownerName,
      style,
      !!opts.isGroup,
      {
        ownerSamples,
        disclosed: this.disclosedJids.has(from),
        stylePrompt,
      }
    );

    // In groups, annotate the user message so the agent knows it's in a group
    // and who sent it — otherwise the prompt has no way to tell 1-on-1 from
    // group context, and no way to reference the speaker by name.
    const userText = opts.isGroup
      ? `[group message from ${opts.senderName || "a participant"}]\n${text}`
      : text;

    // Send "composing…" immediately so the contact sees the human-style
    // typing indicator while we wait on the LLM. We re-send it before each
    // burst message to keep the indicator alive (Baileys flips it off
    // after a few seconds of inactivity).
    try {
      await this.socket.sendPresenceUpdate("composing", from);
    } catch {}

    const draft = await this.agent.respondTo(from, userText, systemHint);

    if (!draft) {
      try {
        await this.socket.sendPresenceUpdate("paused", from);
      } catch {}
      return;
    }

    // Naturalize: clean assistantisms, apply style, split into a burst,
    // pace it. The result is the actual sequence of WhatsApp messages.
    const burst = naturalize(draft, { inbound: text, style });
    if (burst.length === 0) {
      try {
        await this.socket.sendPresenceUpdate("paused", from);
      } catch {}
      return;
    }

    for (let i = 0; i < burst.length; i++) {
      const msg = burst[i];
      // Delay before this message — for the first, that's the "read +
      // think" lag; for subsequent ones it's the inter-burst gap. We've
      // already sent the composing indicator once; refresh it for long waits.
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
      await this.sendMessage(from, msg.text);
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
