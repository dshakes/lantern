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
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import type { Logger } from "pino";
import { AgentClient } from "./agent.js";
import { AttentionClassifier } from "./attention.js";
import type { BotState } from "./types.js";

// Display name for the bot-owner used in attention prompts and log lines.
// Configurable so the classifier doesn't hardcode a single user's name.
const OWNER_NAME = process.env.LANTERN_OWNER_NAME || "the owner";

const PAUSE_TTL_MS =
  Math.max(1, Number(process.env.LANTERN_AGENT_PAUSE_MIN) || 60) * 60_000;
// Explicit `/bot off` in a contact thread pauses that contact for a year —
// effectively indefinite until the owner sends `/bot on` there.
const INDEFINITE_MS = 365 * 24 * 60 * 60_000;

export class WhatsAppSession {
  private tenantId: string;
  private logger: Logger;
  private agent: AgentClient;
  private attention: AttentionClassifier;
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private listeners: Set<WebSocket> = new Set();
  private currentQR: string | null = null;
  private connected = false;
  private paired = false;
  private phoneNumber: string | null = null;
  private displayName: string | null = null;
  private authDir: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  // jid -> epoch_ms when pause expires. Set whenever the owner types into
  // a thread from their own phone; suppresses the agent until it expires or
  // the owner sends "/bot on".
  private pausedUntil: Map<string, number> = new Map();
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

  constructor(tenantId: string, logger: Logger) {
    this.tenantId = tenantId;
    this.logger = logger.child({ tenant: tenantId });
    this.authDir = join(process.cwd(), "auth_sessions", tenantId);
    mkdirSync(this.authDir, { recursive: true });
    this.agent = new AgentClient(this.logger, this.authDir);
    this.attention = new AttentionClassifier(this.logger);
    this.stateFile = join(this.authDir, "agent_state.json");
    this.loadState();
    // GC stale bridgeSentIds every minute so a missed echo doesn't leak mem.
    this.gcTimer = setInterval(() => this.gcBridgeSentIds(), 60_000);
    // unref so the timer doesn't keep the process alive on shutdown.
    this.gcTimer.unref?.();
  }

  private gcBridgeSentIds() {
    const cutoff = Date.now() - WhatsAppSession.BRIDGE_SENT_TTL_MS;
    for (const [id, ts] of this.bridgeSentIds) {
      if (ts < cutoff) this.bridgeSentIds.delete(id);
    }
  }

  async start() {
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
          this.broadcast({ type: "qr", data: qrDataUrl });
          this.logger.info("QR code generated -- scan with WhatsApp");
        }

        if (connection === "open") {
          this.connected = true;
          this.paired = true;
          this.currentQR = null;
          this.reconnectAttempts = 0;

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
            },
          });
        }

        if (connection === "close") {
          this.connected = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output
            ?.statusCode;
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut;

          this.logger.info(
            { statusCode, shouldReconnect },
            "WhatsApp disconnected"
          );
          this.broadcast({ type: "disconnected", data: { statusCode } });

          try {
            this.socket?.ev.removeAllListeners("connection.update");
            this.socket?.ev.removeAllListeners("creds.update");
            this.socket?.ev.removeAllListeners("messages.upsert");
          } catch {}
          this.socket = null;

          if (shouldReconnect && !this.reconnectTimer) {
            this.reconnectAttempts += 1;
            const delay = Math.min(
              30_000,
              1_000 * 2 ** Math.min(this.reconnectAttempts, 5)
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
            await this.handleOwnerMessage(from, text, msg.key);
            continue;
          }

          if (m.type !== "notify" || !text) continue;

          // Groups are opt-in: silently skip anything not on the monitor list.
          if (isGroup && !this.isMonitoredGroup(from)) continue;

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
          this.handleAgentReply(from, text, { isGroup, senderName }).catch(
            (err) => this.logger.error({ err, from }, "agent reply failed")
          );
        }
      });
    } catch (err) {
      this.logger.error({ err }, "Failed to start WhatsApp session");
      this.broadcast({ type: "error", data: { message: String(err) } });
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
   * cleaned up lazily here — no background timer needed.
   */
  isPaused(jid: string): boolean {
    const until = this.pausedUntil.get(jid);
    if (!until) return false;
    if (Date.now() >= until) {
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
   */
  pauseContact(jid: string, ttlMs: number = PAUSE_TTL_MS) {
    this.pausedUntil.set(jid, Date.now() + ttlMs);
    this.saveState();
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

  /**
   * Snapshot of everything the dashboard / commands need to render.
   * Expired pauses are filtered out before publishing.
   */
  getBotState(): BotState {
    const paused: Record<string, number> = {};
    const now = Date.now();
    for (const [jid, until] of this.pausedUntil) {
      if (until > now) paused[jid] = until;
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
    const legacyFile = join(this.authDir, "agent_paused.json");
    let loaded = false;
    if (existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
          muted?: boolean;
          pausedUntil?: Record<string, number>;
          monitoredGroups?: string[];
        };
        this.muted = !!raw.muted;
        const now = Date.now();
        for (const [jid, until] of Object.entries(raw.pausedUntil ?? {})) {
          if (typeof until === "number" && until > now) {
            this.pausedUntil.set(jid, until);
          }
        }
        for (const g of raw.monitoredGroups ?? []) {
          if (typeof g === "string") this.monitoredGroups.add(g);
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
            this.pausedUntil.set(jid, until);
          }
        }
        this.saveState();
      } catch (err) {
        this.logger.warn({ err }, "could not migrate agent_paused.json");
      }
    }
  }

  private saveState() {
    try {
      const payload = {
        muted: this.muted,
        pausedUntil: Object.fromEntries(this.pausedUntil),
        monitoredGroups: [...this.monitoredGroups],
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
      return;
    }
    if (group && trimmed === "/bot monitor off") {
      this.unmonitorGroup(jid);
      await this.deleteCommand(jid, key, false);
      await this.confirmToSelf(`🙈 stopped monitoring this group.`);
      return;
    }

    if (trimmed === "/bot off") {
      if (self) this.setMuted(true);
      else this.pauseContact(jid, INDEFINITE_MS);
      await this.deleteCommand(jid, key, self);
      await this.confirmToSelf(
        self
          ? "🔇 bot off — I won't auto-reply to anyone until `/bot on`."
          : `🔇 bot off for ${jid.split("@")[0]}.`
      );
      return;
    }

    if (trimmed === "/bot on") {
      if (self) {
        this.setMuted(false);
      } else {
        this.resumeContact(jid);
      }
      await this.deleteCommand(jid, key, self);
      await this.confirmToSelf(
        self
          ? "🔊 bot on — auto-reply resumed everywhere."
          : `🔊 bot on for ${jid.split("@")[0]}.`
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

    // Non-command manual reply in a friend's thread = rolling takeover pause.
    // Skip for groups — the owner typing in a group is normal conversation,
    // not a handoff signal.
    if (!self && !group) {
      this.pauseContact(jid, PAUSE_TTL_MS);
      this.logger.info(
        { from: jid, ttlMs: PAUSE_TTL_MS },
        "agent paused — owner took over"
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
    const own = this.ownJid();
    if (!own || !this.socket) return;
    try {
      const sent = await this.socket.sendMessage(own, { text });
      if (sent?.key?.id) this.bridgeSentIds.set(sent.key.id, Date.now());
    } catch (err) {
      this.logger.warn({ err }, "could not send confirmation to self");
    }
  }

  private isGroupJid(jid: string) {
    return jid.endsWith("@g.us");
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
    } catch (err) {
      this.logger.warn({ err }, "could not DM attention notice");
    }
  }

  private async handleAgentReply(
    from: string,
    text: string,
    opts: { isGroup?: boolean; senderName?: string } = {}
  ) {
    if (!this.socket) return;
    try {
      await this.socket.sendPresenceUpdate("composing", from);
    } catch {}

    // In groups, annotate the user message so the agent knows it's in a group
    // and who sent it — otherwise the prompt has no way to tell 1-on-1 from
    // group context, and no way to reference the speaker by name.
    const userText = opts.isGroup
      ? `[group message from ${opts.senderName || "a participant"}]\n${text}`
      : text;

    const reply = await this.agent.respondTo(from, userText);

    try {
      await this.socket.sendPresenceUpdate("paused", from);
    } catch {}

    if (!reply) return;

    await this.sendMessage(from, reply);
    this.broadcast({
      type: "agent_reply",
      data: { to: from, text: reply, timestamp: Date.now() },
    });
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
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connected = false;
    this.currentQR = null;
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

  addListener(ws: WebSocket) {
    this.listeners.add(ws);
  }
  removeListener(ws: WebSocket) {
    this.listeners.delete(ws);
  }

  private broadcast(event: { type: string; data: unknown }) {
    const msg = JSON.stringify(event);
    for (const ws of this.listeners) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
