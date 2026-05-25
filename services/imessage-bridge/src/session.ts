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
import { join } from "path";
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

  // Futuristic helpers
  private agent: AgentClient;
  private media: MediaHandler;
  private personal: PersonalClient;
  private calendar: CalendarLookup;

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
        // Consume so a single send isn't matched twice if a duplicate
        // delivery shows up.
        this.recentBridgeSends.splice(i, 1);
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

  // Asynchronous because media annotation may call out to Whisper +
  // vision LLM. Fire-and-forget from the polling loop; failures here
  // don't block the next poll.
  private async handleInbound(row: IMessageRow, unixMs: number, isGroup: boolean): Promise<void> {
    let text = row.text || "";

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
          `• bot: ${diag.muted ? "off" : "on"}`,
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
    });
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
    } catch (err) {
      this.logger.warn({ err }, "could not load bot state, starting fresh");
    }
  }
}
