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
import { scheduleDigest, defaultDigestConfig } from "@lantern/bridge-core/daily-digest";
import { OfflineMonitor, defaultOfflineMonitorConfig } from "@lantern/bridge-core/offline-monitor";
import { EmailMirror } from "@lantern/bridge-core/email-mirror";
import {
  PersonalDocs,
  defaultPersonalDocsConfig,
  looksLikeDocQuery,
  looksLikeDocFollowup,
  extractAttachMarkers,
} from "@lantern/bridge-core/personal-docs";
import { MacActions, extractActionMarkers } from "@lantern/bridge-core/mac-actions";
import { humanizeWithOffer, looksLikeConfirmation, looksLikeRejection, type PendingOffer } from "@lantern/bridge-core/humanize";
import { defaultConnectorClient, prefetchAppointmentContext, looksLikeAppointmentQuery } from "@lantern/bridge-core/prefetch";

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
  personalDocsEnabled?: boolean; // owner toggle for local-file Q&A; default true
  killSwitch?: boolean;          // master OFF — bot refuses everything except killswitch-off
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
  private static readonly BRIDGE_SEND_DEDUP_MS = 60_000;

  // INBOUND dedup. When the user has TWO Apple IDs signed into
  // Messages.app on this Mac (a common configuration: primary +
  // family-share or bot account), the same logical message lands in
  // chat.db TWICE — once per account's view of the conversation, with
  // different rowids. Without this dedup, handleNewRow fires twice →
  // handleOwnerDocQuery runs twice → the LLM is billed twice and the
  // user sees two slightly different replies. Window is short (5s)
  // because the dual-row gap is sub-second; longer than 5s means a
  // legitimate retry by the user.
  private recentInbound: Array<{ key: string; ts: number }> = [];
  private static readonly INBOUND_DEDUP_MS = 5_000;

  // Per-chat cache of the most recent offer we made (e.g. "want me
  // to add a renewal reminder?"). When the user confirms with
  // "yes" / "sure" / "do it" within OFFER_TTL_MS, the bridge fires
  // the action DETERMINISTICALLY — no LLM round trip. Bypasses
  // hallucinations where the LLM claimed "we've already set it"
  // without ever emitting a [CALENDAR:...] marker.
  private pendingOffers: Map<string, PendingOffer> = new Map();
  private static readonly OFFER_TTL_MS = 10 * 60_000; // 10 min

  // Per-chat concurrency lock. A single doc-query / natural-chat
  // round-trip can take 90+ seconds (multi-page OCR + prefetch +
  // LLM tool loop). Without this lock, rapid-fire messages from
  // the owner (or multi-Apple-ID cross-device replays) spawn N
  // parallel pipelines that all reply minutes later — the user sees
  // a flood. With the lock: subsequent messages while one is
  // in-flight get a brief "one sec — still working on the last
  // one" + drop. The lock auto-clears when the in-flight query
  // finishes (success or error).
  private busyChat: Set<string> = new Set();

  // Futuristic helpers
  private agent: AgentClient;
  private media: MediaHandler;
  private personal: PersonalClient;
  private calendar: CalendarLookup;
  private docs: PersonalDocs;
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

    mkdirSync(this.stateDir, { recursive: true });
    this.loadState();
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
    // Garbage-collect old entries before appending.
    this.recentBridgeSends = this.recentBridgeSends.filter(
      (e) => now - e.ts < IMessageSession.BRIDGE_SEND_DEDUP_MS,
    );
    this.recentBridgeSends.push({ text, ts: now });
  }

  private isOwnBridgeSend(text: string): boolean {
    const now = Date.now();
    // Trim before compare so AppleScript whitespace quirks don't miss.
    const t = text.trim();
    for (let i = this.recentBridgeSends.length - 1; i >= 0; i--) {
      const e = this.recentBridgeSends[i];
      if (now - e.ts > IMessageSession.BRIDGE_SEND_DEDUP_MS) break;
      if (e.text.trim() === t) {
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
        for (const row of rows) {
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
    const unixMs = appleNsToUnixMs(row.date);
    const isGroup = row.chatDisplayName !== "" || row.handle === "";

    // INBOUND DEDUP. When the user has 2+ Apple IDs signed into
    // Messages on this Mac, the same logical message lands twice
    // (one row per account view) with different rowids. Key on
    // (handle, isFromMe, text) within a 5s window — too tight for
    // false legitimate retries; loose enough to catch the dual-row
    // race even on a busy laptop.
    const text = (row.text || "").trim();
    if (text && row.handle) {
      const key = `${row.handle}|${row.isFromMe ? 1 : 0}|${text}`;
      const now = Date.now();
      // GC first
      this.recentInbound = this.recentInbound.filter((e) => now - e.ts < IMessageSession.INBOUND_DEDUP_MS);
      const seen = this.recentInbound.find((e) => e.key === key);
      if (seen) {
        this.logger.debug({ rowid: row.rowid, handle: row.handle, textPreview: text.slice(0, 60) }, "duplicate inbound — skipping (multi-Apple-ID echo)");
        return;
      }
      this.recentInbound.push({ key, ts: now });
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
        && looksLikeDocQuery(text)
      ) {
        // CONCURRENCY GATE: skip if a prior query for this chat is
        // still in flight. Same gate as handleInbound — applied here
        // because the fromMe branch fires this path too when the
        // owner types directly on this Mac.
        if (this.busyChat.has(row.handle)) {
          this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "fromMe doc-query skipped — chat busy");
          return;
        }
        void this.handleOwnerDocQuery(row.handle, text);
        return;
      }

      // Capture as ownerSentHistory exemplar for style cloning. Skip
      // groups (mixed register), skip empty/short.
      if (!isGroup && row.handle && text.length >= 3) {
        this.rememberOwnerSent(row.handle, text);
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
        docQuery: looksLikeDocQuery(text),
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
        this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "skipping — chat busy with prior query");
        // Optional: nudge so the user knows we heard them. Suppressed
        // for ultra-short messages (yes/ok/no) since those already
        // got handled by the intercepts above.
        if (text.length > 8) {
          void this.send(row.handle, "⏳ still working on the previous one — give me a sec");
        }
        return;
      }

      const isDocQuery = looksLikeDocQuery(text);
      const lastDocAt = this.lastDocQueryAt.get(row.chatRowid) || 0;
      const isFollowup = !isDocQuery
        && looksLikeDocFollowup(text)
        && Date.now() - lastDocAt < 5 * 60_000;
      if (isDocQuery || isFollowup) {
        this.logger.info(
          { query: text.slice(0, 80), chatRowid: row.chatRowid, mode: isDocQuery ? "query" : "followup" },
          "self-chat doc query (cross-device)",
        );
        this.lastDocQueryAt.set(row.chatRowid, Date.now());
        void this.handleOwnerDocQuery(row.handle, text, { followup: isFollowup });
        return;
      }

      // OWNER-CHANNEL NATURAL CHAT: free-form messages from the owner
      // that aren't commands/docs/confirmations. Route to the regular
      // agent so the bridge functions as a chatbot on top of the
      // command + docs layers. Suppressed when LANTERN_OWNER_CHAT_NL=off
      // for users who treat their self-chat as a silent scratchpad.
      const nlEnabled = (process.env.LANTERN_OWNER_CHAT_NL || "on").toLowerCase() !== "off";
      if (nlEnabled && !this.muted) {
        this.logger.info({ chat: row.handle, textPreview: text.slice(0, 60) }, "owner natural chat");
        void this.handleOwnerNaturalChat(row.handle, text);
        return;
      }
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

    // Broadcast the inbound (for the dashboard live feed).
    this.broadcast({
      type: "message",
      data: { from: row.handle, text, fromMe: false, timestamp: unixMs, guid: row.guid, chatRowid: row.chatRowid, isGroup },
    });

    // Bot decisions ----------------------------------------------------
    if (!text) return; // nothing to reply to
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
    let systemHint = agentPersonaPrompt(ownerName, style, isGroup, {
      ownerSamples,
      disclosed: false,
      stylePrompt: undefined,
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

    // VIP gate: if this contact is a VIP, queue the draft for human
    // approval via the dashboard instead of auto-sending. Same flow
    // as WhatsApp's smart-draft.
    if (!isGroup && (await this.personal.isVIP(row.handle))) {
      const queued = await this.personal.queueDraft(
        row.handle,
        this.contactNames.get(row.handle) ?? undefined,
        text,
        draft,
        { channel: "imessage" },
      );
      this.broadcast({
        type: "activity",
        data: { kind: "agent_skipped", summary: queued ? `VIP draft queued for approval` : `VIP — auto-reply suppressed (queue failed)`, detail: draft.slice(0, 200), jid: row.handle, timestamp: Date.now() },
      });
      return;
    }

    // Naturalize + paced send.
    const burst = naturalize(draft, { inbound: text, style });
    for (let i = 0; i < burst.length; i++) {
      const piece = burst[i];
      await new Promise((r) => setTimeout(r, piece.delayBeforeMs));
      await new Promise((r) => setTimeout(r, piece.typingMs));
      await this.send(row.handle, piece.text);
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

    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his iMessage self-chat.`,
      `Today is ${today}. Local time of day: ${timeOfDay}.`,
      ``,
      `You ARE his Jarvis. Warm, concise, authentic. Like a sharp peer who knows him well.`,
      `  • 1-3 short lines. No corporate filler ("I'd be happy to" / "feel free" / "let me know if").`,
      `  • Lowercase, conversational.`,
      `  • Match his energy — if he's brief, you're brief.`,
      `  • For greetings ("hi", "hey"), say hello briefly + ask what he needs OR drop a useful nudge from time of day (morning → "anything on for today?", evening → "wrap-up notes for tomorrow?").`,
      `  • You can search his Mac files (passport, license, receipts, etc.) — when he mentions one, suggest the exact phrasing ("when does my passport expire", "find my I-485 receipt", "what's my green card number").`,
      `  • You can add calendar events, save notes, draft mail on his behalf — offer when relevant.`,
      `  • Use any connector tools attached to this agent in the Lantern dashboard (Gmail, Calendar, etc.) when helpful.`,
      prefetchBlock,
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

  private rememberOwnerSent(handle: string, text: string): void {
    let arr = this.ownerSentHistory.get(handle);
    if (!arr) { arr = []; this.ownerSentHistory.set(handle, arr); }
    arr.push(text);
    if (arr.length > HISTORY_DEPTH) arr.splice(0, arr.length - HISTORY_DEPTH);
  }

  private contactLabel(handle: string): string {
    return this.contactNames.get(handle) || handle;
  }

  // Owner asked a doc-query in self-chat. Search local files, inject
  // results into the LLM prompt, send the reply back. If the LLM
  // included [ATTACH:/path] markers, send those files as iMessage
  // attachments via AppleScript.
  //
  // When `opts.followup` is true, we DON'T do a fresh search —
  // we trust the agent's session memory of the previous turn to
  // know which file the user is referring to. This handles "send
  // it" / "yes" / "the first one" continuations.
  private async handleOwnerDocQuery(
    jid: string,
    query: string,
    opts: { followup?: boolean } = {},
  ): Promise<void> {
    this.busyChat.add(jid);
    try {
    this.logger.info({ query: query.slice(0, 80), followup: !!opts.followup }, "owner doc query");
    this.broadcast({
      type: "activity",
      data: {
        kind: "system",
        summary: `📁 doc ${opts.followup ? "followup" : "query"}: ${query.slice(0, 60)}`,
        timestamp: Date.now(),
      },
    });

    // Immediate ack — doc queries can take 10-15s for OCR'd PDFs.
    // Without this signal, the user thinks the bot is dead. We await
    // the send so this message lands BEFORE the answer (which might
    // come back fast for cached / non-OCR queries).
    const ackText = opts.followup
      ? "📎 grabbing it…"
      : "📁 one sec — looking through your files…";
    await this.send(jid, ackText);

    // If the heavy work runs long (>6s), send ONE progress nudge so
    // the user knows the bot is still alive on big PDFs. Cancelled
    // when the work finishes.
    const startedAt = Date.now();
    let progressFired = false;
    const progressTimer = setTimeout(() => {
      progressFired = true;
      void this.send(jid, "📷 still scanning — almost there…");
    }, 6000);
    const clearProgress = () => {
      clearTimeout(progressTimer);
      if (progressFired) {
        // GC-friendly noop. The user already saw the progress msg.
      }
    };

    // Followups skip a fresh search — the agent already has the file
    // paths in its session history. Fresh queries inject a context
    // block with search results + top-match content. Plus: if the
    // query looks appointment-y, ALSO prefetch Gmail + Calendar in
    // parallel so all sources are in the prompt at once.
    const client = defaultConnectorClient(this.logger);
    const [docsBlock, apptBlock] = await Promise.all([
      opts.followup
        ? Promise.resolve("\n\n(continuing previous doc query — use the file paths from your prior reply for any [ATTACH:...] markers)")
        : this.docs.buildContextBlock(query, { includeBodies: true }),
      looksLikeAppointmentQuery(query)
        ? prefetchAppointmentContext(client, query, this.logger).catch(() => null)
        : Promise.resolve(null),
    ]);
    const contextBlock = [docsBlock, apptBlock].filter(Boolean).join("\n");
    this.logger.info({ ms: Date.now() - startedAt, hasAppt: !!apptBlock }, "doc context built");

    // Persona: you ARE the user, answering yourself about your own
    // docs. Brief, factual, lowercase. Use [ATTACH:...] markers to
    // request file delivery.
    const today = new Date().toISOString().slice(0, 10);
    const systemHint = [
      "You are Lantern — Shekhar's personal agent, replying in his iMessage self-chat.",
      `Today is ${today}.`,
      "",
      "DATA SOURCES — use them aggressively, in this order, until you have a real answer:",
      "  1. Local Mac files (OCR'd context attached below — passport, license, scanned PDFs).",
      "  2. **Gmail** (gmail_search / gmail_list_messages tools). Appointment confirmations, receipts, order emails, doctor visit reminders all live here. ALWAYS check Gmail when the question is about an appointment, booking, reservation, order, flight, hotel, doctor visit, or anything that typically arrives as a confirmation email. Search broadly — e.g. for 'endoscopy appointment' try queries like `endoscopy`, `appointment`, `gastroenterology`, `procedure`, `colonoscopy`, then narrow by date.",
      "  3. **Google Calendar** (google-calendar_list_events). For anything time-bound, check the next 30 days.",
      "  4. Other connectors (sheets, drive, github, etc.) when relevant.",
      "NEVER respond with 'I can't access your emails / calendar / X' — if a tool exists for that data source, CALL IT. If it returns nothing, say so concretely AND name what queries you tried.",
      "",
      "STYLE — sophisticated, natural, agentic. Like Jarvis: warm, concise, never robotic.",
      "  • Direct answers first. No 'I'd be happy to' / 'feel free'.",
      "  • Lowercase, conversational. 1-3 short lines max.",
      "  • State the FACT directly when you have it. If a tool returns the data, give it. Don't say 'check the file' / 'check your inbox'.",
      "",
      "AGENTIC FOLLOW-UPS — MANDATORY when applicable:",
      "  • Answer mentions an EXPIRY / DUE DATE / DEADLINE  → ALWAYS add a second line offering a calendar event AND/OR mail-renewal reminder. Phrase as a question.",
      "    Example: 'want me to add a renewal reminder to your calendar 60 days before?'",
      "  • Answer mentions a NUMBER worth remembering (passport #, license #, account #, SSN-last-4) → offer to save it as a Note.",
      "  • Answer references a FILE the user might want delivered → offer to attach it.",
      "  • If the answer is purely factual and none of the above apply, no offer is needed.",
      "",
      "ACTIONS — you can take these on his Mac. Emit ONE marker per action on its own line at the END of your reply.",
      "  • Attach file:    `[ATTACH:/exact/absolute/path]`  (COPY paths VERBATIM from the context block)",
      "  • Calendar event: `[CALENDAR:Title|2026-08-19T09:00:00|2026-08-19T10:00:00|Optional notes]`  (local TZ, ISO)",
      "  • Note:           `[NOTE:Title|Body text]`",
      "  • Mail draft:     `[MAIL:to@x.com,b@y.com|Subject|Body]`  (opens in Mail.app for review)",
      "",
      "OFFER-then-CONFIRM rule: Don't fire an action on the FIRST mention. Instead END with one short question. If the user confirms ('yes', 'sure', 'do it', 'go') in the NEXT turn, THEN emit the marker — and put it on its own line so the bridge can parse it. Compute the actual date (e.g., 60 days before 14/09/2031 = 16/07/2031) when you emit the marker.",
      "",
      "PATHS: Many files live under iCloud Drive at `/Users/shakes/Library/Mobile Documents/com~apple~CloudDocs/...`. Never substitute `/Users/shakes/Documents/...`. If a path isn't in the context block, say you need to look again.",
      "",
      contextBlock,
    ].join("\n");

    // withTools=true so the agent can call Gmail / Calendar / etc. mid-doc
    // query — many "appointment / receipt / order" questions live in email
    // confirmations, not Mac files. Without this the LLM falsely claims
    // "I can't access email" and gives up. The OCR context block is still
    // attached so it also sees local files.
    const draft = await this.agent.respondTo(jid, query, systemHint, { withTools: true });
    clearProgress();
    this.logger.info({ totalMs: Date.now() - startedAt, hadDraft: !!draft }, "doc query done");
    if (!draft) {
      void this.send(jid, "couldn't reach the agent — try again in a sec.");
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
        personalDocsEnabled: this.personalDocsEnabled,
        killSwitch: this.killSwitch,
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
      // Toggles default to safe values: docs ON, killswitch OFF.
      // Only honor the persisted value when present.
      if (typeof data.personalDocsEnabled === "boolean") this.personalDocsEnabled = data.personalDocsEnabled;
      if (typeof data.killSwitch === "boolean") this.killSwitch = data.killSwitch;
    } catch (err) {
      this.logger.warn({ err }, "could not load bot state, starting fresh");
    }
  }
}
