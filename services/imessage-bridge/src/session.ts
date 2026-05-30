// Per-tenant iMessage session. Holds:
//   - chat.db reader (polling loop)
//   - AppleScript sender
//   - bot state (mute, paused contacts, monitored chats) — same shape
//     as the WhatsApp bridge so the dashboard renders both uniformly
//   - WebSocket broadcaster for dashboard live updates
//
// Lifecycle is dead simple compared to WhatsApp:
//   - No pairing / QR — iMessage is paired by virtue of being signed
//     into iCloud on this Mac. We just check Full Disk Access + Automation
//     permissions and report status to the dashboard.
//   - No reconnect logic — sqlite + AppleScript are local.
//   - No conflict state — there's no "another session stole the slot".
//
// What's the same as WhatsApp:
//   - Owner controls (bot mute, contact pause on user typing)
//   - Per-contact natural-reply persona, paced bursts
//   - Mirror to email when configured
//   - Persisted state in bridge_state/<tenant>/

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { basename, join } from "path";
import type { Logger } from "pino";
import type { WebSocket } from "ws";

import { ChatDB, appleNsToUnixMs, type IMessageRow } from "./chat-db.js";
import { IMessageSender } from "./applescript.js";
import { AgentClient } from "@lantern/bridge-core/agent";
import { MediaHandler, type MediaAnnotation } from "./media.js";
import { PersonalClient, parseRememberCommand } from "@lantern/bridge-core/personal";
import { extractAutoFacts } from "@lantern/bridge-core/fact-extractor";
import { CalendarLookup, needsCalendar } from "@lantern/bridge-core/calendar";
import {
  agentPersonaPrompt,
  defaultQuietHours,
  detectBotTells,
  detectEscalation,
  inferStyle,
  isQuietHours,
  naturalize,
  shouldRespond,
} from "@lantern/bridge-core/natural";
import { parseNLCommand, type ParsedCommand } from "@lantern/bridge-core/nl-commands";
import { executeCommand } from "@lantern/bridge-core/command-executor";
import { parseVoiceCommand } from "@lantern/bridge-core/voice-commands";
import { scheduleDigest, defaultDigestConfig } from "@lantern/bridge-core/daily-digest";
import { OfflineMonitor, defaultOfflineMonitorConfig } from "@lantern/bridge-core/offline-monitor";
import { EmailMirror } from "@lantern/bridge-core/email-mirror";
import {
  PersonalDocs,
  defaultPersonalDocsConfig,
  isTrivialChatter,
  extractAttachMarkers,
} from "@lantern/bridge-core/personal-docs";
import { isBotSelfMessage } from "@lantern/bridge-core/bot-self";
import { detectLanguageHints, languageModalityHint } from "@lantern/bridge-core/language";
import { looksLikeRosterQuery, prefetchRoster, formatRosterBlock, type RosterPrefetchAdapter } from "@lantern/bridge-core/roster";

// Normalize a text body for echo dedup. chat.db sometimes mutates
// whitespace, line endings, or casing on round-trips through iCloud
// sync; normalizing to lower-case + collapsed whitespace catches those
// without false-positives.
function normalizeForDedup(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}
import { MacActions, extractActionMarkers } from "@lantern/bridge-core/mac-actions";
import { humanizeWithOffer, looksLikeConfirmation, looksLikeRejection, type PendingOffer } from "@lantern/bridge-core/humanize";
import { defaultConnectorClient, prefetchAppointmentContext, looksLikeAppointmentQuery } from "@lantern/bridge-core/prefetch";
import { OwnerProfileStore } from "@lantern/bridge-core/owner-profile";

export type IMessageConnectionState =
  | "starting"
  | "ready"
  | "permission_required"
  | "messages_not_running"
  | "error";

interface PersistedState {
  muted?: boolean;
  paused?: Record<string, number>; // handle -> until_ms
  monitoredChats?: number[]; // chat ROWIDs to act in
  // 1:1 contacts the owner has explicitly opted in for auto-reply.
  // Default behavior is DENY — friends + family + strangers don't get
  // bot replies unless the owner adds them here. The bot still acts on
  // the owner's own channel (self-chat / dedicated bot DM) regardless.
  enabledContacts?: string[];
  personalDocsEnabled?: boolean; // owner toggle for local-file Q&A; default true
  killSwitch?: boolean;          // master OFF — bot refuses everything except killswitch-off
  // Per-contact tail of messages the owner actually sent (from their
  // phone). Few-shot exemplars for "my voice". Persisted so the voice
  // model isn't reset on every restart (WhatsApp already persisted this;
  // iMessage didn't until now).
  ownerSentHistory?: Record<string, string[]>;
}

const POLL_INTERVAL_MS = 1500;
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const PAUSE_DURATION_MS = 60 * 60_000; // 60 minutes after owner types
const HISTORY_DEPTH = 20; // per-contact inbound/outbound message ring buffer
const OWNER_NAME = process.env.LANTERN_OWNER_NAME || "the owner";

export class IMessageSession {
  readonly tenantId: string;
  private logger: Logger;
  private stateDir: string;
  private stateFile: string;

  private db: ChatDB;
  private sender: IMessageSender;

  private state: IMessageConnectionState = "starting";
  private stateReason: string | null = null;
  private startedAt = Date.now();

  // Bot controls
  private muted = false;
  private pausedUntil: Map<string, number> = new Map();
  private monitoredChats: Set<number> = new Set();
  // 1:1 handles approved for auto-reply. Empty = bot stays silent to
  // everyone but the owner. See PersistedState.enabledContacts.
  private enabledContacts: Set<string> = new Set();
  // Personal-docs Q&A toggle. Default ON. Owner can disable from
  // self-chat at any time with "docs off" — survives restart.
  private personalDocsEnabled = true;
  // Master kill switch. When engaged the bridge IGNORES every inbound
  // (auto-reply, doc queries, commands, mentions) EXCEPT the
  // killswitch-off command itself. Survives restart.
  private killSwitch = false;

  // Subscribers
  private sockets: Set<WebSocket> = new Set();

  // Polling
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Per-handle history for style inference + few-shot owner mimicry.
  // Inbound = what the contact sends; ownerSent = what the user sends
  // themselves (used as exemplars for "talk like Shekhar").
  private inboundHistory: Map<string, string[]> = new Map();
  private ownerSentHistory: Map<string, string[]> = new Map();
  private contactNames: Map<string, string> = new Map(); // handle -> display name

  // Last non-empty handle we saw on an isFromMe row. iMessage's
  // multi-Apple-ID setup leaves some rows with empty handles (synced
  // from another account) — we use this as a fallback target so
  // command replies still reach a real thread.
  private lastSelfHandle: string = "";

  // Bridge-sent message bookkeeping. When we send via AppleScript,
  // the message lands in chat.db with is_from_me=1. The polling loop
  // sees it on the next tick. We need to skip our own sends so they
  // don't trigger the "owner typed → pause contact" pathway. We
  // dedup by message TEXT for a short window since chat.db doesn't
  // give us back the GUID of an AppleScript send directly.
  private recentBridgeSends: Array<{ text: string; ts: number }> = [];
  // Long TTL because:
  //   (a) an SSE-aborted agent turn can leave the bridge idle for 180s,
  //   (b) iCloud sync can drop a backlog of old bot rows into a single
  //       poll tick minutes after they were sent.
  // 1 hour covers both with comfortable margin. Override per-deployment
  // via LANTERN_BRIDGE_SEND_DEDUP_MS (e.g., bump to 6 hours for slow
  // shared-Mac iCloud sync, or shrink for a memory-tight host). The
  // persistent on-disk store (sent.json) survives bridge restarts
  // independently.
  private static readonly BRIDGE_SEND_DEDUP_MS =
    Number(process.env.LANTERN_BRIDGE_SEND_DEDUP_MS) > 0
      ? Number(process.env.LANTERN_BRIDGE_SEND_DEDUP_MS)
      : 60 * 60_000;
  private static readonly BRIDGE_SEND_MAX_ENTRIES =
    Number(process.env.LANTERN_BRIDGE_SEND_MAX_ENTRIES) > 0
      ? Number(process.env.LANTERN_BRIDGE_SEND_MAX_ENTRIES)
      : 500;
  private bridgeSendsPersistPath: string = "";
  private bridgeSendsDirty: boolean = false;
  private bridgeSendsPersistTimer: NodeJS.Timeout | null = null;

  // INBOUND dedup. When the user has TWO Apple IDs signed into
  // Messages.app on this Mac (a common configuration: primary +
  // family-share or bot account), the same logical message lands in
  // chat.db TWICE — once per account's view of the conversation, with
  // different rowids. Without this dedup, handleNewRow fires twice →
  // handleOwnerDocQuery runs twice → the LLM is billed twice and the
  // user sees two slightly different replies. Window is short (5s)
  // because the dual-row gap is sub-second; longer than 5s means a
  // legitimate retry by the user.
  private recentInbound: Array<{ key: string; ts: number; isFromMe: boolean }> = [];
  // 10s catches the cross-device-echo race where the same message
  // lands as is_from_me=1 in one view, then is_from_me=0 in another
  // view ~1-3 seconds later. Generous enough for that gap; tight
  // enough that a legitimate retype-after-typo isn't suppressed.
  private static readonly INBOUND_DEDUP_MS = 10_000;

  // Per-chat cache of the most recent offer we made (e.g. "want me
  // to add a renewal reminder?"). When the user confirms with
  // "yes" / "sure" / "do it" within OFFER_TTL_MS, the bridge fires
  // the action DETERMINISTICALLY — no LLM round trip. Bypasses
  // hallucinations where the LLM claimed "we've already set it"
  // without ever emitting a [CALENDAR:...] marker.
  private pendingOffers: Map<string, PendingOffer> = new Map();
  private static readonly OFFER_TTL_MS = 10 * 60_000; // 10 min

  // Per-chat concurrency lock. A single doc-query / natural-chat
  // round-trip can take 90+ seconds. Without this lock, rapid-fire
  // messages from the owner (or multi-Apple-ID cross-device
  // replays) spawn N parallel pipelines that all reply minutes
  // later — the user sees a flood. The lock auto-clears when the
  // in-flight query finishes (success or error).
  private busyChat: Set<string> = new Set();

  // Latest-wins queue: when a user fires multiple substantive
  // messages while the bot is mid-query, we hold ONLY the most recent
  // one and process it as soon as the current run finishes. Capped
  // implicitly to 1-per-chat because we overwrite on each new message.
  private queuedQuery: Map<string, { text: string; queuedAt: Date | number }> = new Map();
  private static readonly QUEUED_QUERY_TTL_MS = 5 * 60_000; // 5 min — past that, the user has moved on

  // Per-handle cache of the most recent chatRowid. Lets the queue
  // drain (which doesn't have the original row in scope) still pull
  // the correct recent transcript for the active chat — generic,
  // works for any handle, not just the first self-chat we saw.
  private lastChatRowidForHandle: Map<string, number> = new Map();
  // Throttle for the busy-nudge message ("⏳ still working …"). Without
  // this, every inbound while busy fires another nudge, and each
  // nudge cross-device-echoes — easy to send 10+ in a row. Cap at
  // ONE nudge per chat per 30s.
  private lastBusyNudgeAt: Map<string, number> = new Map();
  private static readonly BUSY_NUDGE_THROTTLE_MS = 30_000;

  // Futuristic helpers
  private agent: AgentClient;
  private media: MediaHandler;
  private personal: PersonalClient;
  private calendar: CalendarLookup;
  private docs: PersonalDocs;

  // Public accessor so the HTTP layer can proxy path-restricted
  // personal-docs search/read for the control-plane's LLM tools.
  getDocs(): PersonalDocs { return this.docs; }

  // Public accessor for chat.db search. Exposed to the control-plane
  // LLM tool `search_imessage_history` so cross-source queries like
  // "what did the family group say during my Turkey trip?" can be
  // answered. Returns at most 50 hits.
  searchHistory(opts: {
    keyword?: string;
    sinceMs?: number;
    untilMs?: number;
    handle?: string;
    groupOnly?: boolean;
    limit?: number;
  }): ReturnType<ChatDB["searchMessages"]> {
    return this.db.searchMessages(opts);
  }

  // Pass-through accessors for the iMessage group tools.
  listGroups(): ReturnType<ChatDB["listGroups"]> { return this.db.listGroups(); }
  getGroupMembers(opts: { chatRowid?: number; name?: string }): ReturnType<ChatDB["getGroupMembers"]> {
    return this.db.getGroupMembers(opts);
  }
  private ownerProfileStore: OwnerProfileStore;
  private macActions: MacActions;

  constructor(tenantId: string, baseStateDir: string, logger: Logger) {
    this.tenantId = tenantId;
    this.logger = logger.child({ tenant: tenantId, component: "imessage-session" });
    this.stateDir = join(baseStateDir, tenantId);
    this.stateFile = join(this.stateDir, "bot_state.json");
    this.db = new ChatDB(this.logger);
    this.sender = new IMessageSender(this.logger);
    this.agent = new AgentClient(this.logger, {
      agentName: process.env.LANTERN_IMESSAGE_AGENT_NAME || process.env.LANTERN_AGENT_NAME || "imessage-assistant",
      sessionsFile: join(this.stateDir, "agent_sessions.json"),
    });
    this.media = new MediaHandler(this.logger);
    this.personal = new PersonalClient(this.logger);
    this.calendar = new CalendarLookup(this.logger);
    this.docs = new PersonalDocs(defaultPersonalDocsConfig(this.stateDir), this.logger);
    this.macActions = new MacActions(this.logger);
    this.ownerProfileStore = new OwnerProfileStore(this.logger);

    mkdirSync(this.stateDir, { recursive: true });
    this.loadState();
    this.loadBridgeSends();
  }

  // Open chat.db, check Automation, start polling.
  async start(): Promise<void> {
    this.setState("starting");

    const opened = this.db.open();
    if (!opened.ok) {
      this.setState("permission_required", opened.reason);
      return;
    }

    const access = await this.sender.checkAccess();
    if (!access.ok) {
      if (access.reason.includes("Messages.app not running")) {
        this.setState("messages_not_running", access.reason);
      } else {
        this.setState("permission_required", access.reason);
      }
      return;
    }

    this.setState("ready");
    this.everConnected = true;
    this.startPolling();
    this.startDailyDigest();
    this.startOfflineMonitor();
    this.logger.info("iMessage session ready");
  }

  // True once we've successfully reached `ready` at least once.
  // Used by OfflineMonitor to distinguish first-boot idle (expected,
  // no alert) from post-disconnect idle (worth alerting on).
  private everConnected = false;

  private offlineMonitor: OfflineMonitor | null = null;
  private startOfflineMonitor(): void {
    if (this.offlineMonitor) return;
    const mirror = new EmailMirror(this.logger, { subjectPrefix: "Lantern iMessage" });
    this.offlineMonitor = new OfflineMonitor(
      this.logger,
      defaultOfflineMonitorConfig("iMessage"),
      mirror,
      {
        getState: () => ({
          state: this.state,
          everConnected: this.everConnected,
          reason: this.stateReason,
        }),
      },
    );
    this.offlineMonitor.start();
  }

  // Track session-lifetime stats for the digest. Reset on each
  // digest delivery so each day's report is just the last 24h.
  private repliesSentToday = 0;
  private escalationsToday = 0;
  private digestStopFn: (() => void) | null = null;

  private startDailyDigest(): void {
    this.digestStopFn?.();
    const handle = scheduleDigest({
      logger: this.logger,
      cfg: defaultDigestConfig(),
      collectData: () => {
        const pausedContacts = [...this.pausedUntil.entries()]
          .filter(([, t]) => t > Date.now())
          .map(([h, t]) => ({ label: this.contactLabel(h), resumesAtMs: t }));
        const data = {
          repliesSent: this.repliesSentToday,
          pausedContacts,
          monitoredChats: this.monitoredChats.size,
          escalations: this.escalationsToday,
          channelLabel: "iMessage",
        };
        // Reset counters AFTER snapshotting so the next day starts fresh.
        this.repliesSentToday = 0;
        this.escalationsToday = 0;
        return data;
      },
      deliver: async (body) => {
        const own = this.ownHandleGuess() || this.lastSelfHandle;
        if (!own) {
          this.logger.warn("digest had no delivery target");
          return;
        }
        await this.send(own, body);
      },
    });
    this.digestStopFn = handle.stop;
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.digestStopFn?.();
    this.digestStopFn = null;
    this.offlineMonitor?.stop();
    this.offlineMonitor = null;
    this.db.close();
    this.sockets.forEach((s) => {
      try { s.close(); } catch {}
    });
    this.sockets.clear();
  }

  // Note: previous version of this class accepted an `onInbound`
  // callback that index.ts wired to the agent. We've since moved the
  // agent + natural-reply pipeline INTO the session so it has direct
  // access to inboundHistory, style, facts, calendar — none of which
  // are easy to share across the call boundary.

  // --- HTTP-facing accessors ---------------------------------------------

  diagnostics() {
    return {
      tenantId: this.tenantId,
      state: this.state,
      reason: this.stateReason,
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      muted: this.muted,
      pausedCount: this.pausedUntil.size,
      monitoredChats: [...this.monitoredChats],
      enabledContacts: [...this.enabledContacts],
      chatDb: this.db.diagnostics(),
    };
  }

  isReady(): boolean {
    return this.state === "ready";
  }

  botState() {
    const paused: Record<string, number> = {};
    const now = Date.now();
    for (const [k, v] of this.pausedUntil) {
      if (v > now) paused[k] = v;
    }
    return {
      muted: this.muted,
      paused,
      monitoredChats: [...this.monitoredChats],
      enabledContacts: [...this.enabledContacts],
    };
  }

  listChats() {
    return this.db.listChats();
  }

  // --- actions -----------------------------------------------------------

  mute(): void { this.muted = true; this.persist(); this.broadcast({ type: "activity", data: { kind: "bot_off", summary: "Auto-reply paused", timestamp: Date.now() } }); }
  unmute(): void { this.muted = false; this.persist(); this.broadcast({ type: "activity", data: { kind: "bot_on", summary: "Auto-reply on", timestamp: Date.now() } }); }
  pauseContact(handle: string): void {
    this.pausedUntil.set(handle, Date.now() + PAUSE_DURATION_MS);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "contact_paused", summary: `paused ${handle}`, jid: handle, timestamp: Date.now() } });
  }
  resumeContact(handle: string): void {
    this.pausedUntil.delete(handle);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "contact_resumed", summary: `resumed ${handle}`, jid: handle, timestamp: Date.now() } });
  }
  clearAllPaused(): void {
    this.pausedUntil.clear();
    this.persist();
  }
  monitorChat(rowid: number): void {
    this.monitoredChats.add(rowid);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "monitor_on", summary: `monitoring chat ${rowid}`, timestamp: Date.now() } });
  }

  // --- contact allow-list (1:1 non-owner auto-reply opt-in) -------------
  //
  // Default behavior is DENY: friends, family, and strangers don't get
  // any bot reply. Owner explicitly opts a handle in here; the bridge
  // sends as normal once enabled. Removing a handle stops replies but
  // does NOT delete chat history.
  //
  // Owner channel (self-chat / dedicated bot DM) is exempt — those
  // always work because that's the owner talking to themselves.
  enableContact(handle: string): void {
    const h = this.normalizeHandle(handle);
    if (!h) return;
    this.enabledContacts.add(h);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "contact_enabled", summary: `auto-reply enabled for ${this.contactLabel(h)}`, jid: h, timestamp: Date.now() } });
  }
  disableContact(handle: string): void {
    const h = this.normalizeHandle(handle);
    if (!h) return;
    this.enabledContacts.delete(h);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "contact_disabled", summary: `auto-reply disabled for ${this.contactLabel(h)}`, jid: h, timestamp: Date.now() } });
  }
  listEnabledContacts(): string[] {
    return [...this.enabledContacts];
  }
  private isContactEnabled(handle: string): boolean {
    if (!handle) return false;
    return this.enabledContacts.has(this.normalizeHandle(handle));
  }
  // Parse "allow <handle>" / "deny <handle>" / "allowed" / "list allowed".
  // Returns null when the message isn't one of these commands.
  private parseAllowCommand(text: string): { op: "allow" | "deny" | "list"; handle?: string } | null {
    const t = text.trim();
    if (/^(?:allow(?:ed)?|list\s+allow(?:ed)?|who(?:'s|\s+is)\s+allow(?:ed)?)\s*\??$/i.test(t)) {
      return { op: "list" };
    }
    const allow = t.match(/^allow\s+(.+?)\s*$/i);
    if (allow) return { op: "allow", handle: allow[1] };
    const deny = t.match(/^(?:deny|disable|remove)\s+(.+?)\s*$/i);
    if (deny) return { op: "deny", handle: deny[1] };
    return null;
  }

  private async handleAllowCommand(
    replyTo: string,
    cmd: { op: "allow" | "deny" | "list"; handle?: string },
  ): Promise<void> {
    const send = async (body: string) => {
      if (!replyTo) return;
      const res = await this.send(replyTo, body);
      if (!res.ok) {
        this.logger.warn({ replyTo, reason: res.reason }, "allow-command reply failed");
      }
    };
    if (cmd.op === "list") {
      const list = this.listEnabledContacts();
      if (list.length === 0) {
        await send("📭 allow-list empty — bot only replies to you.\nadd a contact with: allow <phone-or-email>");
      } else {
        await send(`✅ auto-reply enabled for ${list.length}:\n${list.map((h) => `• ${this.contactLabel(h)}`).join("\n")}`);
      }
      return;
    }
    const handle = (cmd.handle || "").trim();
    if (!handle) {
      await send("usage: allow <phone-or-email> | deny <phone-or-email> | allowed");
      return;
    }
    if (cmd.op === "allow") {
      this.enableContact(handle);
      await send(`✅ allow-listed ${this.contactLabel(handle)} — i'll auto-reply to them now.`);
    } else {
      this.disableContact(handle);
      await send(`🔒 removed ${this.contactLabel(handle)} from allow-list — i'll stay silent to them.`);
    }
  }

  private normalizeHandle(handle: string): string {
    // iMessage handles come in two shapes: phone (`+15125551234`) and
    // email. Trim whitespace + lowercase emails so the allow-list is
    // case-insensitive for emails but exact for phones.
    const t = (handle || "").trim();
    if (!t) return "";
    return t.includes("@") ? t.toLowerCase() : t;
  }

  unmonitorChat(rowid: number): void {
    this.monitoredChats.delete(rowid);
    this.persist();
    this.broadcast({ type: "activity", data: { kind: "monitor_off", summary: `unmonitoring chat ${rowid}`, timestamp: Date.now() } });
  }

  async send(to: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.state !== "ready") {
      return { ok: false, reason: `bridge not ready (state=${this.state})` };
    }
    const res = await this.sender.send(to, text);
    if (!res.ok) return res;
    // Record so the polling loop skips this row when chat.db echoes
    // it back as is_from_me=1.
    this.recordBridgeSend(text);
    this.broadcast({
      type: "agent_reply",
      data: { to, text, timestamp: Date.now() },
    });
    return { ok: true };
  }

  private recordBridgeSend(text: string): void {
    const now = Date.now();
    // GC + cap so an unbounded conversation doesn't grow the array.
    this.recentBridgeSends = this.recentBridgeSends.filter(
      (e) => now - e.ts < IMessageSession.BRIDGE_SEND_DEDUP_MS,
    );
    this.recentBridgeSends.push({ text, ts: now });
    if (this.recentBridgeSends.length > IMessageSession.BRIDGE_SEND_MAX_ENTRIES) {
      this.recentBridgeSends.splice(0, this.recentBridgeSends.length - IMessageSession.BRIDGE_SEND_MAX_ENTRIES);
    }
    this.bridgeSendsDirty = true;
    this.scheduleBridgeSendsPersist();
  }

  private isOwnBridgeSend(text: string): boolean {
    const now = Date.now();
    // Normalize: trim + collapse whitespace + lowercase so chat.db
    // whitespace mutations / line-ending differences don't miss.
    const norm = normalizeForDedup(text);
    for (let i = this.recentBridgeSends.length - 1; i >= 0; i--) {
      const e = this.recentBridgeSends[i];
      if (now - e.ts > IMessageSession.BRIDGE_SEND_DEDUP_MS) break;
      if (normalizeForDedup(e.text) === norm) {
        // Do NOT consume — the same reply can land in chat.db twice
        // when the Mac is signed into multiple iMessage accounts
        // (once as is_from_me=1 from the sending account, once as
        // is_from_me=0 from the receiving account's own sync view).
        // Both arrivals must be deduped. Entry is GC'd by
        // recordBridgeSend after BRIDGE_SEND_DEDUP_MS.
        return true;
      }
    }
    return false;
  }

  // Persist `recentBridgeSends` to disk so a bridge restart (launchd
  // respawn after SIGTERM, OS reboot, etc.) doesn't lose dedup state.
  // Without this, the bot's prior-session ack messages would be re-
  // processed as fresh queries when chat.db echoes them back on first
  // poll. Debounced: at most one write per 5s.
  private static readonly BRIDGE_SENDS_PERSIST_DEBOUNCE_MS = 5_000;
  private loadBridgeSends(): void {
    this.bridgeSendsPersistPath = join(this.stateDir, "sent.json");
    try {
      if (!existsSync(this.bridgeSendsPersistPath)) return;
      const raw = readFileSync(this.bridgeSendsPersistPath, "utf-8");
      const data = JSON.parse(raw) as { sends?: Array<{ text: string; ts: number }> };
      const now = Date.now();
      const valid = (data.sends || []).filter(
        (e) => typeof e.text === "string" && typeof e.ts === "number" && now - e.ts < IMessageSession.BRIDGE_SEND_DEDUP_MS,
      );
      this.recentBridgeSends = valid.slice(-IMessageSession.BRIDGE_SEND_MAX_ENTRIES);
      this.logger.info({ loaded: this.recentBridgeSends.length }, "loaded bridge-send dedup");
    } catch (err) {
      this.logger.warn({ err }, "failed to load bridge-send dedup — starting fresh");
    }
  }
  private scheduleBridgeSendsPersist(): void {
    if (this.bridgeSendsPersistTimer) return;
    this.bridgeSendsPersistTimer = setTimeout(() => {
      this.bridgeSendsPersistTimer = null;
      if (!this.bridgeSendsDirty) return;
      try {
        writeFileSync(this.bridgeSendsPersistPath, JSON.stringify({ sends: this.recentBridgeSends }));
        this.bridgeSendsDirty = false;
      } catch (err) {
        this.logger.warn({ err }, "failed to persist bridge-send dedup");
      }
    }, IMessageSession.BRIDGE_SENDS_PERSIST_DEBOUNCE_MS);
  }

  // --- WS ----------------------------------------------------------------

  attachSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    // Send current state as a hello frame.
    try {
      ws.send(JSON.stringify({ type: "connection_state", data: { state: this.state, reason: this.stateReason } }));
    } catch {}
  }

  // --- internals ---------------------------------------------------------

  private setState(s: IMessageConnectionState, reason?: string): void {
    if (this.state === s && !reason) return;
    this.state = s;
    this.stateReason = reason ?? null;
    this.logger.info({ state: s, reason }, "state transition");
    this.broadcast({
      type: "connection_state",
      data: { state: s, reason: reason ?? null, since: Date.now() },
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      try {
        const rows = this.db.pollNewMessages();
        if (rows.length === 0) return;

        // BACKLOG-FLOOD GUARD. If the poll returns a large batch where
        // most rows are is_from_me=1 (the bot's own historical sends
        // dumped in one tick by iCloud sync OR by chat.db catching up
        // after a bridge stall), drop ALL is_from_me=1 rows in the
        // batch but still process inbound user messages (is_from_me=0)
        // normally. Without this, the bot would re-process every prior
        // ack / digest / LLM-reply as a fresh query and either echo
        // for hours or jam the busy-gate.
        const fromMeCount = rows.filter((r) => r.isFromMe).length;
        const isFlood = rows.length >= 8 && fromMeCount / rows.length >= 0.5;
        if (isFlood) {
          this.logger.warn(
            { total: rows.length, fromMe: fromMeCount, lastRowid: rows[rows.length - 1]?.rowid },
            "backlog-flood detected — skipping bot-authored rows in this batch",
          );
        }
        for (const row of rows) {
          if (isFlood && row.isFromMe) continue;
          this.handleNewRow(row);
        }
      } catch (err) {
        this.logger.warn({ err }, "poll iteration failed");
      }
    }, POLL_INTERVAL_MS);
  }

  // Decide what to do with each new row in chat.db. This is the
  // entry point for both inbound (contact → user) and outbound
  // (user → contact) messages — the user's own typing on Messages.app
  // arrives here with isFromMe=true and is treated as either:
  //   - a /bot or /lantern command (executed + reply via self-chat)
  //   - a takeover signal (pause auto-reply for that contact)
  // Inbound messages run the full natural-reply pipeline with all the
  // futurism: persona/style, escalation, quiet hours, calendar, facts,
  // VIP draft queue, attachment understanding.
  private handleNewRow(row: IMessageRow): void {
    // BOT-SELF HARD-SKIP. Any chat.db row whose body matches a known
    // bot-emitted prefix (acks, progress nudges, status output,
    // digests, action confirmations) is NEVER a user query. This is
    // the catastrophic-bug fix: an iCloud sync delay can drop a batch
    // of old bot replies into a single poll tick MINUTES after they
    // were authored, by which point the recentBridgeSends entry may
    // have aged out or been wiped by a restart. Without this gate the
    // bot reprocesses its own "📁 one sec…" / "📊 *lantern morning
    // report*" / etc. as fresh queries and the conversation cascades.
    const rawText = (row.text || "").trim();
    if (rawText && isBotSelfMessage(rawText)) {
      this.logger.debug(
        { rowid: row.rowid, handle: row.handle, textPreview: rawText.slice(0, 80) },
        "skipping bot-self message — hard match on bot-emitted pattern",
      );
      return;
    }

    // REACTION / TAPBACK GUARD. iMessage stores a "love"/"like"/"laugh"
    // tapback as a message row with associated_message_type != 0. These
    // are NOT messages — someone hearting a message in a group is not a
    // prompt for the bot to reply. Without this, a heart reaction in a
    // group came through as inbound text and the bot replied with a
    // heart of its own (and as a DM, not in the group). Drop entirely.
    if (row.associatedMessageType && row.associatedMessageType !== 0) {
      this.logger.debug(
        { rowid: row.rowid, handle: row.handle, type: row.associatedMessageType },
        "skipping reaction/tapback row — not a real message",
      );
      return;
    }

    const unixMs = appleNsToUnixMs(row.date);
    const isGroup = row.chatDisplayName !== "" || row.handle === "";

    // CROSS-DEVICE / MULTI-APPLE-ID DEDUP. The same owner message lands
    // in chat.db twice (with different rowids) when:
    //   (a) Two Apple IDs are signed into Messages — one row per view.
    //   (b) The user typed on their phone AND it cross-device-synced
    //       to the bridge Mac — sometimes as is_from_me=1 from one
    //       account's view, then again as is_from_me=0 from the other.
    // Without dedup, handleNewRow fires twice → handleOwnerDocQuery
    // runs twice → user sees the same reply twice and the LLM is
    // billed twice.
    //
    // Key on (handle, text) ONLY (NOT isFromMe) within a 10s window.
    // Including isFromMe in the key let cross-device duplicates slip
    // through because the SAME message can appear as both is_from_me=1
    // and is_from_me=0 in different account views. 10s window is
    // generous for legitimate "user retyped the same thing" — that's
    // not noise-rate user behavior anyway.
    const text = (row.text || "").trim();
    if (text && row.handle) {
      const key = `${row.handle}|${text}`;
      const now = Date.now();
      // GC first
      this.recentInbound = this.recentInbound.filter((e) => now - e.ts < IMessageSession.INBOUND_DEDUP_MS);
      const seen = this.recentInbound.find((e) => e.key === key);
      if (seen) {
        this.logger.info({ rowid: row.rowid, handle: row.handle, textPreview: text.slice(0, 60), priorIsFromMe: seen.isFromMe, thisIsFromMe: row.isFromMe }, "duplicate inbound — skipping (cross-device echo)");
        return;
      }
      this.recentInbound.push({ key, ts: now, isFromMe: row.isFromMe });
    }

    // KILL SWITCH gate. When engaged, the bridge IGNORES every inbound
    // EXCEPT a killswitch-off command from the owner in self-chat.
    // This is the master safety lever — useful if the bot misbehaves
    // or the user needs an instant cone of silence (e.g., handing the
    // phone to someone).
    if (this.killSwitch) {
      const txt = (row.text || "").trim();
      const isOwnerSelf = this.isOwnerChatRow(row);
      const cmd = txt ? parseNLCommand(txt) : null;
      const isReleaseCmd = !!cmd && cmd.action === "killswitch-off";
      if (!(isOwnerSelf && isReleaseCmd)) {
        return; // total silence
      }
      // Release command — fall through to normal handling so the
      // command dispatcher fires + acknowledges.
    }

    // --- Outbound (user's own message) ---
    if (row.isFromMe) {
      const text = (row.text || "").trim();

      // Skip our own bridge-sent replies — chat.db echoes them as
      // is_from_me=1 and we'd otherwise treat them as the user
      // typing (which would pause auto-reply for an hour after
      // every bot response). De-dup by text within a 60s window.
      if (text && this.isOwnBridgeSend(text)) {
        return;
      }

      // Owner commands. Three paths:
      //   (a) explicit slash commands: /bot, /lantern (back-compat)
      //   (b) natural language: "pause for 2h", "mute everyone",
      //       "status", "lantern, hush", etc.
      //   (c) voice command — the user sends themselves a voice
      //       note that starts with "lantern". Whisper transcribes,
      //       parseVoiceCommand strips the wake word + dispatches.
      // parseNLCommand handles (a) and (b). For (c) we look at the
      // attachment first and only run transcription when no text is
      // present.
      if (!text && row.hasAttachments) {
        // Voice command path. Fire-and-forget: handleNewRow is
        // synchronous (called from the polling loop) so we can't
        // await Whisper here. We schedule the transcription + dispatch
        // in the background and return immediately — the polling loop
        // moves on to the next row.
        void (async () => {
          try {
            const annotation = await this.annotateAttachments(row.rowid);
            if (annotation?.kind === "voice" && annotation.ok) {
              const transcript = annotation.syntheticText.replace(/^\[voice note transcribed\]\s*/i, "");
              const voiceCmd = parseVoiceCommand(transcript);
              if (voiceCmd) {
                this.logger.info({ transcript: transcript.slice(0, 80) }, "voice command detected");
                this.broadcast({
                  type: "activity",
                  data: { kind: "system", summary: `🎙️ voice cmd: ${voiceCmd.action}`, detail: transcript.slice(0, 200), timestamp: Date.now() },
                });
                await this.handleOwnerCommand(row.handle || this.ownHandleGuess(), voiceCmd);
              }
            }
          } catch (err) {
            this.logger.warn({ err }, "voice command path errored");
          }
        })();
        // Don't fall through to text-command parsing for attachments
        // — the voice path either handled it or it's just a voice
        // note (not a command), and we don't want to treat the empty
        // text as anything.
        return;
      }
      // Allow-list management commands. Strict prefix so a chat
      // message that happens to start with the word "allow" can't
      // accidentally flip behavior. Recognized forms:
      //   allow <handle>     — opt this contact in for auto-reply
      //   deny  <handle>     — remove from allow-list
      //   allowed            — show current allow-list
      const allowCmd = this.parseAllowCommand(text);
      if (allowCmd) {
        const replyTo = row.handle || this.ownHandleGuess() || this.lastSelfHandle || "";
        void this.handleAllowCommand(replyTo, allowCmd);
        return;
      }

      const parsed = parseNLCommand(text);
      if (parsed) {
        void this.handleOwnerCommand(row.handle || this.ownHandleGuess(), parsed);
        return;
      }

      // Personal-docs Q&A. SECURITY: triple-gated to the owner's
      // self-chat:
      //   1) personalDocsEnabled toggle must be ON (owner-controlled,
      //      survives restart)
      //   2) chat must be the owner's self-chat (chatIdentifier ==
      //      participant handle == owner's own handle, single
      //      participant)
      //   3) the row handle must match LANTERN_IMESSAGE_OWNER_HANDLE
      //      when set (last line of defense if isSelfChat() heuristic
      //      ever misfires).
      // Any DM from a contact or any group message is hard-rejected
      // here. See bridge-core/personal-docs.ts for the file-system
      // security model (allowed roots + audit log).
      if (
        this.personalDocsEnabled
        && !isGroup
        && this.isOwnerChatRow(row)
        && !isTrivialChatter(text)
      ) {
        // CONCURRENCY GATE: skip if a prior query for this chat is
        // still in flight. Same gate as handleInbound — applied here
        // because the fromMe branch fires this path too when the
        // owner types directly on this Mac.
        if (this.busyChat.has(row.handle)) {
          this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "fromMe owner-query skipped — chat busy");
          return;
        }
        void this.handleOwnerDocQuery(row.handle, text, row.chatRowid);
        return;
      }

      // "remember X about this person" — owner teaching the bot a durable
      // fact about the CONTACT whose thread this is. Saved server-side and
      // injected into every future reply to them via factsBlock.
      // SECURITY/UX: the bot does NOT reply in the contact's thread (that
      // would leak the note to them). It acks to the owner's self-chat
      // (LANTERN_IMESSAGE_OWNER_HANDLE) when known, else just logs +
      // dashboard-broadcasts. Contact threads only (not self-chat/group).
      if (!isGroup && row.handle && !this.isOwnerChatRow(row)) {
        const fact = parseRememberCommand(text);
        if (fact) {
          const contactHandle = row.handle;
          const label = this.contactLabel(contactHandle);
          void this.personal.addFact(contactHandle, fact).then((ok) => {
            this.broadcast({
              type: "activity",
              data: { kind: "system", summary: ok ? `📝 noted about ${label}: ${fact.slice(0, 80)}` : `failed to save fact for ${label}`, jid: contactHandle, timestamp: Date.now() },
            });
            const selfHandle = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim();
            if (selfHandle) {
              void this.send(selfHandle, ok ? `📝 got it — noted about ${label}: ${fact}` : `couldn't save that note about ${label}, try again`);
            }
          });
          return; // a memory command is not a voice exemplar + no contact reply
        }
      }

      // Capture as ownerSentHistory exemplar for style cloning. Skip
      // groups (mixed register), skip empty/short. Persisted so the voice
      // model survives restarts (lever: aggressive owner-voice capture).
      if (!isGroup && row.handle && text.length >= 3) {
        this.rememberOwnerSent(row.handle, text);
        this.persist();
      }
      // Pause auto-reply for this contact — the user just typed.
      if (row.handle && !isGroup) {
        this.pausedUntil.set(row.handle, Date.now() + PAUSE_DURATION_MS);
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: "contact_paused", summary: `you typed — pausing bot for ${this.contactLabel(row.handle)}`, jid: row.handle, timestamp: Date.now() },
        });
      }
      this.broadcast({
        type: "message",
        data: { from: row.handle, text: row.text, fromMe: true, timestamp: unixMs, guid: row.guid },
      });
      return;
    }

    // --- Inbound (contact → user) ---
    // Resolve attachments (media) before deciding what to do — voice
    // notes and images become synthetic text the reply pipeline can
    // act on.
    void this.handleInbound(row, unixMs, isGroup);
  }

  // Cache of self-chat ROWIDs discovered by querying chat.db on
  // demand. Populated lazily — first time we hit a row from a chat,
  // we check if that chat has only the user as participant (or is
  // chat_identifier == own handle) and remember.
  private selfChatRowIds: Set<number> = new Set();

  // Per-chat timestamp of the last doc query. Lets us recognize
  // short follow-ups ("send it", "yes", "the first one") as
  // continuations within a 5-minute window.
  private lastDocQueryAt: Map<number, number> = new Map();

  // True when the chat ROWID is the user's self-chat (messaging
  // yourself — either same Apple ID across devices, or a 1-on-1
  // with your own handle as the only participant). The Mac's
  // chat.db sees these as is_from_me=0 because the message came
  // from a DIFFERENT DEVICE (your phone) even though it's the same
  // account.
  private isSelfChat(chatRowid: number, handle: string): boolean {
    if (this.selfChatRowIds.has(chatRowid)) return true;
    // Self-chat detection requires KNOWING the owner's own handle —
    // there's no safe heuristic. The prior version used
    // (participantCount === 1 && chatIdentifier === handle) which is
    // true for EVERY 1-on-1 DM, not just self-DM — so every friend's
    // chat was misclassified as the owner's self-chat. Result: the
    // bot greeted friends with "hey shekhar!" and processed their
    // messages through the owner-channel pipeline.
    //
    // Now: ONLY trust LANTERN_IMESSAGE_OWNER_HANDLE. When unset,
    // self-chat is treated as unknown and the bot falls back to the
    // contact auto-reply path (which is the correct default for a
    // friend's DM). Owners who want the owner-channel features MUST
    // set the env var.
    const ownerEnv = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim();
    if (!ownerEnv) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, "");
    if (norm(handle) === norm(ownerEnv)) {
      this.selfChatRowIds.add(chatRowid);
      return true;
    }
    return false;
  }

  // Owner-chat check used as the security gate for personal-docs
  // Q&A, the killswitch-release command, and all agentic actions.
  //
  // Two supported topologies:
  //   (A) DEDICATED BOT MODE — this Mac is signed into a SEPARATE
  //       Apple ID that acts as the bot. The owner DMs the bot from
  //       their primary Apple ID on their phone. Messages arrive as
  //       1-on-1 with row.handle == owner's primary handle. Set
  //       LANTERN_IMESSAGE_OWNER_HANDLE to the owner's primary phone
  //       or email (e.g. "+15125551234" or "shekhar@icloud.com").
  //   (B) SELF-CHAT MODE — single Apple ID across owner's devices.
  //       Owner messages themselves; the chat is a self-chat (1
  //       participant, chatIdentifier == handle).
  //
  // Both pass when row.handle is provided, the chat isn't a group,
  // AND one of:
  //   - row.handle matches LANTERN_IMESSAGE_OWNER_HANDLE (mode A,
  //     authoritative when set), OR
  //   - chat is a self-chat by the heuristic (mode B fallback).
  //
  // Normalization strips spaces, dashes, parens, dots so
  // "+1 (512) 555-1234" and "+15125551234" both match.
  private isOwnerChatRow(row: IMessageRow): boolean {
    if (!row.handle) return false;
    const isGroup = row.chatDisplayName !== "" || row.handle === "";
    if (isGroup) return false;
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9@.]/g, "");
    const ownerEnv = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim();
    if (ownerEnv && norm(row.handle) === norm(ownerEnv)) return true;
    // Self-chat fallback when env not set OR env was set but doesn't
    // match (covers users who run BOTH topologies on the same Mac).
    if (this.isSelfChat(row.chatRowid, row.handle)) return true;
    return false;
  }

  // Asynchronous because media annotation may call out to Whisper +
  // vision LLM. Fire-and-forget from the polling loop; failures here
  // don't block the next poll.
  private async handleInbound(row: IMessageRow, unixMs: number, isGroup: boolean): Promise<void> {
    let text = row.text || "";

    // Cross-device echo guard. When the bridge sends a reply, the
    // user's other device (phone) receives it from CloudKit sync,
    // and chat.db records it with is_from_me=0 (because the Mac
    // didn't author it — the phone did, even though it's the same
    // Apple ID). Without this check we'd treat our own reply as a
    // new inbound from the user, re-trigger the doc-query pipeline,
    // and infinite-loop. The dedup uses the same text-based window
    // we use in the isFromMe branch.
    if (text && this.isOwnBridgeSend(text)) {
      this.logger.debug({ rowid: row.rowid }, "inbound matched recent bridge send — skipping (echo)");
      return;
    }

    // Visibility into the inbound pipeline. Every inbound logs the
    // gating signals so future "why didn't it reply" issues are
    // diagnosable from the log alone.
    if (text) {
      const isSelf = !isGroup && row.handle ? this.isSelfChat(row.chatRowid, row.handle) : false;
      this.logger.info({
        rowid: row.rowid, chatRowid: row.chatRowid, handle: row.handle,
        isGroup, isSelf, textPreview: text.slice(0, 60),
      }, "inbound");
    }

    // OWNER COMMAND PATH — when the owner DMs the bot (dedicated-bot
    // mode, isFromMe=0), the isFromMe branch above never fires, so
    // commands like "lantern status", "/bot off", "docs off",
    // "kill switch on" would silently fall through to natural-reply.
    // Catch them here so the same command vocabulary works from both
    // topologies.
    if (text && !isGroup && this.isOwnerChatRow(row)) {
      const parsed = parseNLCommand(text);
      if (parsed) {
        void this.handleOwnerCommand(row.handle, parsed);
        return;
      }
    }

    // Personal-docs interception — fires BEFORE the normal inbound
    // pipeline. Handles two topologies via isOwnerChatRow:
    //   (A) DEDICATED BOT MODE — owner DMs the bot from their primary
    //       Apple ID; row.handle matches LANTERN_IMESSAGE_OWNER_HANDLE.
    //   (B) SELF-CHAT MODE — single Apple ID across devices; row.handle
    //       == chatIdentifier == owner's own handle.
    // SECURITY: triple-gated by personalDocsEnabled toggle, group-check,
    // and the owner-chat guard. No DM from a contact can reach here.
    if (this.personalDocsEnabled && !isGroup && this.isOwnerChatRow(row) && text) {
      // CONFIRMATION INTERCEPT: when there's a pending offer for
      // this chat and the user replied with a clean affirmation
      // ("yes" / "sure" / "do it"), execute the action directly.
      this.gcPendingOffers();
      const cachedOffer = this.pendingOffers.get(row.handle);
      if (cachedOffer && looksLikeConfirmation(text)) {
        this.logger.info({ kind: cachedOffer.kind, chat: row.handle }, "executing cached offer on confirmation");
        this.pendingOffers.delete(row.handle); // one-shot
        void this.executeCachedOffer(row.handle, cachedOffer);
        return;
      }
      // REJECTION INTERCEPT: short negative ("no" / "nope" / "not now"
      // / "cancel" / "skip") with a pending offer → clear the offer,
      // send a brief ack, DON'T fire natural-chat. Stops every "no"
      // from spawning a fresh agent round-trip + reply.
      if (cachedOffer && looksLikeRejection(text)) {
        this.logger.info({ kind: cachedOffer.kind, chat: row.handle }, "dropping cached offer on rejection");
        this.pendingOffers.delete(row.handle);
        void this.send(row.handle, "👍 no worries");
        return;
      }
      // CHAT-BUSY GATE: a previous query for this chat is still
      // in-flight. Drop new ones (with a brief explanation) so we
      // don't spawn parallel pipelines that all reply minutes later.
      if (this.busyChat.has(row.handle)) {
        // QUEUE LATEST silently — no nudge. The user is mid-stream,
        // they already know they typed a second thing; injecting "⏳
        // still on the previous one — I'll get to this next" clutters
        // the chat and is the noise the user explicitly asked to kill.
        // The queued message will land its real answer as soon as
        // the current run finishes (drained in handleOwnerDocQuery's
        // finally block).
        if (!isTrivialChatter(text)) {
          this.queuedQuery.set(row.handle, { text, queuedAt: Date.now() });
          this.logger.info(
            { chat: row.handle, textPreview: text.slice(0, 60) },
            "queued — chat busy, will process when current finishes",
          );
        } else {
          this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "skipping — chat busy (trivial chatter)");
        }
        return;
      }

      // OWNER SELF-CHAT — every substantive message goes through the
      // agentic pipeline with tools attached. The LLM decides whether
      // to search local files (search_personal_files / read_personal_file),
      // call Gmail / Calendar, etc. Trivial chatter ("thanks", "ok",
      // "👍") still skips the heavy path. No more regex pre-deciders
      // guessing the user's intent from query shape — the model is the
      // router now.
      if (isTrivialChatter(text)) {
        const nlEnabled = (process.env.LANTERN_OWNER_CHAT_NL || "on").toLowerCase() !== "off";
        if (nlEnabled && !this.muted) {
          this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "owner trivial chatter → natural chat");
          void this.handleOwnerNaturalChat(row.handle, text);
        }
        return;
      }
      this.logger.info({ query: text.slice(0, 80), chatRowid: row.chatRowid }, "owner self-chat → agentic pipeline (LLM-driven tools)");
      this.lastDocQueryAt.set(row.chatRowid, Date.now());
      // Cache the chatRowid against the handle so the queue drain can
      // pull recent transcript correctly even when it fires later.
      this.lastChatRowidForHandle.set(row.handle, row.chatRowid);
      void this.handleOwnerDocQuery(row.handle, text, row.chatRowid);
      return;
    }

    // Media: attach a synthetic-text annotation when an attachment is
    // present and no text was sent. Reply pipeline treats the
    // annotation as the inbound body.
    if (!text && row.hasAttachments) {
      const annotation = await this.annotateAttachments(row.rowid);
      if (annotation) {
        text = annotation.syntheticText;
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
            jid: row.handle,
            timestamp: Date.now(),
          },
        });
      }
    }

    // Style learning — remember the contact's text for inferStyle.
    if (text && !isGroup && row.handle) {
      this.rememberInbound(row.handle, text);
    }

    // PROACTIVE MEMORY. Scan every contact-inbound for high-confidence
    // facts ("my birthday is june 3", "I work at Stripe", "we just had
    // a baby") and auto-save to whatsapp_contact_facts with
    // source="auto-extract". Surfaces on future replies via factsBlock.
    // Skipped for owner-self-chat + groups (facts attach to one
    // person; group authorship is ambiguous).
    if (text && !isGroup && row.handle && !this.isOwnerChatRow(row)) {
      void this.scanAndPersistFacts(row.handle, text).catch((err) =>
        this.logger.debug({ err, handle: row.handle }, "auto-fact scan failed"),
      );
    }

    // Broadcast the inbound (for the dashboard live feed).
    this.broadcast({
      type: "message",
      data: { from: row.handle, text, fromMe: false, timestamp: unixMs, guid: row.guid, chatRowid: row.chatRowid, isGroup },
    });

    // Bot decisions ----------------------------------------------------
    // Empty inbound (attachment-only, sticker, reaction, etc.). Stay
    // SILENT — never ask the LLM to compose a "I can't see your message"
    // reply. That kind of wooden text is exactly what makes a bot smell
    // like a bot. The owner can read the attachment themselves; bot's
    // job is to be invisible when it has nothing real to say.
    if (!text) return;

    // NOTE: no hard allow-list gate here (removed — it was an
    // over-correction that silenced every contact). The real spam
    // problem (wooden replies to strangers) is handled downstream by
    // confidence-gating (unknown contacts → draft for approval, never
    // auto-sent) + the bot-tell filter + escalation guard. Known
    // contacts (relationship/samples/facts) auto-reply authentically;
    // unknown contacts get held as a draft; nobody gets spam. Owner can
    // still globally mute or pause per-contact.
    if (this.muted) {
      this.broadcast({ type: "activity", data: { kind: "agent_skipped", summary: `bot muted — ${this.contactLabel(row.handle)}`, jid: row.handle, timestamp: Date.now() } });
      return;
    }
    const until = this.pausedUntil.get(row.handle);
    if (until && until > Date.now()) {
      this.broadcast({ type: "activity", data: { kind: "agent_skipped", summary: `paused — ${this.contactLabel(row.handle)}`, jid: row.handle, timestamp: Date.now() } });
      return;
    }
    if (isGroup) {
      // Two gates for groups (mirrors WhatsApp behavior):
      //   1. Must be a monitored chat (user explicitly opted in via
      //      dashboard or `/lantern chats add <rowid>`).
      //   2. Message must look like it's addressed to the owner —
      //      mention by name, "@you", "@<owner>". Replying to every
      //      group message would be insanely noisy.
      if (!this.monitoredChats.has(row.chatRowid)) return;
      if (!this.isAddressedToOwner(text)) {
        this.broadcast({
          type: "activity",
          data: { kind: "agent_skipped", summary: "group msg — not addressed to you", detail: text.slice(0, 120), jid: row.handle, timestamp: Date.now() },
        });
        return;
      }
    }

    // shouldRespond: cheap text-only filter for "k" / "👍" — react
    // instead of replying, or stay silent entirely.
    const verdict = shouldRespond(text);
    if (!verdict.respond) {
      this.broadcast({
        type: "agent_reply",
        data: { to: row.handle, text: "(no reply — ack)", skipped: true, reason: verdict.reason, timestamp: Date.now() },
      });
      return;
    }

    // Escalation guard: urgent/health/money/legal/grief content goes
    // to the human. Auto-reply is suppressed; the contact is paused so
    // a follow-up doesn't trigger again before the user takes over.
    if (!isGroup) {
      const escalation = detectEscalation(text);
      if (escalation.escalate) {
        this.escalationsToday += 1;
        const alertBody = [
          `🚨 *Escalation: ${this.contactLabel(row.handle)}*`,
          "",
          `Reason: _${escalation.reason}_`,
          "",
          `> ${text.slice(0, 300)}`,
          "",
          "Auto-reply was suppressed — please respond yourself.",
        ].join("\n");
        void this.mirrorToEmail(alertBody);
        this.broadcast({
          type: "activity",
          data: { kind: "attention_dm", summary: `escalated: ${escalation.reason}`, detail: text.slice(0, 200), jid: row.handle, timestamp: Date.now() },
        });
        this.pausedUntil.set(row.handle, Date.now() + PAUSE_DURATION_MS);
        this.persist();
        return;
      }
    }

    // Quiet hours: skip auto-reply during sleeping hours.
    if (!isGroup) {
      const qh = defaultQuietHours();
      if (isQuietHours(new Date(), qh)) {
        this.broadcast({ type: "activity", data: { kind: "agent_skipped", summary: "quiet hours — auto-reply paused", jid: row.handle, timestamp: Date.now() } });
        return;
      }
    }

    // Build the persona prompt with style, exemplars, facts, calendar.
    const styleKey = isGroup ? `group:${row.chatRowid}` : row.handle;
    const history = this.inboundHistory.get(styleKey) ?? [];
    const style = inferStyle(history);
    const ownerSamples = isGroup ? [] : this.ownerSentHistory.get(row.handle) ?? [];
    const ownerName = process.env.LANTERN_OWNER_NAME || OWNER_NAME;
    // Owner profile + relationship — the "sounds like me" context.
    const ownerProfile = this.ownerProfileStore.prose();
    const relationship = isGroup
      ? undefined
      : this.ownerProfileStore.relationshipFor(row.handle, this.contactNames.get(row.handle));
    // Recent thread transcript (real back-and-forth from chat.db) so the
    // reply is grounded in what's actually being discussed.
    const recentTranscript = this.buildRecentTranscript(row.chatRowid);
    // Detect inbound language so the reply matches the same script +
    // dialect. Owner nativity biases regional flavor (e.g. "Karimnagar,
    // Telangana" → Telangana Telugu rather than coastal Andhra Telugu).
    const langHint = detectLanguageHints(text);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    if (languageModality) {
      this.logger.info(
        { handle: row.handle, lang: langHint.primary, confidence: langHint.confidence, nativeScript: langHint.hasNativeScript, romanized: langHint.hasRomanized },
        "language-modality engaged",
      );
    }
    let systemHint = agentPersonaPrompt(ownerName, style, isGroup, {
      ownerSamples,
      disclosed: false,
      stylePrompt: undefined,
      ownerProfile,
      relationship,
      recentTranscript,
      languageModality,
    });
    // Per-contact memory: facts the user has captured about this
    // contact (their daughter is Maya, works at Stripe, etc).
    if (!isGroup) {
      const factsBlock = await this.personal.factsBlock(row.handle);
      if (factsBlock) systemHint += factsBlock;
    }
    // Calendar awareness — only fires when the inbound smells like
    // "are you free / can we meet" to keep latency low.
    if (!isGroup && needsCalendar(text)) {
      const calBlock = await this.calendar.upcomingBlock(8);
      if (calBlock) systemHint += calBlock;
    }

    // Call the agent. LLM keys + budgets live in the control-plane.
    const userText = isGroup ? `[group message]\n${text}` : text;
    const draft = await this.agent.respondTo(row.handle, userText, systemHint);
    if (!draft) return;

    // BOT-TELL FILTER — last-line defense before send. Catches the
    // wooden "I can't see your message", "looks like an issue with how
    // it sent", customer-service stock phrases, and AI tell-words. When
    // a draft trips this, we STAY SILENT rather than send fiction.
    // (Real motivation: a friend got "I can't see any text in your
    // message - try typing it out?" and asked "Is this really you?".)
    const tellCheck = detectBotTells(draft);
    if (!tellCheck.ok) {
      this.logger.info({ from: row.handle, reason: tellCheck.reason, draftPreview: draft.slice(0, 120) }, "draft suppressed by bot-tell filter");
      this.broadcast({
        type: "activity",
        data: {
          kind: "agent_skipped",
          summary: `draft suppressed — ${tellCheck.reason}`,
          detail: draft.slice(0, 200),
          jid: row.handle,
          timestamp: Date.now(),
        },
      });
      return;
    }

    // CONFIDENCE GATE + VIP gate. Both route the draft to human approval
    // instead of auto-sending:
    //   - VIP: contact is on the owner's VIP list (boss, parents, top
    //     customers) — never auto-send to them.
    //   - Low confidence: the bot doesn't have enough signal to be sure
    //     it sounds like the owner for THIS contact. Heuristic: no prior
    //     owner-sent samples AND no captured facts AND no known
    //     relationship. That's an unfamiliar contact — draft, don't send,
    //     so the owner trains trust over time. Once the owner replies to
    //     them a few times (samples accumulate) the gate opens.
    const lowConfidence =
      !isGroup &&
      ownerSamples.length === 0 &&
      !relationship &&
      !(await this.personal.factsBlock(row.handle));
    const isVIP = !isGroup && (await this.personal.isVIP(row.handle));
    if (isVIP || lowConfidence) {
      const queued = await this.personal.queueDraft(
        row.handle,
        this.contactNames.get(row.handle) ?? undefined,
        text,
        draft,
        { channel: "imessage" },
      );
      const why = isVIP ? "VIP" : "low-confidence (unfamiliar contact)";
      this.broadcast({
        type: "activity",
        data: { kind: "agent_skipped", summary: queued ? `draft queued for approval — ${why}` : `${why} — auto-reply suppressed (queue failed)`, detail: draft.slice(0, 200), jid: row.handle, timestamp: Date.now() },
      });
      return;
    }

    // Naturalize + paced send. CRITICAL: for a group, send to the GROUP
    // chat identifier — never to the individual sender's handle, which
    // would DM them instead of posting in the group. (This is what
    // produced the "replied to a group with a DM" bug.)
    const sendTarget = isGroup && row.chatIdentifier ? row.chatIdentifier : row.handle;
    const burst = naturalize(draft, { inbound: text, style });
    for (let i = 0; i < burst.length; i++) {
      const piece = burst[i];
      await new Promise((r) => setTimeout(r, piece.delayBeforeMs));
      await new Promise((r) => setTimeout(r, piece.typingMs));
      await this.send(sendTarget, piece.text);
      // Count once per burst for the morning digest.
      if (i === 0) this.repliesSentToday += 1;
    }
  }

  // Resolve the first decodable attachment on a message — voice
  // takes precedence over image (the user generally cares about voice
  // notes more), with image as fallback.
  private async annotateAttachments(messageRowid: number): Promise<MediaAnnotation | null> {
    const atts = this.db.attachmentsFor(messageRowid);
    if (atts.length === 0) return null;
    // Pick the most informative attachment first.
    const ordered = [...atts].sort((a, b) => {
      const score = (m: string) =>
        m.startsWith("audio/") ? 3 : m.startsWith("image/") ? 2 : m.startsWith("video/") ? 1 : 0;
      return score(b.mimeType) - score(a.mimeType);
    });
    for (const att of ordered) {
      const annotation = await this.media.annotate(att);
      if (annotation.ok) return annotation;
    }
    // None decoded — return the last (failed) annotation so the user
    // still sees something on the dashboard.
    return await this.media.annotate(ordered[0]);
  }

  // --- in-band commands ---------------------------------------------------

  // Auto-resume timer for time-bounded mutes ("pause for 2 hours").
  // The timer fires the unmute on schedule. Replaced on every new
  // time-bounded mute so the most recent one wins.
  private autoUnmuteTimer: ReturnType<typeof setTimeout> | null = null;

  // Owner typed a command. The text was already parsed by
  // parseNLCommand (slash OR natural language); we just dispatch via
  // the shared executor with iMessage-flavored callbacks.
  private async handleOwnerCommand(jid: string, parsed: ParsedCommand): Promise<void> {
    // Reply destination resolution. iMessage multi-Apple-ID setups
    // produce duplicate chat.db rows where the second copy can have
    // an empty handle (synced from the other account). Fall back to
    // the last-seen non-empty handle so the reply still lands.
    const replyTo = jid || this.ownHandleGuess() || this.lastSelfHandle || "";
    if (jid) this.lastSelfHandle = jid;
    this.logger.info(
      { action: parsed.action, jidGiven: jid, replyTo, hasReplyTarget: !!replyTo },
      "owner command dispatch",
    );
    const reply = async (text: string) => {
      if (!replyTo) {
        this.logger.warn(
          { action: parsed.action },
          "owner command had no reply target — set LANTERN_IMESSAGE_OWNER_HANDLE in env to enable self-chat replies",
        );
        return;
      }
      // Fire-and-forget so dispatch doesn't block the polling loop.
      // We DO await the send completion via .then so any AppleScript
      // failure logs visibly instead of silent void promise.
      this.send(replyTo, text).then((res) => {
        if (!res.ok) {
          this.logger.warn({ replyTo, action: parsed.action, reason: res.reason }, "command reply send failed");
        }
      });
      this.broadcast({
        type: "activity",
        data: {
          kind: "system",
          summary: `cmd: ${parsed.action}`,
          detail: text.slice(0, 200),
          timestamp: Date.now(),
        },
      });
    };
    await executeCommand(parsed, {
      reply,
      channelLabel: "iMessage",
      mute: async (durationMs?: number) => {
        this.muted = true;
        this.persist();
        if (this.autoUnmuteTimer) { clearTimeout(this.autoUnmuteTimer); this.autoUnmuteTimer = null; }
        if (durationMs && durationMs > 0) {
          this.autoUnmuteTimer = setTimeout(() => {
            this.muted = false;
            this.persist();
            this.autoUnmuteTimer = null;
            this.broadcast({ type: "activity", data: { kind: "bot_on", summary: "auto-resumed after timer", timestamp: Date.now() } });
            if (replyTo) void this.send(replyTo, "✅ auto-resumed — i'm back online.");
          }, durationMs);
        }
        this.broadcast({ type: "activity", data: { kind: "bot_off", summary: "bot off via command", timestamp: Date.now() } });
      },
      unmute: async () => {
        this.muted = false;
        if (this.autoUnmuteTimer) { clearTimeout(this.autoUnmuteTimer); this.autoUnmuteTimer = null; }
        this.persist();
        this.broadcast({ type: "activity", data: { kind: "bot_on", summary: "bot on via command", timestamp: Date.now() } });
      },
      statusBody: () => {
        const diag = this.diagnostics();
        const pausedCount = [...this.pausedUntil.values()].filter((t) => t > Date.now()).length;
        return [
          `🟢 *Lantern iMessage*`,
          `• bot: ${this.killSwitch ? "🚨 KILL SWITCH ENGAGED" : diag.muted ? "off" : "on"}`,
          `• personal-docs: ${this.personalDocsEnabled ? "on" : "off"}`,
          `• paused contacts: ${pausedCount}`,
          `• monitored chats: ${diag.monitoredChats.length}`,
          `• uptime: ${Math.round(diag.uptimeMs / 60_000)}m`,
          `• chat.db rowid: ${diag.chatDb.lastSeenRowid}`,
        ].join("\n");
      },
      listPaused: () => {
        const now = Date.now();
        const entries = [...this.pausedUntil.entries()].filter(([, t]) => t > now);
        if (entries.length === 0) return "📭 nothing paused.";
        return [
          `⏸ paused contacts (${entries.length}):`,
          ...entries.map(([h, t]) => `• ${h} — resumes in ${Math.round((t - now) / 60_000)}m`),
        ].join("\n");
      },
      listChats: () => {
        const monitored = [...this.monitoredChats];
        if (monitored.length === 0) {
          return "🪙 no monitored chats. open /personal/groups in the dashboard to pick some.";
        }
        return ["👀 monitored chats:", ...monitored.map((id) => `• rowid=${id}`)].join("\n");
      },
      resumeAll: async () => {
        this.pausedUntil.clear();
        this.persist();
      },
      setDocsEnabled: async (enabled: boolean) => {
        this.personalDocsEnabled = enabled;
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: "system", summary: `personal-docs ${enabled ? "ENABLED" : "DISABLED"}`, timestamp: Date.now() },
        });
      },
      setKillSwitch: async (engaged: boolean) => {
        this.killSwitch = engaged;
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: engaged ? "bot_off" : "bot_on", summary: `🚨 kill switch ${engaged ? "ENGAGED" : "RELEASED"}`, timestamp: Date.now() },
        });
        // When engaging, also mirror to email so the user gets an
        // audit trail (especially if they engaged it remotely and
        // want a confirmation outside the chat).
        if (engaged) {
          void this.mirrorToEmail("🚨 KILL SWITCH ENGAGED — Lantern iMessage bridge is silent until you release it.");
        }
      },
    });
  }

  // Execute a cached offer from humanize's detectOfferInReply.
  // Bypasses the LLM entirely for confirmations — deterministic.
  // Sends a natural confirmation back to the chat.
  private async executeCachedOffer(jid: string, offer: PendingOffer): Promise<void> {
    if (offer.kind === "calendar-reminder" && offer.targetIsoDate && offer.leadDays) {
      // Compute the reminder date: targetIsoDate minus leadDays.
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
          await this.send(jid, `📅 done — reminder set for ${friendly} (${offer.leadDays} days before). ${res.detail || ""}`);
        } else {
          await this.send(jid, `(couldn't add to calendar: ${res.reason})`);
        }
        this.logger.info({ kind: offer.kind, ok: res.ok, info: res.ok ? res.detail : res.reason }, "cached-offer executed");
      } catch (err) {
        this.logger.error({ err }, "calendar offer execution failed");
        await this.send(jid, `(calendar add failed — try again)`);
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
          await this.send(jid, `🗒 saved as a note — "${offer.noteTitle}". find it in Notes.app.`);
        } else {
          await this.send(jid, `(couldn't save the note: ${res.reason})`);
        }
        this.logger.info({ kind: offer.kind, ok: res.ok }, "cached-offer executed");
      } catch (err) {
        this.logger.error({ err }, "note offer execution failed");
        await this.send(jid, `(note save failed — try again)`);
      }
      return;
    }
  }

  // Owner free-form chat — anything that isn't a command, doc query,
  // or confirmation. Lets the owner-channel double as a Jarvis-style
  // chatbot on top of the personal-docs / actions layer.
  //
  // Tone: short, warm, lowercase — matches the Jarvis persona used
  // for doc queries. We DON'T inject the docs context block here
  // (no search runs), so this is just a clean agent round-trip.
  private async handleOwnerNaturalChat(jid: string, text: string): Promise<void> {
    // Acquire per-chat busy lock; release on exit (success or throw).
    this.busyChat.add(jid);
    try {
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? "late night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "late night";
    const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];

    // PRE-FETCH appointment-style queries — runs Gmail + Calendar in
    // parallel and stuffs results into the prompt so the LLM has
    // everything in one shot. Eliminates the "checked one tool,
    // gave up" failure mode.
    let prefetchBlock = "";
    if (looksLikeAppointmentQuery(text)) {
      try {
        const client = defaultConnectorClient(this.logger);
        const block = await prefetchAppointmentContext(client, text, this.logger);
        if (block) prefetchBlock = block;
      } catch (err) {
        this.logger.warn({ err }, "prefetch failed (continuing without)");
      }
    }

    // Language modality: even owner self-chat respects the language
    // they typed in. If he asks something in Telugu, reply in Telugu.
    const langHint = detectLanguageHints(text);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    const ownerProfileProse = this.ownerProfileStore.prose();
    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his iMessage self-chat.`,
      `Today is ${today}. Local time of day: ${timeOfDay}.`,
      ``,
      ownerProfileProse ? `# Who you are\n${ownerProfileProse}\n` : ``,
      `You ARE his Jarvis. Warm, concise, authentic. Like a sharp peer who knows him well.`,
      `  • 1-3 short lines. No corporate filler ("I'd be happy to" / "feel free" / "let me know if").`,
      `  • Lowercase, conversational.`,
      `  • Match his energy — if he's brief, you're brief.`,
      `  • For greetings ("hi", "hey"), say hello briefly + ask what he needs OR drop a useful nudge from time of day (morning → "anything on for today?", evening → "wrap-up notes for tomorrow?").`,
      `  • You can search his Mac files (passport, license, receipts, etc.) — when he mentions one, suggest the exact phrasing ("when does my passport expire", "find my I-485 receipt", "what's my green card number").`,
      `  • You can add calendar events, save notes, draft mail on his behalf — offer when relevant.`,
      `  • Use any connector tools attached to this agent in the Lantern dashboard (Gmail, Calendar, etc.) when helpful.`,
      prefetchBlock,
      languageModality,
    ].filter(Boolean).join("\n");
    try {
      const draft = await this.agent.respondTo(jid, text, systemHint, { withTools: true });
      if (!draft) {
        this.logger.warn({ jid }, "owner natural chat — no draft");
        return;
      }
      await this.send(jid, draft.trim());
    } catch (err) {
      this.logger.warn({ err, jid }, "owner natural chat exception");
    }
    } finally {
      this.busyChat.delete(jid);
    }
  }

  // GC pendingOffers Map — sweep entries older than OFFER_TTL_MS so
  // a long-lived session can't accumulate stale offers indefinitely.
  // Called lazily on each confirmation-intercept check (cheap O(n)).
  private gcPendingOffers(): void {
    if (this.pendingOffers.size === 0) return;
    const cutoff = Date.now() - IMessageSession.OFFER_TTL_MS;
    for (const [key, offer] of this.pendingOffers) {
      if (offer.issuedAt < cutoff) this.pendingOffers.delete(key);
    }
  }

  // Best-effort guess at the owner's own iMessage handle for self-chat
  // replies. iMessage doesn't expose this directly via chat.db without
  // extra joins; we read LANTERN_IMESSAGE_OWNER_HANDLE env when set.
  private ownHandleGuess(): string {
    return process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "";
  }

  // --- style/history helpers ----------------------------------------------

  private rememberInbound(handle: string, text: string): void {
    let arr = this.inboundHistory.get(handle);
    if (!arr) { arr = []; this.inboundHistory.set(handle, arr); }
    arr.push(text);
    if (arr.length > HISTORY_DEPTH) arr.splice(0, arr.length - HISTORY_DEPTH);
  }

  // PROACTIVE MEMORY — scan the contact's text for high-confidence
  // facts via the pattern extractor, dedupe against existing facts,
  // and persist via PersonalClient.addFact(..., "auto-extract").
  // Fire-and-forget; failures are logged but never block the reply
  // pipeline. Skipped silently when the extractor finds nothing.
  private async scanAndPersistFacts(handle: string, text: string): Promise<void> {
    const facts = extractAutoFacts(text);
    if (facts.length === 0) return;
    for (const f of facts) {
      // perspective === "self" → fact about THIS contact (the sender).
      // "other" → fact about a third party; we don't have a target
      // contact for those yet, skip until we add NER. Keeps the
      // dedup story clean.
      if (f.perspective !== "self") continue;
      const ok = await this.personal.addFact(handle, f.content, "auto-extract").catch(() => false);
      this.logger.info(
        { handle, fact: f.content, pattern: f.pattern, confidence: f.confidence, ok },
        ok ? "auto-fact saved" : "auto-fact skipped",
      );
    }
  }

  private rememberOwnerSent(handle: string, text: string): void {
    let arr = this.ownerSentHistory.get(handle);
    if (!arr) { arr = []; this.ownerSentHistory.set(handle, arr); }
    arr.push(text);
    if (arr.length > HISTORY_DEPTH) arr.splice(0, arr.length - HISTORY_DEPTH);
  }

  private contactLabel(handle: string): string {
    return this.contactNames.get(handle) || handle;
  }

  // Build a compact "them:/you:" transcript of the last few messages on a
  // chat, straight from chat.db (the real, complete thread — not just what
  // the bot saw). Fed into the persona prompt so replies are grounded in
  // the live conversation. Returns "" on any error so a reply never blocks
  // on transcript construction.
  private buildRecentTranscript(chatRowid: number): string {
    try {
      const msgs = this.db.recentMessages(chatRowid, 10);
      if (msgs.length === 0) return "";
      // Drop the very last line if it's the inbound we're replying to —
      // it's already the "current message"; keeping it is harmless but
      // the prompt reads cleaner ending on prior context. We keep it
      // anyway since chat.db ordering vs the in-flight row can race; the
      // model handles a duplicated last line fine.
      return msgs
        .map((m) => `${m.fromMe ? "you" : "them"}: ${m.text.replace(/\s+/g, " ").slice(0, 240)}`)
        .join("\n");
    } catch {
      return "";
    }
  }

  // Owner asked something in self-chat. We hand the message to the agent
  // with the full tool kit (search_personal_files / read_personal_file /
  // Gmail / Calendar / etc.) and let the LLM pick the path — no more
  // regex pre-deciders guessing the shape of the question. If the LLM
  // included [ATTACH:/path] / [CALENDAR:...] / [NOTE:...] / [MAIL:...]
  // markers, the bridge fires the corresponding Mac action.
  private async handleOwnerDocQuery(
    jid: string,
    query: string,
    chatRowid: number = 0,
  ): Promise<void> {
    this.busyChat.add(jid);
    try {
    this.logger.info({ query: query.slice(0, 80) }, "owner agentic query");
    this.broadcast({
      type: "activity",
      data: {
        kind: "system",
        summary: `🧠 owner query: ${query.slice(0, 60)}`,
        timestamp: Date.now(),
      },
    });

    // LATENCY-FIRST UX:
    //   • No upfront ack — fast queries (<3s) land their answer with
    //     ZERO noise. The chat reads like a real person replying.
    //   • If the work runs >3s, send ONE subtle "🧠 thinking…" so the
    //     user knows the bot's alive. Never a second nudge — repeated
    //     "still working" messages make the chat unreadable.
    //   • Anything longer than that hits the auto-retry path on
    //     timeout (see below).
    const startedAt = Date.now();
    let thinkingSent = false;
    const thinkingTimer = setTimeout(() => {
      thinkingSent = true;
      void this.send(jid, "🧠 thinking…");
    }, 3000);

    // Appointment-y queries get an additional deterministic Gmail +
    // Calendar prefetch in parallel — strictly an optimization (the
    // LLM could also call those tools) but gets results in the prompt
    // before the first round-trip.
    const client = defaultConnectorClient(this.logger);
    // ROSTER pre-fetch: when the query is a "who came / who's in"
    // question, hand the LLM the full WhatsApp + iMessage group
    // rosters that match the topic tokens BEFORE it starts writing.
    // Without this, the LLM lazy-paths to search_personal_files,
    // finds insurance/visa with a SUBSET of names, and stops.
    const rosterSignal = looksLikeRosterQuery(query);
    const rosterAdapters: RosterPrefetchAdapter[] = [];
    // iMessage groups (chat.db).
    rosterAdapters.push({
      surface: "imessage",
      listGroups: async () => this.db.listGroups().map((g) => ({
        id: String(g.chatRowid),
        name: g.name,
        participantCount: g.participantCount,
      })),
      getGroupMembers: async (opts) => {
        const res = this.db.getGroupMembers({
          chatRowid: opts.id ? parseInt(opts.id, 10) || undefined : undefined,
          name: opts.name,
        });
        if (!res) return null;
        return {
          id: String(res.chatRowid),
          name: res.name,
          // chat.db only has handles (phones/emails). Try to humanize
          // via the contactNames map; fall back to the handle itself.
          members: res.members.map((h) => ({
            name: this.contactNames.get(h) || h,
            isAdmin: false,
          })),
        };
      },
    });
    // WhatsApp groups — proxy to the WhatsApp bridge over loopback.
    const waBase = (process.env.LANTERN_WHATSAPP_BRIDGE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
    rosterAdapters.push({
      surface: "whatsapp",
      listGroups: async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(`${waBase}/session/${this.tenantId}/whatsapp/groups`, { signal: ctrl.signal });
          if (!res.ok) return [];
          const data = (await res.json()) as { groups?: Array<{ jid: string; name: string; participants: number }> };
          return (data.groups || []).map((g) => ({ id: g.jid, name: g.name, participantCount: g.participants }));
        } catch { return []; }
        finally { clearTimeout(t); }
      },
      getGroupMembers: async (opts) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const res = await fetch(`${waBase}/session/${this.tenantId}/whatsapp/group`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jid: opts.id, name: opts.name }),
            signal: ctrl.signal,
          });
          if (!res.ok) return null;
          const data = (await res.json()) as { jid: string; name: string; members: Array<{ name: string; isAdmin: boolean }> };
          return { id: data.jid, name: data.name, members: data.members };
        } catch { return null; }
        finally { clearTimeout(t); }
      },
    });

    const [apptBlock, rosterResults] = await Promise.all([
      looksLikeAppointmentQuery(query)
        ? prefetchAppointmentContext(client, query, this.logger).catch(() => null)
        : Promise.resolve(null),
      rosterSignal.isRoster
        ? prefetchRoster(rosterSignal, rosterAdapters, { maxGroupsPerSurface: 3 }).catch(() => [])
        : Promise.resolve([]),
    ]);
    const rosterBlock = formatRosterBlock(rosterSignal, rosterResults);
    this.logger.info(
      {
        ms: Date.now() - startedAt,
        hasAppt: !!apptBlock,
        isRoster: rosterSignal.isRoster,
        rosterTokens: rosterSignal.tokens,
        rosterMatches: rosterResults.flatMap((r) => r.matches.map((m) => `${r.surface}:${m.groupName}`)),
      },
      "agentic prefetch done",
    );

    // OWNER PROFILE: who I am, my voice, my people. This is the SAME
    // context the natural-chat path uses. Without it, "who is my son?"
    // burns 180s in a Gmail tool-loop because the LLM has no idea
    // Ved Mudarapu is the answer. With it, profile-answerable
    // questions resolve in one round-trip with NO tool calls.
    const ownerProfile = this.ownerProfileStore.prose();
    const relationshipsBlock = this.ownerProfileStore.relationshipsBlock();
    // Recent thread transcript so the LLM understands what came just
    // before. "yeah do it" / "send me the second one" / "what about
    // the other one" all need the recent history to make sense.
    // Prefer the chatRowid passed by the caller (always accurate for
    // the active chat); fall back to any known self-chat rowid for
    // robustness when the queue drain fires without a chatRowid in
    // scope.
    const effectiveChatRowid = chatRowid || (this.selfChatRowIds.size > 0 ? Array.from(this.selfChatRowIds)[0] : 0);
    const recentTranscript = effectiveChatRowid ? this.buildRecentTranscript(effectiveChatRowid) : "";
    const today = new Date().toISOString().slice(0, 10);
    const ownerName = process.env.LANTERN_OWNER_NAME || "Shekhar";
    // Language modality applies to owner self-chat too — if he asks
    // something in Telugu, reply in Telugu (Telangana dialect, owner
    // vocab preferences from profile).
    const langHint = detectLanguageHints(query);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his iMessage self-chat as if you ARE him talking to himself.`,
      `Today is ${today}.`,
      "",
      ownerProfile ? `# Who you are\n${ownerProfile}` : "",
      relationshipsBlock ? `\n# Your people\n${relationshipsBlock}` : "",
      recentTranscript ? `\n# Just-now conversation (oldest first)\n${recentTranscript}` : "",
      languageModality ? `\n${languageModality}` : "",
      "",
      "# Decide BEFORE calling tools",
      "Many questions are answerable from the profile above. Skip tool calls for:",
      "  • Relationship / family questions ('who is my son', 'what's my wife's name', 'my brother-in-law') — answer from 'Your people' above.",
      "  • Style / identity questions ('what do I work on', 'where do I live') — answer from 'Who you are'.",
      "  • Conversational follow-ups that don't need fresh data.",
      "Call tools only when you actually need data the profile doesn't have. The full toolkit:",
      "  • search_personal_files / read_personal_file — Mac files. Passport, license, green card, I-485, taxes, receipts, insurance, visas. PDFs/images OCR'd.",
      "  • list_imessage_groups / get_imessage_group — chat.db iMessage GROUPS (multi-person chats). Find a trip/family/friends group by name, then pull its members.",
      "  • search_imessage_history — chat.db messages (DMs + groups). Filter by keyword, date range (Unix ms), contact handle, groupOnly.",
      "  • list_whatsapp_groups / get_whatsapp_group — WhatsApp GROUPS. Find a group by name ('japan trip', 'family'), then pull its members.",
      "  • search_whatsapp_history — WhatsApp messages (DMs + groups). Filter by keyword, date range, jid, fromContact.",
      "  • backfill_whatsapp_history — when search_whatsapp_history returns empty for an older date range, call this with the group jid to ask WhatsApp for older messages. Results appear in search within seconds. Use ONCE per group per session; don't loop.",
      "  • gmail_search / gmail_list_messages — appointment confirmations, receipts, orders, doctor visits.",
      "  • google-calendar_list_events — anything time-bound, next 30 days.",
      "",
      "# Multi-source playbook (use this for ANY 'who/when/what during X' query)",
      "1. 'Who came on X trip' / 'who's in X group' →",
      "   a. list_whatsapp_groups + list_imessage_groups in PARALLEL.",
      "   b. find the group whose name contains the trip/topic.",
      "   c. get_whatsapp_group(name=…) and/or get_imessage_group(name=…) for the FULL member list.",
      "   d. cross-check with personal-docs (visa/insurance often lists travelers).",
      "   e. answer with ALL the people from the group, not just the ones in the doc.",
      "2. 'During my X trip' temporal queries →",
      "   a. narrow date range from most concrete source (visa doc, calendar event, flight email).",
      "   b. search_imessage_history + search_whatsapp_history + gmail_search across that range IN PARALLEL.",
      "   c. synthesize across all three; never stop at the first source.",
      "",
      "Never reply 'I can't access your files/emails/messages' — the tools are right here. Call them.",
      "",
      "# Voice",
      "  • Direct answer first, lowercase, conversational. 1-3 short lines max.",
      "  • No 'I'd be happy to' / 'feel free' / 'certainly' — sound like Shekhar would.",
      "  • State the FACT when you have it. No 'check the file' / 'check your inbox' if a tool returned the data.",
      "",
      "# Agentic follow-ups (mandatory when applicable)",
      "  • Answer mentions an EXPIRY / DEADLINE → end with ONE short question offering a calendar reminder ~60 days before.",
      "  • Answer mentions a NUMBER worth remembering (passport #, license #) → offer to save as Note.",
      "  • Answer references a FILE → offer to attach it.",
      "",
      "# Actions — emit ONE marker per action on its own line at the END",
      "  • Attach file:    [ATTACH:/absolute/path]   (COPY paths from read_personal_file output — never invent)",
      "  • Calendar:       [CALENDAR:Title|2026-08-19T09:00:00|2026-08-19T10:00:00|Optional notes]",
      "  • Note:           [NOTE:Title|Body text]",
      "  • Mail draft:     [MAIL:to@x.com|Subject|Body]",
      "OFFER-then-CONFIRM applies ONLY to state-modifying actions (calendar, note, mail, attach). For READ operations (search, list, look up, find), NEVER ask permission — just execute and report results. The user already asked; asking 'shall I search?' is wasted turns.",
      "For ROSTER questions ('who came on X', 'who's in X'): the group rosters above are the truth. If members show as raw phone numbers (no name), their PARTICIPATION in the group already proves they were part of the trip/event. Answer with the FULL roster from the group; mention the unresolved ones as '+ N more (numbers only — names not in contacts yet)'. Do NOT ask the user if they want you to search further; if you can call search_whatsapp_history / search_imessage_history for the trip date range, JUST DO IT in this same turn.",
      apptBlock ? "\n" + apptBlock : "",
      rosterBlock ? "\n" + rosterBlock : "",
    ].filter(Boolean).join("\n");

    // First attempt. withTools=true so the agent has the personal-docs
    // + connector tools — but the profile context above lets the LLM
    // skip them for profile-answerable questions.
    let draft = await this.agent.respondTo(jid, query, systemHint, { withTools: true });

    // SILENT AUTO-RETRY on null (timeout, transient failure). The
    // AgentClient already retries once on session-not-active 409; this
    // handles the broader "LLM hung / SSE aborted" case. ONE retry
    // total — beyond that the user sees a graceful fallback, never the
    // raw "couldn't reach the agent" message.
    if (!draft) {
      this.logger.warn({ totalMs: Date.now() - startedAt }, "agent returned null — retrying once");
      draft = await this.agent.respondTo(jid, query, systemHint, { withTools: true });
    }

    clearTimeout(thinkingTimer);
    this.logger.info({ totalMs: Date.now() - startedAt, hadDraft: !!draft, thinkingSent }, "doc query done");
    if (!draft) {
      // Graceful fallback — never "couldn't reach the agent — try
      // again". The bot OWNS the retry; the user should not have to.
      void this.send(jid, "hmm, that one took longer than I'd like. give me another minute and ask again");
      return;
    }

    // Extract action markers (attach, calendar, note, mail) in one
    // pass. Strip them all from the user-facing text so the reply
    // reads cleanly. Actions then execute one-by-one with concise
    // confirmations back to the chat.
    const { cleanedText: textNoAttach, paths } = extractAttachMarkers(draft);
    const { cleanedText: finalText, calendarEvents, notes, mailDrafts } = extractActionMarkers(textNoAttach);

    // Humanize: friendly dates + guaranteed follow-up offer. The
    // returned `offer` lets us deterministically execute the action
    // on the next-turn confirmation — bypasses the LLM's tendency
    // to claim "already done" without emitting the marker.
    const { reply: polished, offer } = humanizeWithOffer(finalText);

    if (polished) {
      await this.send(jid, polished);
    }

    // Cache the offer keyed by chat so the followup ("yes") in the
    // same self-chat can find + execute it. Overwrites any prior
    // offer (we only care about the most recent one).
    if (offer && jid) {
      this.pendingOffers.set(jid, offer);
    }

    // Deliver attachments. Path is rescued via basename search if
    // the LLM hallucinated a parent directory.
    for (const claimedPath of paths) {
      const resolved = await this.docs.resolveAttachPath(claimedPath);
      if (!resolved.ok) {
        this.logger.warn({ claimedPath, reason: resolved.reason }, "ATTACH path unresolved — skipped");
        await this.send(jid, `(couldn't attach — ${resolved.reason})`);
        continue;
      }
      const path = resolved.path;
      if (resolved.rescued) {
        this.logger.info({ claimedPath, rescuedPath: path }, "ATTACH path rescued by basename");
      }
      try {
        const sendRes = await this.sender.sendFile(jid, path);
        if (!sendRes.ok) {
          this.logger.warn({ path, reason: sendRes.reason }, "attach failed");
          await this.send(jid, `(couldn't attach ${basename(path)}: ${sendRes.reason})`);
        }
      } catch (err) {
        this.logger.warn({ err, path }, "attach exception");
      }
    }

    // Execute Mac actions. Each action gets a concise confirmation
    // line back to the chat (or a clear error). All wrapped in
    // try/catch so one failing action doesn't kill the others.
    for (const ev of calendarEvents) {
      try {
        const res = await this.macActions.createCalendarEvent(ev);
        await this.send(jid, res.ok ? `📅 added to calendar — ${res.detail || ev.title}` : `(calendar failed: ${res.reason})`);
        this.logger.info({ title: ev.title, ok: res.ok }, "calendar action");
      } catch (err) {
        this.logger.warn({ err, title: ev.title }, "calendar action exception");
      }
    }
    for (const n of notes) {
      try {
        const res = await this.macActions.createNote(n);
        await this.send(jid, res.ok ? `🗒 saved as a note — "${n.title}"` : `(note failed: ${res.reason})`);
        this.logger.info({ title: n.title, ok: res.ok }, "note action");
      } catch (err) {
        this.logger.warn({ err, title: n.title }, "note action exception");
      }
    }
    for (const m of mailDrafts) {
      try {
        const res = await this.macActions.createMailDraft(m);
        await this.send(jid, res.ok ? `✉️ draft opened in Mail — review + send when ready` : `(mail draft failed: ${res.reason})`);
        this.logger.info({ to: m.to, subject: m.subject, ok: res.ok }, "mail action");
      } catch (err) {
        this.logger.warn({ err, subject: m.subject }, "mail action exception");
      }
    }
    } finally {
      this.busyChat.delete(jid);
      // Drain queued next-query (latest-wins). Only one at most; if
      // older than TTL we drop it (user has moved on). Fire-and-forget
      // so we don't bottleneck the previous run's cleanup.
      const queued = this.queuedQuery.get(jid);
      if (queued) {
        this.queuedQuery.delete(jid);
        const age = Date.now() - (queued.queuedAt as number);
        if (age < IMessageSession.QUEUED_QUERY_TTL_MS) {
          this.logger.info({ chat: jid, ageMs: age, textPreview: queued.text.slice(0, 60) }, "draining queued query");
          void this.handleOwnerDocQuery(jid, queued.text, this.lastChatRowidForHandle.get(jid) || 0);
        } else {
          this.logger.info({ chat: jid, ageMs: age }, "dropping queued query — too old");
        }
      }
    }
  }

  // Heuristic: is this group message addressed to the owner? Same
  // bar as WhatsApp's isOwnerTargeted — match by first name, full
  // name, "@<owner>", and the literal "@you". iMessage doesn't have
  // a native @mention metadata field (group chats just use plain
  // text), so text matching is what we have.
  private isAddressedToOwner(text: string): boolean {
    const owner = (process.env.LANTERN_OWNER_NAME || OWNER_NAME).trim();
    if (!owner || owner === "the owner") return false;
    const firstName = owner.split(/\s+/)[0];
    const patterns = [
      // Word-boundary match on first name + full name (case-insensitive)
      new RegExp(`\\b${escapeRe(firstName)}\\b`, "i"),
      new RegExp(`\\b${escapeRe(owner)}\\b`, "i"),
      /\b@you\b/i,
      new RegExp(`@${escapeRe(firstName)}\\b`, "i"),
    ];
    return patterns.some((re) => re.test(text));
  }

  // --- email mirror (lightweight; mirrors WhatsApp bridge) ----------------
  //
  // Used by escalation alerts. Same Gmail-connector path the WhatsApp
  // bridge uses — control-plane wraps OAuth/labels/skip-inbox.
  private lastEmailedAt: Map<string, number> = new Map();
  private static readonly EMAIL_DEDUP_MS = 30_000;
  private async mirrorToEmail(text: string): Promise<void> {
    const to = process.env.LANTERN_OWNER_EMAIL;
    if (!to) return;
    if (text.length < 8) return;
    const lastAt = this.lastEmailedAt.get(text);
    if (lastAt && Date.now() - lastAt < IMessageSession.EMAIL_DEDUP_MS) return;
    this.lastEmailedAt.set(text, Date.now());
    try {
      const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "status";
      const subject = `Lantern iMessage: ${firstLine.replace(/[*_`~]+/g, "").replace(/[^\x20-\x7E]/g, "-").slice(0, 100).trim()}`;
      const { authedFetch } = await import("@lantern/bridge-core/auth");
      await authedFetch(`/v1/connectors/gmail/execute?action=send_message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, subject, body: text, label: "lantern", skipInbox: true }),
      });
    } catch (err) {
      this.logger.warn({ err }, "email mirror failed");
    }
  }

  private broadcast(msg: object): void {
    const json = JSON.stringify(msg);
    for (const s of this.sockets) {
      try { s.send(json); } catch {}
    }
  }

  private persist(): void {
    try {
      const data: PersistedState = {
        muted: this.muted,
        paused: Object.fromEntries(this.pausedUntil),
        monitoredChats: [...this.monitoredChats],
        enabledContacts: [...this.enabledContacts],
        personalDocsEnabled: this.personalDocsEnabled,
        killSwitch: this.killSwitch,
        ownerSentHistory: Object.fromEntries(this.ownerSentHistory),
      };
      writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.warn({ err }, "could not persist bot state");
    }
  }

  private loadState(): void {
    if (!existsSync(this.stateFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedState;
      this.muted = !!data.muted;
      for (const [k, v] of Object.entries(data.paused ?? {})) {
        if (typeof v === "number" && v > Date.now()) this.pausedUntil.set(k, v);
      }
      for (const c of data.monitoredChats ?? []) this.monitoredChats.add(c);
      for (const h of data.enabledContacts ?? []) this.enabledContacts.add(this.normalizeHandle(h));
      // Toggles default to safe values: docs ON, killswitch OFF.
      // Only honor the persisted value when present.
      if (typeof data.personalDocsEnabled === "boolean") this.personalDocsEnabled = data.personalDocsEnabled;
      if (typeof data.killSwitch === "boolean") this.killSwitch = data.killSwitch;
      for (const [jid, msgs] of Object.entries(data.ownerSentHistory ?? {})) {
        if (Array.isArray(msgs)) {
          const clean = msgs.filter((m): m is string => typeof m === "string");
          if (clean.length > 0) this.ownerSentHistory.set(jid, clean);
        }
      }
    } catch (err) {
      this.logger.warn({ err }, "could not load bot state, starting fresh");
    }
  }
}
