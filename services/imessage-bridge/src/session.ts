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

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, chmodSync } from "fs";
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
import { parseNLCommand, parsePresenceCommand, type ParsedCommand, type PresenceCommand } from "@lantern/bridge-core/nl-commands";
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
import { planSubTasks, executeSubTasks, formatSubTaskBriefs, type SubTaskAdapters } from "@lantern/bridge-core/multi-agent";
import { ScreenContext, defaultScreenContextConfig } from "@lantern/bridge-core/screen-context";

// Normalize a text body for echo dedup. chat.db sometimes mutates
// whitespace, line endings, or casing on round-trips through iCloud
// sync; normalizing to lower-case + collapsed whitespace catches those
// without false-positives.
function normalizeForDedup(s: string): string {
  return (s || "").trim().replace(/\s+/g, " ").toLowerCase();
}
import { MacActions, extractActionMarkers, formatAppleCalendarBlock, type CalendarEventRead } from "@lantern/bridge-core/mac-actions";
import { humanizeWithOffer, looksLikeConfirmation, looksLikeRejection, type PendingOffer } from "@lantern/bridge-core/humanize";
import { defaultConnectorClient, prefetchAppointmentContext, looksLikeAppointmentQuery } from "@lantern/bridge-core/prefetch";
import { OwnerProfileStore } from "@lantern/bridge-core/owner-profile";
import { styleBlockFor } from "@lantern/bridge-core/per-contact-style";
import { DislikeMemory, formatDislikeBlock } from "@lantern/bridge-core/dislike-memory";
import { verifyClaims } from "@lantern/bridge-core/verifiable-claims";
import { PresenceTracker } from "@lantern/bridge-core/presence";
import { computeHoldFromSamples } from "@lantern/bridge-core/pacing";
import { EpisodicMemory, formatEpisodesBlock, maybeRecordEpisode } from "@lantern/bridge-core/episodic-memory";
import { SocialGraph, extractTopics, formatRelatedBlock } from "@lantern/bridge-core/social-graph";
import { classifyConfidence, tierBadge } from "@lantern/bridge-core/confidence-tier";
import {
  detectLifeThreat,
  detectPromptInjection,
  detectRelayPromise,
  refusalReply as escalationRefusalReply,
} from "@lantern/bridge-core/escalation-detector";
import {
  executeOutboundCall,
  renderTextWithElevenLabs,
  type OrchestratorDeps,
} from "@lantern/bridge-core/call-orchestrator";
import { CallCommitments } from "@lantern/bridge-core/call-commitments";
import { resolveContact as universalResolveContact, formatSuggestions } from "@lantern/bridge-core/contact-resolver";

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
  draftApprovalsEnabled?: boolean; // owner toggle for VIP/low-conf draft queue; default false
  escalationEnabled?: boolean;    // panic-channels master switch; default true
  pushoverEnabled?: boolean;      // Pushover siren channel; default true
  // Per-contact tail of messages the owner actually sent (from their
  // phone). Few-shot exemplars for "my voice". Persisted so the voice
  // model isn't reset on every restart (WhatsApp already persisted this;
  // iMessage didn't until now).
  ownerSentHistory?: Record<string, string[]>;
}

// chat.db reads are sub-ms (WAL + query_only, watermark-based ROWID scan),
// so a tighter poll cuts perceived latency without measurable cost. The
// poll body is synchronous (pollNewMessages) and dispatches handlers
// fire-and-forget, so a shorter interval can't overlap-tick. No downstream
// logic assumes the old 1500ms cadence (thinking-timer/pace-holds/TTLs are
// all absolute durations).
const POLL_INTERVAL_MS = 500;
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Default 60 minutes; override via LANTERN_AGENT_PAUSE_MIN (matches the
// WhatsApp bridge's env var so the owner sets it once in shared config).
const PAUSE_DURATION_MS =
  Math.max(1, Number(process.env.LANTERN_AGENT_PAUSE_MIN) || 60) * 60_000;
const HISTORY_DEPTH = 20; // per-contact inbound message ring buffer
// Per-contact depth of the owner's OWN sent messages kept as verbatim
// few-shot voice samples + style-fingerprint signal. Deeper than inbound
// history so frequent contacts carry enough authentic voice to mimic;
// still bounded so memory stays flat across many contacts.
const OWNER_SENT_DEPTH = 30;
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
  // Draft-approval queue toggle. When ON, VIPs + unfamiliar contacts
  // queue a draft for owner approval (dashboard /personal/drafts).
  // When OFF (default), VIPs go silent + unfamiliar contacts get an
  // authentic auto-reply. Seeded from LANTERN_DRAFT_APPROVALS env on
  // first boot; persisted on disk so phone commands stick.
  private draftApprovalsEnabled =
    (process.env.LANTERN_DRAFT_APPROVALS || "").toLowerCase() === "on";
  // Panic-channels master switch (Pushover siren + Twilio voice +
  // macOS notif). Default ON. Primary alerts (WA self / iMessage
  // self / email) always fire on life-threat regardless of this.
  private escalationEnabled = true;
  private pushoverEnabled = true;

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

  // OVERNIGHT REPLAY QUEUE. When a 1:1 contact (non-owner) messages
  // during quiet hours (01:00-06:00) the auto-reply is suppressed.
  // Previously the message was DROPPED FOREVER — a late-night "happy
  // anniversary" got total silence. Now we persist the inbound to a
  // per-bridge JSONL queue on disk (mode 0600 — it holds message text)
  // and replay it through the normal reply pipeline when quiet hours
  // end, with morning pacing. Survives restarts.
  private quietQueuePath: string = "";
  private quietReplayTimer: ReturnType<typeof setInterval> | null = null;
  private quietReplayInFlight = false;
  // Cap so a flood of overnight messages can't unbounded-grow the file.
  private static readonly QUIET_QUEUE_MAX =
    Number(process.env.LANTERN_QUIET_QUEUE_MAX) > 0
      ? Number(process.env.LANTERN_QUIET_QUEUE_MAX)
      : 200;
  // Per-handle daily-dedup of "what did we already replay" — defends a
  // restart mid-drain from re-replaying an entry the file still holds.
  private quietReplayed: Set<string> = new Set();

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

  // SELF-EVAL — per-msgGuid record of WHAT we sent + WHY. Lets the
  // tapback handler reconstruct the prompt when the owner taps 👎
  // (dislike) on a bot reply. Capped FIFO at 200 entries; older
  // entries fall off. In-memory only — retries lose their anchor if
  // the bridge restarts between send and react (fine; rare).
  private bridgeReplyMeta: Map<string, {
    handle: string;
    chatRowid: number;
    inboundText: string;
    replyText: string;
    systemHint: string;
    ts: number;
  }> = new Map();
  private static readonly REPLY_META_MAX = 200;
  // RESTART-SURVIVING SIDECAR for reply-meta. The in-memory map above is
  // lost on a launchd bounce, which silently killed the 👎 self-eval
  // retry (the owner taps 👎 minutes after the bot replied, by which
  // time the bridge may have respawned). We append each GUID-keyed meta
  // to a bounded JSONL file and load it on startup; the tapback handler
  // consults it when the in-memory map misses. Path set in loadReplyMeta.
  private replyMetaPersistPath = "";
  private static readonly REPLY_META_SIDECAR_MAX = 200;

  // PENDING-REPLY-META QUEUE — iMessage's AppleScript send doesn't
  // return the new GUID, so we can't directly key bridgeReplyMeta by
  // GUID at send time. Instead we push {text, meta} into this short
  // queue; the poll loop matches the next fromMe row whose text
  // equals one of the queued entries, harvests THAT row's GUID, and
  // promotes the meta into bridgeReplyMeta keyed by GUID.
  private pendingReplyMeta: Array<{
    text: string;
    meta: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string };
    queuedAt: number;
  }> = [];
  private static readonly PENDING_META_TTL_MS = 30_000;
  // TAPBACK DEDUP. The same 👎 reaction lands in chat.db twice when
  // two Apple IDs are signed into Messages (one row per account view).
  // Without dedup, handleTapbackRetry fires twice for the same target
  // GUID → owner sees two retry messages back-to-back. Key on the
  // TARGET msg guid (what was reacted to) + type, with a 60s window
  // that swallows cross-device echo without blocking a genuine
  // second-thought 👎 minutes later.
  private recentTapbacks: Array<{ targetGuid: string; type: number; ts: number }> = [];
  private static readonly TAPBACK_DEDUP_MS = 60_000;
  // PER-CHAT OUTBOUND ECHO QUEUE. Every `send()` enqueues here keyed
  // by the destination chat's rowid. The fromMe-poll path pops the
  // FRONT of this queue when it sees an empty-text is_from_me=1 row
  // for that chat — preserving send-order so a 2-send sequence
  // (e.g. "🧠 thinking…" then "ved mudarapu") doesn't pair the
  // queued reply meta with the WRONG empty-fromMe echo. Entries
  // carry an optional `meta` which is set by `queueReplyMeta` only
  // for sends we want 👎 self-eval to track. Capped per-chat at 50
  // entries; older entries fall off.
  private outboundEcho: Map<number, Array<{
    text: string;
    ts: number;
    meta?: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string };
  }>> = new Map();
  private static readonly OUTBOUND_ECHO_TTL_MS = 90_000;
  private static readonly OUTBOUND_ECHO_MAX_PER_CHAT = 50;
  // Throttle for the busy-nudge message ("⏳ still working …"). Without
  // this, every inbound while busy fires another nudge, and each
  // nudge cross-device-echoes — easy to send 10+ in a row. Cap at
  // ONE nudge per chat per 30s.
  private lastBusyNudgeAt: Map<string, number> = new Map();
  private static readonly BUSY_NUDGE_THROTTLE_MS = 30_000;

  // ANTI-REPETITION — per-contact ring buffer of the last few replies
  // the bot sent them, fed into agentPersonaPrompt so the model doesn't
  // repeat the same canned line (the "best to wait for him directly" x3
  // bug). Keyed by contact handle; capped at the last 5 entries.
  private recentBotReplies: Map<string, string[]> = new Map();
  private static readonly RECENT_BOT_REPLIES_MAX = 5;

  // Per-handle timestamp of the contact's last inbound message. Lets the
  // persona prompt label whether this turn continues an active thread or
  // starts fresh, so the bot picks up mid-conversation instead of greeting
  // cold (and doesn't treat a days-later message as continuous). In-memory
  // only (a fresh thread after restart is fine). Parity with the WhatsApp
  // bridge — keep the wording + threshold identical.
  private lastInboundTs: Map<string, number> = new Map();
  // A turn within this window of the previous inbound is a continuation.
  private static readonly THREAD_CONTINUATION_MS = 6 * 60 * 60 * 1000;

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
  private dislikeMemory: DislikeMemory;
  private presence: PresenceTracker;
  private episodicMemory: EpisodicMemory;
  private socialGraph: SocialGraph;

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
    this.dislikeMemory = new DislikeMemory({ logger: this.logger });
    this.presence = new PresenceTracker({ logger: this.logger });
    this.episodicMemory = new EpisodicMemory({ logger: this.logger });
    this.socialGraph = new SocialGraph({ logger: this.logger });

    // Screen-context provider — OPT-IN via LANTERN_SCREEN_OCR=on.
    // OCR fn directly calls the control-plane /v1/vision/ocr endpoint
    // (same one personal-docs uses for scanned PDF pages). Bypasses
    // personal-docs' isAllowedPath check because screen captures live
    // in /tmp, not the configured roots.
    this.screenContext = new ScreenContext(
      defaultScreenContextConfig(),
      this.logger,
      async (pngPath: string): Promise<string> => {
        try {
          const fs = await import("fs");
          const { authedFetch } = await import("@lantern/bridge-core/auth");
          const buf = fs.readFileSync(pngPath);
          const res = await authedFetch("/v1/vision/ocr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageDataUrl: `data:image/png;base64,${buf.toString("base64")}`,
              prompt: "OCR this screen. Capture all visible text accurately. Skip pure decorative elements.",
            }),
          });
          if (!res.ok) return "";
          const data = (await res.json()) as { text?: string };
          return (data.text || "").trim();
        } catch {
          return "";
        }
      },
    );

    mkdirSync(this.stateDir, { recursive: true });
    this.quietQueuePath = join(this.stateDir, "quiet-queue.jsonl");
    this.loadState();
    this.loadBridgeSends();
    this.loadReplyMeta();
  }

  private screenContext: ScreenContext;

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
    // Pre-seed per-contact owner-voice samples from chat.db so the bot
    // can mimic the owner's real style from the first inbound — instead
    // of waiting for the owner to text during this process's lifetime.
    // Best-effort, non-blocking; scheduled off the boot path so a large
    // chat.db scan never delays `ready`.
    setImmediate(() => this.seedOwnerVoiceFromHistory());
    // Start screen-context capture (no-op when LANTERN_SCREEN_OCR=off).
    this.screenContext.start();
    this.everConnected = true;
    this.startPolling();
    this.startDailyDigest();
    this.startOfflineMonitor();
    this.startQuietReplay();
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
    if (this.quietReplayTimer) {
      clearInterval(this.quietReplayTimer);
      this.quietReplayTimer = null;
    }
    this.screenContext?.stop();
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

  // Public read of the owner's device calendar (iCloud + Google + subscribed)
  // from the macOS Calendar store. Backs the `read_calendar` agentic tool
  // (control-plane bridge callback) + the diagnostic endpoint.
  async getUpcomingCalendar(
    opts: { days?: number; max?: number; query?: string; fromIso?: string; toIso?: string } = {},
  ): Promise<Array<{ title: string; start: string; end: string | null; calendar: string }>> {
    const events = await this.macActions.readUpcomingEvents(opts);
    return events.map((e) => ({
      title: e.title,
      start: e.start.toISOString(),
      end: e.end ? e.end.toISOString() : null,
      calendar: e.calendar,
    }));
  }

  // Proactive ingester for UNKNOWN-sender inbound. Appointment confirmation →
  // DM the owner + arm a "yes" offer that adds it to the calendar (reusing the
  // freeform-followup → [CALENDAR:] path). Marketing/spam → suppress. Returns
  // "handled" to skip the normal auto-reply path. Best-effort + flag-gated.
  private async maybeIngestUnknownInbound(handle: string, text: string): Promise<"handled" | "pass"> {
    if ((process.env.LANTERN_APPT_INGEST || "on").toLowerCase() === "off") return "pass";
    if (!handle || !text) return "pass";
    // Only UNKNOWN senders — never reclassify a saved contact / known person.
    if (this.contactNames.has(handle)) return "pass";
    if (this.ownerProfileStore.relationshipFor(handle, undefined)) return "pass";
    let kind: "appointment" | "spam" | "other";
    let signals: string[];
    try {
      const { classifyUnknownInbound } = await import("@lantern/bridge-core/inbound-classifier");
      ({ kind, signals } = classifyUnknownInbound(text));
    } catch { return "pass"; }
    if (kind === "other") return "pass";
    if (kind === "spam") {
      this.logger.info({ handle, signals }, "ingest: suppressed marketing/spam from unknown sender");
      return "handled"; // marketing from a stranger → silence
    }
    // appointment
    this.logger.info({ handle, signals }, "ingest: appointment confirmation from unknown sender");
    const ownerHandle = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim();
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (ownerHandle) {
      const offerText = `📅 Looks like an appointment text from ${handle}:\n"${snippet}"\nReply "yes" to add it to your calendar.`;
      await this.send(ownerHandle, offerText).catch(() => {});
      this.pendingOffers.set(ownerHandle, {
        kind: "freeform-followup",
        freeformAction: `Add this appointment to my calendar — emit a [CALENDAR:Title|start-ISO|end-ISO?|notes] marker with the correct title, date, and time parsed from: "${snippet}"`,
        freeformInbound: text,
        freeformPriorReply: offerText,
        issuedAt: Date.now(),
      } as any);
    }
    return "handled"; // don't auto-reply to the unknown sender
  }

  // Apply an owner presence/status command from self-chat (set place + timer,
  // or clear), then confirm back to the owner.
  private async applyPresenceCommand(pres: PresenceCommand, replyHandle: string): Promise<void> {
    const owner = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim() || replyHandle;
    if (pres.action === "clear") {
      this.presence.clearOverride();
      await this.send(owner, "✅ status cleared — you're marked available again.").catch(() => {});
      return;
    }
    this.presence.setStatus({ label: pres.label, place: pres.place, durationMs: pres.durationMs });
    const mins = pres.durationMs ? Math.round(pres.durationMs / 60_000) : null;
    const forText = mins ? (mins >= 60 && mins % 60 === 0 ? ` for ${mins / 60}h` : ` for ${mins}m`) : "";
    await this.send(
      owner,
      `📍 got it — you're ${pres.label}${forText}. I'll tell anyone who messages that you'll get back, and offer to take a message. Say "I'm back" to clear.`,
    ).catch(() => {});
  }

  // Public contact search over the macOS AddressBook (name → phones + emails).
  // Backs the `search_contacts` agentic tool.
  async searchContacts(query: string, limit?: number) {
    const { searchAddressBookContacts } = await import("@lantern/bridge-core/contact-resolver");
    return searchAddressBookContacts(query, { limit, logger: this.logger });
  }

  // Twilio SMS fallback for non-iMessage recipients. When the iMessage send
  // fails (the contact isn't an iMessage buddy — i.e. an SMS/RCS-only number),
  // deliver the reply as SMS via the control-plane's Twilio connector so the
  // bot can still respond. Only fires when LANTERN_TWILIO_NUMBER is set and the
  // target looks like a phone number (never for iMessage-email handles). The
  // contact receives the text from the Twilio number, not the owner's cell.
  private async trySmsFallback(to: string, text: string): Promise<boolean> {
    const from = (
      process.env.LANTERN_TWILIO_NUMBER ||
      process.env.LANTERN_TWILIO_SMS_FROM ||
      ""
    ).trim();
    if (!from) return false;
    // phone-ish only: digits with an optional leading '+', at least 8 chars.
    // iMessage email handles ("foo@bar.com") are skipped — SMS needs a number.
    const digits = to.replace(/[^\d]/g, "");
    if (to.includes("@") || digits.length < 8) return false;
    try {
      const { authedFetch } = await import("@lantern/bridge-core/auth");
      const res = await authedFetch(
        "/v1/connectors/twilio/execute?action=send_sms",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, from, body: text }),
        },
      );
      if (!res.ok) {
        this.logger.warn(
          { to, status: res.status },
          "twilio SMS fallback failed",
        );
        return false;
      }
      this.logger.info(
        { to },
        "delivered via Twilio SMS fallback (iMessage send failed)",
      );
      return true;
    } catch (err) {
      this.logger.warn({ err }, "twilio SMS fallback exception");
      return false;
    }
  }

  async send(to: string, text: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.state !== "ready") {
      return { ok: false, reason: `bridge not ready (state=${this.state})` };
    }
    // FINAL PASS — verifiable-claims rewriter. Catches "I sent him an
    // email" / "I added it to your calendar" / "I told him" when no
    // such action was performed and rewrites to honest intent. Skip
    // for bridge-self status messages (acks, "thinking…") via the
    // bot-self prefix check so we don't molest those.
    if (text && !isBotSelfMessage(text)) {
      const verdict = verifyClaims(text);
      if (verdict.rewrites.length > 0) {
        this.logger.info(
          { to, rewrites: verdict.rewrites },
          "verifiable-claims rewrote outbound (false-action claim guarded)",
        );
        text = verdict.text;
      }
    }
    const res = await this.sender.send(to, text);
    if (!res.ok) {
      // iMessage couldn't deliver (e.g. SMS/RCS-only number) — try SMS.
      const smsOk = await this.trySmsFallback(to, text);
      if (!smsOk) return res;
      // fell back to SMS successfully — continue the normal post-send path.
    }
    // Record so the polling loop skips this row when chat.db echoes
    // it back as is_from_me=1.
    this.recordBridgeSend(text);
    // Push into the per-chat outbound echo FIFO so empty-fromMe
    // rows can be paired with their originating send in ORDER —
    // critical when we send multiple messages back-to-back
    // (e.g. "🧠 thinking…" + the real reply).
    this.enqueueOutboundEcho(to, text);
    this.broadcast({
      type: "agent_reply",
      data: { to, text, timestamp: Date.now() },
    });
    return { ok: true };
  }

  private enqueueOutboundEcho(handle: string, text: string): void {
    const chatRowid = this.lastChatRowidForHandle.get(handle);
    if (chatRowid === undefined) return;
    const now = Date.now();
    let q = this.outboundEcho.get(chatRowid);
    if (!q) {
      q = [];
      this.outboundEcho.set(chatRowid, q);
    }
    // GC entries past TTL (in case poll loop fell behind and never
    // consumed them — rare; protects against unbounded growth).
    while (q.length > 0 && now - q[0].ts > IMessageSession.OUTBOUND_ECHO_TTL_MS) {
      q.shift();
    }
    q.push({ text, ts: now });
    if (q.length > IMessageSession.OUTBOUND_ECHO_MAX_PER_CHAT) {
      q.splice(0, q.length - IMessageSession.OUTBOUND_ECHO_MAX_PER_CHAT);
    }
  }

  // Pop the front of the outbound-echo FIFO for `chatRowid`. Returns
  // the entry if any. Used by the empty-fromMe-row harvest path so
  // each echo claims the next-in-line send (preserving order across
  // multi-send sequences). If the popped entry has `meta`, the
  // caller registers the GUID against bridgeReplyMeta.
  private popOutboundEcho(chatRowid: number): { text: string; meta?: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string } } | undefined {
    const q = this.outboundEcho.get(chatRowid);
    if (!q || q.length === 0) return undefined;
    const entry = q.shift()!;
    if (q.length === 0) this.outboundEcho.delete(chatRowid);
    return entry;
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

  // Load the reply-meta sidecar into bridgeReplyMeta on startup so a 👎
  // tapback still finds its anchor after a launchd respawn. JSONL: one
  // {guid, meta} record per line; FIFO-capped on load (last N win).
  private loadReplyMeta(): void {
    this.replyMetaPersistPath = join(this.stateDir, "reply-meta.jsonl");
    try {
      if (!existsSync(this.replyMetaPersistPath)) return;
      const raw = readFileSync(this.replyMetaPersistPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const recent = lines.slice(-IMessageSession.REPLY_META_SIDECAR_MAX);
      for (const line of recent) {
        try {
          const rec = JSON.parse(line) as {
            guid?: string;
            meta?: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string; ts: number };
          };
          if (rec.guid && rec.meta) this.bridgeReplyMeta.set(rec.guid, rec.meta);
        } catch { /* skip a corrupt line */ }
      }
      this.logger.info({ loaded: this.bridgeReplyMeta.size }, "loaded reply-meta sidecar");
    } catch (err) {
      this.logger.warn({ err }, "failed to load reply-meta sidecar — starting fresh");
    }
  }

  // Append a GUID-keyed meta record to the sidecar and trim it back to
  // the FIFO cap. Best-effort; never throws into the send path.
  private persistReplyMeta(
    guid: string,
    meta: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string; ts: number },
  ): void {
    if (!this.replyMetaPersistPath || !guid) return;
    try {
      const line = JSON.stringify({ guid, meta }) + "\n";
      appendFileSync(this.replyMetaPersistPath, line);
      // Trim: rewrite keeping only the last N lines so the file can't
      // grow unbounded. Cheap — the file is capped to ~200 short lines.
      const raw = readFileSync(this.replyMetaPersistPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length > IMessageSession.REPLY_META_SIDECAR_MAX) {
        writeFileSync(
          this.replyMetaPersistPath,
          lines.slice(-IMessageSession.REPLY_META_SIDECAR_MAX).join("\n") + "\n",
        );
      }
    } catch (err) {
      this.logger.warn({ err }, "failed to persist reply-meta sidecar");
    }
  }

  // Look up a reply-meta record by GUID from the on-disk sidecar. Used
  // by the tapback handler when the in-memory map misses (FIFO eviction
  // or a restart between send and the 👎). Returns the most recent
  // matching record. Best-effort; null on any read/parse failure.
  private lookupReplyMetaFromSidecar(
    guid: string,
  ): { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string; ts: number } | undefined {
    if (!this.replyMetaPersistPath || !guid) return undefined;
    try {
      if (!existsSync(this.replyMetaPersistPath)) return undefined;
      const raw = readFileSync(this.replyMetaPersistPath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      // Walk newest → oldest so the freshest record for this GUID wins.
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]) as {
            guid?: string;
            meta?: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string; ts: number };
          };
          if (rec.guid === guid && rec.meta) return rec.meta;
        } catch { /* skip a corrupt line */ }
      }
    } catch (err) {
      this.logger.warn({ err }, "reply-meta sidecar lookup failed");
    }
    return undefined;
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

    // REACTION / TAPBACK HANDLING.
    //   - 👎 dislike (2002) on a bot-self message in owner self-chat
    //     → trigger critique-retry on that specific reply
    //   - all other tapbacks → ignore (not a reply prompt)
    if (row.associatedMessageType && row.associatedMessageType !== 0) {
      // SELF-EVAL: 👎 (dislike, type 2002) from the OWNER on a
      // message we sent. Look up the original via the
      // associated_message_guid → bridgeReplyMeta → re-prompt LLM.
      if (
        row.associatedMessageType === 2002 &&
        row.associatedMessageGuid &&
        !(row.chatDisplayName !== "" || row.handle === "") &&
        this.isOwnerChatRow(row) &&
        this.bridgeReplyMeta.has(row.associatedMessageGuid)
      ) {
        // CROSS-DEVICE TAPBACK DEDUP. The 👎 echoes once per Apple ID
        // signed into Messages — same target GUID, different rowid.
        // Without this guard the retry fires N times back-to-back.
        const now = Date.now();
        this.recentTapbacks = this.recentTapbacks.filter(
          (e) => now - e.ts < IMessageSession.TAPBACK_DEDUP_MS,
        );
        const seen = this.recentTapbacks.find(
          (e) => e.targetGuid === row.associatedMessageGuid && e.type === row.associatedMessageType,
        );
        if (seen) {
          this.logger.debug(
            { rowid: row.rowid, targetGuid: row.associatedMessageGuid },
            "duplicate tapback — skipping (cross-device echo)",
          );
          return;
        }
        this.recentTapbacks.push({
          targetGuid: row.associatedMessageGuid,
          type: row.associatedMessageType,
          ts: now,
        });

        this.logger.info(
          { rowid: row.rowid, targetGuid: row.associatedMessageGuid },
          "self-eval: 👎 tapback on bot reply — triggering critique-retry",
        );
        // Fire-and-forget; never blocks the poll loop.
        void this.handleTapbackRetry(row.associatedMessageGuid, row.handle).catch((err) =>
          this.logger.warn({ err }, "tapback retry failed"),
        );
        return;
      }
      this.logger.debug(
        { rowid: row.rowid, handle: row.handle, type: row.associatedMessageType, targetGuid: row.associatedMessageGuid },
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

    // EARLY CONFIRMATION INTERCEPT — must run BEFORE cross-device dedup and
    // the fromMe-handling path below, both of which were swallowing the
    // owner's "yes" to a pending offer. Symptom: a perfect call pre-flight,
    // owner replies "Yes", but the duplicate-inbound dedup (keyed on
    // handle|text) dropped the actionable copy and the offer never executed
    // → no call. Safe against the duplicate arrival: executeCachedOffer is
    // one-shot (deletes the offer first), so the second "yes" finds nothing.
    if (this.personalDocsEnabled && !isGroup && text && this.isOwnerChatRow(row)) {
      this.gcPendingOffers();
      const pending = this.pendingOffers.get(row.handle);
      if (pending && looksLikeConfirmation(text)) {
        this.logger.info({ kind: pending.kind, chat: row.handle }, "executing cached offer on confirmation (early intercept)");
        this.pendingOffers.delete(row.handle);
        void this.executeCachedOffer(row.handle, pending);
        return;
      }
      if (pending && looksLikeRejection(text)) {
        this.logger.info({ kind: pending.kind, chat: row.handle }, "dropping cached offer on rejection (early intercept)");
        this.pendingOffers.delete(row.handle);
        void this.send(row.handle, "👍 no worries");
        return;
      }
    }

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
        // SELF-EVAL meta harvest — if this echo matches a queued
        // pending-reply-meta entry, pair its GUID with the meta
        // so the next 👎 tapback can look it up.
        this.harvestPendingReplyMeta(text, row.guid, row.chatRowid);
        return;
      }

      // Empty-text fromMe row (no attachments → not a voice cmd):
      // modern macOS stores AppleScript-sent message bodies in the
      // `attributedBody` blob and leaves `text` empty for the
      // sender's view. The tapback target GUID points at THIS row,
      // so we MUST register its GUID against the queued reply meta
      // — otherwise 👎 self-eval is silently dead.
      if (!text && !row.hasAttachments) {
        if (this.harvestPendingReplyMeta("", row.guid, row.chatRowid)) {
          return;
        }
        // No pending meta matched — probably an empty system row.
        // Drop silently rather than running it through the
        // owner-command parser (which would no-op anyway).
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
        void this.handleOwnerDocQuery(row.handle, text, row.chatRowid).catch((err) =>
          this.logger.error({ err }, "handleOwnerDocQuery threw"),
        );
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
    void this.handleInbound(row, unixMs, isGroup).catch((err) =>
      this.logger.error({ err }, "handleInbound threw"),
    );
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

    // Media: attach a synthetic-text annotation when an attachment is
    // present and no text was sent. We do this EARLY (before any
    // text-gated branch) so images sent to owner self-chat OR to a
    // contact thread both produce a meaningful inbound for the LLM.
    // Previously the annotation ran after the owner-self-chat gate,
    // which itself required `text` — so attachment-only messages
    // bypassed the self-chat agent entirely.
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
      // If annotation produced nothing usable, synthesize a minimal
      // placeholder so downstream branches at least know SOMETHING
      // arrived. Keeps the bot from going stone-silent on attachments
      // it couldn't decode — owner sees the placeholder and can ask
      // for follow-up if needed.
      if (!text) {
        text = "[they sent an attachment I couldn't decode]";
      }
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
      // Presence / "I'm away" status (set place + timer, or clear).
      const pres = parsePresenceCommand(text);
      if (pres) {
        void this.applyPresenceCommand(pres, row.handle);
        return;
      }
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
          void this.handleOwnerNaturalChat(row.handle, text).catch((err) =>
            this.logger.error({ err }, "handleOwnerNaturalChat threw"),
          );
        }
        return;
      }
      this.logger.info({ query: text.slice(0, 80), chatRowid: row.chatRowid }, "owner self-chat → agentic pipeline (LLM-driven tools)");
      this.lastDocQueryAt.set(row.chatRowid, Date.now());
      // Cache the chatRowid against the handle so the queue drain can
      // pull recent transcript correctly even when it fires later.
      this.lastChatRowidForHandle.set(row.handle, row.chatRowid);
      // Fire-and-forget: scan this self-chat message for durable
      // facts about the owner's world and auto-append them to the
      // profile. If anything was learned, send a short ack so the
      // owner can SEE what landed in memory.
      void this.maybeAutoUpdateOwnerProfileFromSelfChat(row.handle, text).catch((err) =>
        this.logger.error({ err }, "maybeAutoUpdateOwnerProfileFromSelfChat threw"),
      );
      void this.handleOwnerDocQuery(row.handle, text, row.chatRowid).catch((err) =>
        this.logger.error({ err }, "handleOwnerDocQuery threw"),
      );
      return;
    }

    // (Media annotation moved earlier — see top of handleInbound.)

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

    // PROACTIVE INGESTER (unknown senders): appointment confirmations →
    // surface to the owner + offer to add to the calendar; marketing/spam →
    // suppress (no auto-reply). Behind LANTERN_APPT_INGEST (default on).
    const ingest = await this.maybeIngestUnknownInbound(row.handle, text).catch(() => "pass" as const);
    if (ingest === "handled") return;

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

    // ─────────────────────────────────────────────────────
    // SAFETY GUARDS — run BEFORE the LLM. Hard-fail on
    // life-threat + prompt-injection. See escalation-detector.ts.
    // ─────────────────────────────────────────────────────
    if (!isGroup) {
      const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];
      const lifeThreat = detectLifeThreat(text);
      if (lifeThreat) {
        this.logger.warn(
          { from: row.handle, reason: lifeThreat.reason, pattern: lifeThreat.pattern, textPreview: text.slice(0, 140) },
          "🚨 LIFE-THREAT detected (iMessage) — escalating + voice-calling owner",
        );
        await this.fireOwnerEscalation({
          kind: "life-threat",
          reason: lifeThreat.reason,
          from: row.handle,
          senderName: this.contactNames.get(row.handle),
          contactText: text,
        });
        try {
          await this.send(row.handle, escalationRefusalReply("life-threat", ownerName));
        } catch (err) {
          this.logger.error({ err }, "life-threat refusal send failed (imessage)");
        }
        // Pause the contact so any follow-up doesn't trigger
        // another full LLM round — owner is paged.
        this.pauseContact(row.handle);
        return;
      }
      const injection = detectPromptInjection(text);
      if (injection) {
        this.logger.warn(
          { from: row.handle, reason: injection.reason, pattern: injection.pattern, textPreview: text.slice(0, 140) },
          "🛡 PROMPT-INJECTION detected (iMessage) — refusing + escalating",
        );
        await this.fireOwnerEscalation({
          kind: "prompt-injection",
          reason: injection.reason,
          from: row.handle,
          senderName: this.contactNames.get(row.handle),
          contactText: text,
        });
        try {
          await this.send(row.handle, escalationRefusalReply("prompt-injection", ownerName));
        } catch (err) {
          this.logger.error({ err }, "prompt-injection refusal send failed (imessage)");
        }
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

    // Quiet hours: skip auto-reply during sleeping hours — but DON'T
    // drop the message. Persist non-owner 1:1 inbounds to the overnight
    // replay queue so they get a warm reply with morning pacing when the
    // window reopens (a late-night "happy anniversary" no longer gets
    // total silence). Owner self-chat is exempt (the owner's own queries
    // are handled live and shouldn't be deferred).
    if (!isGroup) {
      const qh = defaultQuietHours();
      if (isQuietHours(new Date(), qh)) {
        if (!this.isOwnerChatRow(row)) {
          this.enqueueQuietReplay(row, unixMs);
        }
        this.broadcast({ type: "activity", data: { kind: "agent_skipped", summary: "quiet hours — queued for morning reply", jid: row.handle, timestamp: Date.now() } });
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
    // World-class authenticity blocks: per-contact style fingerprint,
    // dislike memory, live presence, episodic memory, cross-contact
    // context. Each best-effort; empty block when data unavailable
    // (persona falls back to prior behavior).
    const contactStyleBlock = !isGroup ? styleBlockFor(ownerSamples) : "";
    // Cross-contact recall — episodes from other chats (self-chat
    // especially) that mention this contact by first name. Surfaces
    // "Sujith was here this weekend" when Sujith messages later.
    const senderFirstNames: string[] = [];
    const senderDisplay = this.contactNames.get(row.handle);
    if (senderDisplay && !isGroup) {
      const f = senderDisplay.split(/\s+/)[0]?.toLowerCase();
      if (f && f.length >= 2) senderFirstNames.push(f);
    }
    // Cross-thread context: extract topics from the current inbound,
    // pull related messages from OTHER contacts in the last 7 days.
    const inboundTopics = !isGroup ? extractTopics(text) : [];
    // PERF: these five reads (dislike memory, episodic per-jid, episodic
    // cross-contact mentions, social-graph related, presence) are mutually
    // INDEPENDENT — each hits its own SQLite table / cache and none consumes
    // another's result. Their only inputs (senderFirstNames, inboundTopics)
    // are computed synchronously above, so we fan them out in parallel
    // instead of awaiting serially. allEpisodes/lowContext still merge them
    // afterward exactly as before.
    const [dislikeEntries, episodes, mentionEpisodes, related, presenceSnap] = await Promise.all([
      !isGroup ? this.dislikeMemory.forJid(row.handle, 3) : Promise.resolve([]),
      !isGroup ? this.episodicMemory.forJid(row.handle, 5) : Promise.resolve([]),
      !isGroup && senderFirstNames.length > 0
        ? this.episodicMemory.forMentions(senderFirstNames, { excludeJid: row.handle, limit: 3, maxAgeDays: 30 })
        : Promise.resolve([]),
      !isGroup && inboundTopics.length > 0
        ? this.socialGraph.related({ topics: inboundTopics, excludeJid: row.handle, limit: 4 })
        : Promise.resolve([]),
      this.presence.current({
        nextEvent: async () => {
          try { return await this.calendar.nextMeetingWindow?.(); } catch { return null; }
        },
      }),
    ]);
    const dislikeBlock = formatDislikeBlock(dislikeEntries);
    const allEpisodes = [...episodes, ...mentionEpisodes]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 6);
    const episodesBlock = formatEpisodesBlock(allEpisodes);
    const imWordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const lowContext =
      !isGroup &&
      imWordCount <= 6 &&
      allEpisodes.length === 0 &&
      dislikeEntries.length === 0 &&
      (!recentTranscript || recentTranscript.trim().length < 20);
    const relatedBlock = formatRelatedBlock(related);
    // Index THIS inbound into the social graph so future replies to
    // other contacts can find it. Fire-and-forget.
    if (!isGroup && inboundTopics.length > 0) {
      void this.socialGraph.record({
        jid: row.handle,
        contactName: this.contactNames.get(row.handle),
        text: text.slice(0, 200),
        fromMe: false,
        topics: inboundTopics,
      });
    }
    let presenceLine = presenceSnap.line || "";
    // AWAY directive: tell the contact where the owner is + offer to take a
    // message ("Shekhar's at the temple, he'll get back — can I pass a note?").
    if (presenceSnap.away && !isGroup) {
      const where = presenceSnap.place ? `at ${presenceSnap.place}` : presenceSnap.line;
      presenceLine =
        `${ownerName} is ${where} right now and away from messages. ` +
        `If this needs ${ownerName}, tell them warmly that he's ${where} and will get back to them` +
        (presenceSnap.takeMessage
          ? `, then OFFER to take a message ("want me to pass anything along?"). If they leave one, acknowledge you'll make sure ${ownerName} gets it.`
          : `.`) +
        ` Keep it short and natural — don't pretend to be ${ownerName} mid-activity.`;
    }

    // Owner's dashboard/agent style override (the configured persona
    // tweaks). Best-effort — falls back to undefined on any error so a
    // reply never blocks on the control-plane. Mirrors the WhatsApp bridge.
    const stylePrompt = await this.agent.getStylePrompt().catch(() => undefined);

    let systemHint = agentPersonaPrompt(ownerName, style, isGroup, {
      ownerSamples,
      disclosed: false,
      stylePrompt,
      ownerProfile,
      relationship,
      recentTranscript,
      languageModality,
      contactStyleBlock,
      dislikeBlock,
      presence: presenceLine,
      episodesBlock,
      relatedBlock,
      lowContext,
      // Structured owner facts (ground truth) so the bot never denies a
      // known fact ("happy anniversary" gets a truthful reply).
      ownerFacts: this.ownerProfileStore.factsBlock(),
      // Per-contact addressing rule — what to call them, what never to.
      addressRule: isGroup
        ? undefined
        : this.ownerProfileStore.addressRuleFor(row.handle, this.contactNames.get(row.handle)) ?? undefined,
      // Anti-repetition — recent replies sent to THIS contact so the
      // model varies its phrasing instead of repeating a canned line.
      recentBotReplies: isGroup ? [] : this.recentBotReplies.get(row.handle) ?? [],
    });
    // Per-contact memory: UNIFIED cross-channel view — facts learned on
    // ANY channel (WhatsApp, iMessage, SMS, voice, email) + a 14-day
    // recent-timeline slice + vector-ranked recall keyed on the inbound
    // text. So a person who texts here AND on WhatsApp is one person, and
    // iMessage gets long-term/semantic recall instead of cold-starting.
    // Falls back safely to the per-handle factsBlock when the control-plane
    // is unreachable, so it's always safe in place of factsBlock.
    // PERF: fetch ONCE and reuse — this same block is also consulted by
    // the low-confidence gate below. It's an HTTP round-trip to the
    // control-plane, so calling it twice per reply doubled that latency.
    const contactFactsBlock = !isGroup ? await this.personal.unifiedBlock("imessage", row.handle, text) : "";
    if (contactFactsBlock) systemHint += contactFactsBlock;

    // Lightweight thread continuity (parity with the WhatsApp bridge —
    // keep the wording + 6h threshold identical). If the previous inbound
    // from this contact was recent, tell the model to pick up the active
    // thread; otherwise treat it as a fresh conversation. Read BEFORE the
    // timestamp is updated below so this turn compares against the prior one.
    if (!isGroup) {
      const prevInbound = this.lastInboundTs.get(row.handle);
      const continuing =
        prevInbound !== undefined &&
        Date.now() - prevInbound < IMessageSession.THREAD_CONTINUATION_MS;
      systemHint += continuing
        ? `\n\n(This is a continuation of an active thread — pick up where you left off; don't re-greet or reintroduce yourself.)`
        : `\n\n(This is a fresh conversation — there's been a gap since you last spoke.)`;
      this.lastInboundTs.set(row.handle, Date.now());
    }
    // Calendar awareness for contact replies. The owner's DEVICE calendar
    // (iCloud + Google + subscribed) is the source of truth — a contact asking
    // "when are you coming to the Bay Area?" must be answerable.
    // PERF/GATE: readUpcomingEvents can fall back to AppleScript (1-3s), so we
    // only run it when the inbound actually looks schedule/availability-bound
    // (needsCalendar || looksLikeAppointmentQuery). Casual messages skip it
    // entirely. The prior version read it for EVERY 1:1 inbound regardless of
    // content, which dominated reply latency for plain chatter.
    if (!isGroup && (needsCalendar(text) || looksLikeAppointmentQuery(text))) {
      try {
        const ev = await this.macActions.readUpcomingEvents({ days: 45, max: 15 });
        const calBlock = formatAppleCalendarBlock(ev, { max: 15 });
        if (calBlock) {
          systemHint +=
            `\n\n(${ownerName}'s upcoming schedule — use it to answer travel / availability / "when are you coming" / plans questions accurately. Share only what's relevant to this conversation; don't recite the whole calendar.)` +
            calBlock;
        }
      } catch (err) {
        this.logger.debug({ err }, "contact-reply device calendar read failed");
      }
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
    //   - VIP: contact is on the owner's VIP list.
    //   - Low confidence: unfamiliar contact (no prior owner samples,
    //     no facts, no relationship).
    //
    // Both paths are OPT-IN via `LANTERN_DRAFT_APPROVALS=on`. When off
    // (the default), the bridge does NOT queue drafts for approval and
    // does NOT cross-channel-ping the owner. Behavior in OFF mode:
    //   - VIP contact: stay silent (safer than auto-sending to someone
    //     the owner explicitly flagged as sensitive).
    //   - Low-confidence: stay silent (don't auto-send to a stranger,
    //     don't spam owner with approval pings).
    //   - Familiar contact (relationship/facts/samples present):
    //     auto-send as normal — unchanged.
    // The owner can manually reply to the silent cases from their
    // phone; the bot never pretends to speak for them with someone it
    // doesn't know.
    // Two-layer gate (matches WhatsApp bridge semantics):
    //   APPROVALS=on  → VIP + low-conf both queue a draft for approval.
    //   APPROVALS=off → VIP stays silent; low-conf FALLS THROUGH and
    //                   auto-replies normally. The bot's whole purpose
    //                   is handling unfamiliar contacts — silencing
    //                   them defeats it.
    // Reads the persisted toggle (NOT the env var). Env is only the
    // first-boot default; runtime is owned by phone commands so
    // "approvals on"/"approvals off" sticks across restarts.
    const draftApprovalsOn = this.draftApprovalsEnabled;
    // Knowing their name (Contacts.app match → contactNames cache)
    // counts as familiar — auto-reply directly without going through
    // the low-confidence approval path.
    const displayName = (this.contactNames.get(row.handle) || "").trim();
    const lowConfidence =
      !isGroup &&
      ownerSamples.length === 0 &&
      !relationship &&
      !displayName &&
      !contactFactsBlock; // reuse the per-contact facts fetched above
    const isVIP = !isGroup && (await this.personal.isVIP(row.handle));

    if (isVIP) {
      if (!draftApprovalsOn) {
        this.logger.info({ from: row.handle }, "auto-reply suppressed — VIP (drafts off)");
        this.broadcast({
          type: "activity",
          data: {
            kind: "agent_skipped",
            summary: "silent on VIP (drafts disabled)",
            detail: draft.slice(0, 200),
            jid: row.handle,
            timestamp: Date.now(),
          },
        });
        return;
      }
      const queued = await this.personal.queueDraft(
        row.handle,
        this.contactNames.get(row.handle) ?? undefined,
        text,
        draft,
        { channel: "imessage" },
      );
      this.broadcast({
        type: "activity",
        data: {
          kind: "agent_skipped",
          summary: queued ? "VIP draft queued for approval" : "VIP — auto-reply suppressed (queue failed)",
          detail: draft.slice(0, 200),
          jid: row.handle,
          timestamp: Date.now(),
        },
      });
      return;
    }

    if (lowConfidence && draftApprovalsOn) {
      const queued = await this.personal.queueDraft(
        row.handle,
        this.contactNames.get(row.handle) ?? undefined,
        text,
        draft,
        { channel: "imessage" },
      );
      this.broadcast({
        type: "activity",
        data: {
          kind: "agent_skipped",
          summary: queued ? "draft queued for approval — low-confidence (unfamiliar contact)" : "low-confidence — auto-reply suppressed (queue failed)",
          detail: draft.slice(0, 200),
          jid: row.handle,
          timestamp: Date.now(),
        },
      });
      return;
    }

    // Confidence-tier classification (HIGH/MEDIUM/LOW). HIGH sends
    // normally; MEDIUM additionally cross-channel-pings the owner
    // after send; LOW holds the draft for 30s with an owner override
    // window. Logs the verdict for offline calibration.
    // Reuse the dislike entries already fetched in the parallel block
    // above (limit 3) — re-querying just to check for existence was a
    // redundant round-trip.
    const tier = classifyConfidence({
      replyText: draft,
      inboundText: text,
      relationship,
      hasPriorSamples: ownerSamples.length > 0,
      hasPriorDislikes: dislikeEntries.length > 0,
    });
    this.logger.info({ jid: row.handle, tier: tierBadge(tier) }, "reply confidence");
    if (tier.tier === "LOW") {
      // Hold the draft and notify the owner. After the hold, send unless
      // the owner explicitly cancels via the dashboard.
      //
      // CONCURRENCY NOTE: this contact-reply path does NOT hold the
      // per-chat `busyChat` lock (that lock guards only the owner
      // doc-query / natural-chat paths), and handleInbound is dispatched
      // fire-and-forget from the poll loop — so this hold never blocks
      // polling or another chat. It DOES delay this contact's reply and
      // keeps the handler promise alive for the duration. 30s was an
      // eternity for the owner's perceived responsiveness; 5s still gives
      // a real cancel window (the owner sees the mirror email/dashboard
      // entry the instant the draft is held) without leaving the contact
      // hanging. There is exactly ONE send below, so no double-send risk.
      void this.mirrorToEmail(`🟡 LOW-confidence draft to ${this.contactNames.get(row.handle) || row.handle}\n\nThey: ${text.slice(0, 200)}\n\nDraft: ${draft.slice(0, 300)}\n\n(holding 5s before send — reply STOP via dashboard to cancel)`);
      await new Promise((r) => setTimeout(r, 5_000));
    }

    // Pace mirror — pause before the first send so the reply feels
    // natural for THIS contact's cadence. Reads REAL inbound→owner-reply
    // latency samples from chat.db (each row carries its true timestamp)
    // and applies a jittered, time-of-day-aware hold. `computeHoldFromSamples`
    // falls back to the safe moderate default when <3 usable samples
    // exist, so cold conversations stay sane without fabricated timings.
    let paceHoldMs = 0;
    let paceIsActiveBurst = false;
    let paceMsSinceLastInbound = 0;
    if (!isGroup) {
      const tsRows = this.db.recentTimestamped(row.chatRowid, 40);
      // Real (inboundTs, replyTs) pairs: each contact inbound paired with
      // the owner's next sent message in the thread.
      const samples: Array<{ inboundTs: number; replyTs: number }> = [];
      for (let i = 1; i < tsRows.length; i++) {
        const cur = tsRows[i];
        const prev = tsRows[i - 1];
        if (cur.fromMe && !prev.fromMe) {
          samples.push({ inboundTs: prev.ts, replyTs: cur.ts });
        }
      }
      // Liveness: how long since the most recent INBOUND, and whether we're
      // mid back-and-forth (2+ owner replies in the recent window).
      const lastInbound = [...tsRows].reverse().find((m) => !m.fromMe);
      paceMsSinceLastInbound = lastInbound
        ? Math.max(0, unixMs - lastInbound.ts)
        : 0;
      paceIsActiveBurst = tsRows.filter((m) => m.fromMe).length >= 2;
      const verdict = computeHoldFromSamples({
        samples,
        msSinceLastInbound: paceMsSinceLastInbound,
        isActiveBurst: paceIsActiveBurst,
        localHour: new Date().getHours(),
      });
      paceHoldMs = verdict.holdMs;
    }

    // Relay-promise truth-up: if the draft says "i'll let him know"
    // / "i'll alert" / "ok cheptha", actually fire the escalation so
    // the bot isn't lying. Side-effect approach: keep the message
    // promise, force the underlying action to be real.
    if (!isGroup) {
      const relayP = detectRelayPromise(draft);
      if (relayP) {
        this.logger.info(
          { from: row.handle, reason: relayP.reason, draftPreview: draft.slice(0, 120) },
          "RELAY-PROMISE detected (imessage) — firing owner escalation",
        );
        void this.fireOwnerEscalation({
          kind: "relay-promise",
          reason: relayP.reason,
          from: row.handle,
          senderName: this.contactNames.get(row.handle),
          contactText: text,
          botReplyPreview: draft,
        });
      }
    }

    // Naturalize + paced send. CRITICAL: for a group, send to the GROUP
    // chat identifier — never to the individual sender's handle, which
    // would DM them instead of posting in the group. (This is what
    // produced the "replied to a group with a DM" bug.)
    const sendTarget = isGroup && row.chatIdentifier ? row.chatIdentifier : row.handle;
    const burst = naturalize(draft, {
      inbound: text,
      style,
      // Pace hint: suppress the "I was away" lag mid-active-burst and let
      // short replies type faster when the contact is plainly live.
      pace: { isActiveBurst: paceIsActiveBurst, msSinceLastInbound: paceMsSinceLastInbound },
    });
    if (paceHoldMs > 0) await new Promise((r) => setTimeout(r, paceHoldMs));
    for (let i = 0; i < burst.length; i++) {
      const piece = burst[i];
      await new Promise((r) => setTimeout(r, piece.delayBeforeMs));
      await new Promise((r) => setTimeout(r, piece.typingMs));
      await this.send(sendTarget, piece.text);
      // Count once per burst for the morning digest.
      if (i === 0) this.repliesSentToday += 1;
    }
    // Anti-repetition ring buffer — remember what we just told this
    // contact so the next reply to them avoids the same phrasing.
    if (!isGroup) {
      const ring = this.recentBotReplies.get(row.handle) ?? [];
      ring.push(draft);
      if (ring.length > IMessageSession.RECENT_BOT_REPLIES_MAX) {
        ring.splice(0, ring.length - IMessageSession.RECENT_BOT_REPLIES_MAX);
      }
      this.recentBotReplies.set(row.handle, ring);
    }

    // MEDIUM-confidence audit ping — let owner know what just went
    // out so they can correct if needed.
    if (tier.tier === "MEDIUM" && !isGroup) {
      void this.mirrorToEmail(`🟡 MEDIUM-confidence reply sent to ${this.contactNames.get(row.handle) || row.handle}\n\nThey: ${text.slice(0, 200)}\n\nYou: ${draft.slice(0, 300)}`);
    }

    // Episodic memory — record this exchange so future replies have
    // structured callbacks. Fire-and-forget.
    if (!isGroup) {
      void maybeRecordEpisode({
        memory: this.episodicMemory,
        jid: row.handle,
        inbound: text,
        outbound: draft,
        // LLM fallback wired via agent.respondTo with empty system —
        // cheap one-shot call only when the rule extractor misses.
        llmCall: async (prompt) => {
          try {
            const out = await this.agent.respondTo(row.handle, prompt, "", { withTools: false });
            return out || "";
          } catch { return ""; }
        },
      });
    }

    // Unified cross-channel timeline — record this exchange against the
    // canonical person so it surfaces on every OTHER channel (WhatsApp,
    // SMS, voice, email) and so iMessage has long-term recall here. Owner
    // self-chat + groups never reach this point (owner returns earlier;
    // groups don't ingest), so this is 1:1 contact traffic only.
    // Best-effort + fire-and-forget; ingestEvent never throws and degrades
    // silently when the control-plane is unreachable.
    if (!isGroup) {
      void this.personal.ingestEvent("imessage", row.handle, "message_in", "in", text);
      void this.personal.ingestEvent("imessage", row.handle, "message_out", "out", draft);
    }

    // Social-graph index — tag THIS outbound so cross-contact
    // retrieval works going forward.
    if (!isGroup) {
      const outboundTopics = extractTopics(draft);
      if (outboundTopics.length > 0) {
        void this.socialGraph.record({
          jid: row.handle,
          contactName: this.contactNames.get(row.handle),
          text: draft.slice(0, 200),
          fromMe: true,
          topics: outboundTopics,
        });
      }
    }
  }

  // ---- Overnight replay queue -------------------------------------------
  //
  // Quiet-hours inbounds from 1:1 contacts are persisted here and replayed
  // through handleInbound when the window reopens, so a late-night message
  // gets a warm morning reply instead of being silently dropped. All ops
  // are best-effort (never throw into the poll loop) and the file is 0600
  // because it holds raw message text (PII).

  // Stable per-entry identity for dedup. GUID is the cleanest key; fall
  // back to (handle, rowid) when a row lacks one.
  private quietEntryKey(row: Pick<IMessageRow, "guid" | "handle" | "rowid">): string {
    return row.guid && row.guid.trim() ? `g:${row.guid}` : `r:${row.handle}:${row.rowid}`;
  }

  // Persist a single quiet-hours inbound (append-only JSONL). Stores the
  // minimal IMessageRow fields handleInbound needs plus arrival time.
  private enqueueQuietReplay(row: IMessageRow, unixMs: number): void {
    try {
      const key = this.quietEntryKey(row);
      // Already queued/replayed in this process — skip the disk write.
      if (this.quietReplayed.has(key)) return;
      // Bound the file: count lines cheaply; drop if at cap.
      if (existsSync(this.quietQueuePath)) {
        const lines = readFileSync(this.quietQueuePath, "utf8").split("\n").filter(Boolean);
        if (lines.length >= IMessageSession.QUIET_QUEUE_MAX) {
          this.logger.warn({ count: lines.length }, "quiet-queue at cap — dropping new overnight inbound");
          return;
        }
        // Dedup against what's already persisted (defends a restart that
        // re-sees the same chat.db row before the morning drain).
        for (const ln of lines) {
          try {
            const e = JSON.parse(ln) as { key?: string };
            if (e.key === key) return;
          } catch { /* skip malformed */ }
        }
      }
      const entry = {
        key,
        queuedAt: unixMs,
        // Minimal row snapshot — only the fields handleInbound reads.
        row: {
          rowid: row.rowid,
          text: row.text || "",
          date: row.date,
          isFromMe: false,
          handle: row.handle,
          guid: row.guid || "",
          chatDisplayName: row.chatDisplayName || "",
          chatIdentifier: row.chatIdentifier || "",
          service: row.service || "",
          chatRowid: row.chatRowid,
          hasAttachments: !!row.hasAttachments,
          associatedMessageType: 0,
          associatedMessageGuid: "",
        },
      };
      appendFileSync(this.quietQueuePath, JSON.stringify(entry) + "\n", { mode: 0o600 });
      // appendFileSync's mode only applies on create; enforce 0600 anyway.
      try { chmodSync(this.quietQueuePath, 0o600); } catch { /* best-effort */ }
      this.quietReplayed.add(key);
      this.logger.info({ handle: row.handle }, "queued overnight inbound for morning replay");
    } catch (err) {
      this.logger.warn({ err }, "enqueueQuietReplay failed (best-effort)");
    }
  }

  // Periodic check: when quiet hours have ENDED and the queue is
  // non-empty, drain it. Runs every minute; also safe to call ad-hoc.
  private startQuietReplay(): void {
    if (this.quietReplayTimer) return;
    this.quietReplayTimer = setInterval(() => {
      void this.drainQuietQueue().catch((err) =>
        this.logger.warn({ err }, "quiet-queue drain failed (best-effort)"),
      );
    }, 60_000);
    if (typeof this.quietReplayTimer.unref === "function") this.quietReplayTimer.unref();
    // Kick once shortly after boot in case we restarted post-window with a
    // queue already on disk (the late-night message survived the restart).
    setTimeout(() => {
      void this.drainQuietQueue().catch(() => {});
    }, 5_000);
  }

  // Drain the overnight queue: replay each entry through the normal reply
  // pipeline with morning pacing. No-op during quiet hours. Reentrancy-
  // guarded so the minute timer can't overlap a slow drain.
  private async drainQuietQueue(): Promise<void> {
    if (this.quietReplayInFlight) return;
    if (!this.quietQueuePath || !existsSync(this.quietQueuePath)) return;
    // Only replay OUTSIDE quiet hours — otherwise we'd reply at 3am.
    if (isQuietHours(new Date(), defaultQuietHours())) return;

    this.quietReplayInFlight = true;
    try {
      const raw = readFileSync(this.quietQueuePath, "utf8").split("\n").filter(Boolean);
      if (raw.length === 0) return;
      type Entry = { key: string; queuedAt: number; row: IMessageRow };
      const entries: Entry[] = [];
      const seen = new Set<string>();
      for (const ln of raw) {
        try {
          const e = JSON.parse(ln) as Entry;
          if (!e?.row?.handle || !e.key) continue;
          if (seen.has(e.key)) continue; // in-file dedup
          seen.add(e.key);
          entries.push(e);
        } catch { /* skip malformed line */ }
      }
      // Clear the file FIRST so a crash mid-drain doesn't double-reply.
      // Entries we skip (already-replied) are simply dropped — desired.
      try { writeFileSync(this.quietQueuePath, "", { mode: 0o600 }); } catch { /* best-effort */ }

      let replayed = 0;
      for (const e of entries) {
        // GUARD: contact already heard back since the message landed
        // (they re-texted and got a live reply, or owner replied
        // manually). Skip — no double-reply.
        if (this.contactRepliedSince(e.row.chatRowid, e.queuedAt)) {
          this.logger.info({ handle: e.row.handle }, "skip overnight replay — contact already answered");
          continue;
        }
        const row: IMessageRow = { ...e.row, isFromMe: false, associatedMessageType: 0 };
        const unixMs = appleNsToUnixMs(row.date) || e.queuedAt;
        try {
          // Replay through the normal pipeline. computeHoldFromSamples is
          // localHour-aware, so the morning hour gives a realistic
          // read-delay rather than an instant 6am burst.
          await this.handleInbound(row, unixMs, false);
          replayed += 1;
          // Small spacer between contacts so we don't fire a burst of
          // sends in the same second across several threads.
          await new Promise((r) => setTimeout(r, 1_500 + Math.round(Math.random() * 2_500)));
        } catch (err) {
          this.logger.warn({ err, handle: e.row.handle }, "overnight replay of one entry failed");
        }
      }
      if (replayed > 0) {
        this.logger.info({ count: replayed }, "overnight replay complete");
        this.broadcast({ type: "activity", data: { kind: "system", summary: `morning replay: answered ${replayed} overnight message(s)`, timestamp: Date.now() } });
      }
    } finally {
      this.quietReplayInFlight = false;
    }
  }

  // Did the owner send anything to this chat AFTER the given time? Used
  // to skip overnight replay when the conversation already moved on
  // (contact re-texted + got a live reply, or owner answered manually).
  private contactRepliedSince(chatRowid: number, sinceUnixMs: number): boolean {
    try {
      const ts = this.db.recentTimestamped(chatRowid, 20);
      return ts.some((m) => m.fromMe && m.ts > sinceUnixMs);
    } catch {
      return false;
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
      chatJid: jid,
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
          `• approval queue: ${this.draftApprovalsEnabled ? "on" : "off"}`,
          `• panic channels: ${this.escalationEnabled ? "on" : "off"} (pushover: ${this.pushoverEnabled ? "on" : "off"})`,
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
      setApprovals: async (enabled: boolean) => {
        this.draftApprovalsEnabled = enabled;
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: "system", summary: `approval queue ${enabled ? "ENABLED" : "DISABLED"}`, timestamp: Date.now() },
        });
      },
      listVips: async () => {
        try {
          const { authedFetch } = await import("@lantern/bridge-core/auth");
          const res = await authedFetch("/v1/whatsapp/vips");
          if (!res.ok) return `⚠️ couldn't fetch VIPs (HTTP ${res.status})`;
          const data = (await res.json()) as { vips?: Array<{ jid: string; displayName?: string }> };
          const vips = data.vips ?? [];
          if (vips.length === 0) return "📭 no VIPs.";
          return [
            `👑 VIPs (${vips.length}):`,
            ...vips.map((v) => `• ${v.displayName || v.jid.split("@")[0]}`),
            "",
            "tap ❤️ on a contact's message to add; 🗑 to remove.",
          ].join("\n");
        } catch (err) {
          this.logger.warn({ err }, "vip-list failed");
          return "⚠️ couldn't fetch VIPs (network error)";
        }
      },
      clearVips: async () => {
        try {
          const { authedFetch } = await import("@lantern/bridge-core/auth");
          const list = await authedFetch("/v1/whatsapp/vips");
          if (!list.ok) return 0;
          const data = (await list.json()) as { vips?: Array<{ jid: string }> };
          const vips = data.vips ?? [];
          let removed = 0;
          for (const v of vips) {
            const r = await authedFetch(`/v1/whatsapp/vips?jid=${encodeURIComponent(v.jid)}`, { method: "DELETE" });
            if (r.ok) removed++;
          }
          return removed;
        } catch (err) {
          this.logger.warn({ err }, "vip-clear failed");
          return 0;
        }
      },
      setEscalation: async (enabled: boolean) => {
        this.escalationEnabled = enabled;
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: "system", summary: `panic channels ${enabled ? "ENABLED" : "DISABLED"}`, timestamp: Date.now() },
        });
      },
      setPushover: async (enabled: boolean) => {
        this.pushoverEnabled = enabled;
        this.persist();
        this.broadcast({
          type: "activity",
          data: { kind: "system", summary: `pushover siren ${enabled ? "ENABLED" : "DISABLED"}`, timestamp: Date.now() },
        });
      },
      placeOutboundCall: async (req) => {
        // Wire to the orchestrator with iMessage's contact resolver
        // + ElevenLabs voice clone hook (when configured).
        return this.placeOutboundCallFromOwner(jid, req);
      },
    });
  }

  // Owner-issued outbound call. Resolves target → phone, classifies
  // risk tier, surfaces pre-flight summary, places call via Twilio.
  // Symmetric in shape to the WhatsApp bridge's implementation.
  private async placeOutboundCallFromOwner(
    jid: string,
    intent: { intent: "conference" | "voicemail" | "task"; target: string; message?: string; reason?: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { authedFetch } = await import("@lantern/bridge-core/auth");
      // Pull the Twilio "from" number from the connector config.
      const listRes = await authedFetch("/v1/connectors");
      if (!listRes.ok) return { ok: false, reason: "couldn't fetch connectors" };
      const installs = (await listRes.json()) as Array<{
        connectorId: string;
        config?: Record<string, unknown>;
      }>;
      const twilio = installs.find((i) => i.connectorId === "twilio");
      const twilioFrom = twilio?.config?.phoneNumber as string | undefined;
      if (!twilio || !twilioFrom) {
        return { ok: false, reason: "Twilio connector not installed — set up via dashboard /connectors → Twilio" };
      }
      const deps: OrchestratorDeps = {
        logger: this.logger as any,
        twilioFromNumber: twilioFrom,
        ownerPhone: process.env.LANTERN_OWNER_PHONE,
        // Show the owner's own (verified) number to contacts so they answer.
        callerId: process.env.LANTERN_VOICE_CALLER_ID || undefined,
        ownerName: process.env.LANTERN_OWNER_NAME || undefined,
        smsHeadsUp: (process.env.LANTERN_VOICE_SMS_HEADSUP || "on").toLowerCase() !== "off",
        resolveContact: async (nameOrNumber) => this.resolveCallTarget(nameOrNumber),
        authedFetch: authedFetch as any,
        notifyOwner: async (text) => { await this.send(jid, text); },
        cachePendingOffer: (offer) => {
          this.pendingOffers.set(jid, {
            kind: "outbound-call",
            callRequest: offer.payload,
            callPlan: offer.plan,
            issuedAt: offer.issuedAt,
          } as any);
        },
        renderVoice: this.makeVoiceRenderer(),
      };
      this.lastCallDeps = deps;
      const res = await executeOutboundCall(intent, deps, { ownerInitiated: true });
      return { ok: res.ok, reason: res.reason };
    } catch (err) {
      this.logger.error({ err }, "outbound call orchestrator failed");
      // Fixed friendly reason — never surface the raw error to chat
      // (the caller interpolates this into a user-facing line).
      return { ok: false, reason: "couldn't place the call — try again" };
    }
  }

  // Universal contact resolver: tries self-tokens ("me", "yourself"),
  // phone-number parsing, the bridge's chat.db contact cache, owner
  // profile relationships, and finally macOS Contacts.app via
  // AppleScript. On miss returns null + populates `lastSuggestions`
  // so the bridge can include "did you mean…" in the error reply.
  private lastResolveSuggestions: Array<{ name: string; phone?: string; relationship?: string }> = [];

  private async resolveCallTarget(input: string): Promise<{ phone: string; name?: string; relationship?: string } | null> {
    const result = await universalResolveContact(input, {
      ownerPhone: process.env.LANTERN_OWNER_PHONE,
      bridgeContactCache: this.contactNames,
      profileRelationships: this.ownerProfileStore.get()?.relationships,
      logger: this.logger as any,
    });
    this.lastResolveSuggestions = result.suggestions;
    if (!result.resolved) return null;
    return {
      phone: result.resolved.phone,
      name: result.resolved.name,
      relationship: result.resolved.relationship,
    };
  }

  /** Public accessor for the most recent resolve failure's hint
   *  candidates — bridge surfaces these in the error reply. */
  getLastResolveSuggestions(): string {
    return formatSuggestions(this.lastResolveSuggestions);
  }

  // Build the optional ElevenLabs voice-clone renderer. Returns a
  // function that takes text and produces a URL Twilio can <Play>,
  // OR null if ElevenLabs isn't configured (caller falls back to
  // inline Polly TwiML). The MP3 is served from the bridge's HTTP
  // server at /voice-cache/<sha1>.mp3 — Twilio fetches it when it
  // dials. (Requires LANTERN_VOICE_CACHE_PUBLIC_URL to be set to a
  // publicly-reachable host the bridge serves, e.g. via Cloudflare
  // Tunnel or ngrok.)
  private makeVoiceRenderer(): ((text: string) => Promise<string | null>) | undefined {
    const apiKey = process.env.LANTERN_ELEVENLABS_KEY;
    const voiceId = process.env.LANTERN_ELEVENLABS_VOICE_ID;
    const publicUrlBase = process.env.LANTERN_VOICE_CACHE_PUBLIC_URL;
    if (!apiKey || !voiceId || !publicUrlBase) return undefined;
    return async (text: string) => {
      try {
        const buf = await renderTextWithElevenLabs(text, { apiKey, voiceId });
        if (!buf) return null;
        // Write to disk + return URL. Caching by sha1 of text so
        // repeated phrases re-use the same audio (saves $).
        const { createHash } = await import("node:crypto");
        const { writeFile, mkdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const cacheDir = join(homedir(), ".lantern", "voice-cache");
        await mkdir(cacheDir, { recursive: true });
        const sha = createHash("sha1").update(text + voiceId).digest("hex");
        await writeFile(join(cacheDir, `${sha}.mp3`), buf);
        return `${publicUrlBase.replace(/\/$/, "")}/voice-cache/${sha}.mp3`;
      } catch (err) {
        this.logger.warn({ err }, "ElevenLabs render failed");
        return null;
      }
    };
  }

  // Execute a cached offer from humanize's detectOfferInReply.
  // Bypasses the LLM entirely for confirmations — deterministic.
  // Cached orchestrator deps from the most recent outbound-call setup.
  private lastCallDeps: any = null;

  // Sends a natural confirmation back to the chat.
  private async executeCachedOffer(jid: string, offer: PendingOffer): Promise<void> {
    // Outbound call — owner approved the pre-flight plan. Fire the
    // dialer directly via the cached orchestrator deps.
    if (offer.kind === "outbound-call" && (offer as any).callRequest && (offer as any).callPlan) {
      try {
        const { placeCallNow } = await import("@lantern/bridge-core/call-orchestrator");
        const deps = this.lastCallDeps;
        if (!deps) {
          await this.send(jid, "(can't place the call — orchestrator deps missing, ask me again)");
          return;
        }
        const res = await placeCallNow((offer as any).callRequest, (offer as any).callPlan, deps);
        if (!res.ok) {
          await this.send(jid, `(couldn't place call: ${res.reason || "unknown"})`);
        }
      } catch (err) {
        this.logger.error({ err }, "outbound-call offer execution failed");
        await this.send(jid, "(couldn't place the call — try again)");
      }
      return;
    }
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
    // Freeform follow-up: bot offered something arbitrary ("attach
    // the receipt email", "forward the link", etc.) and the owner
    // confirmed. We re-prompt the LLM with full context — original
    // inbound, the offer text, and an explicit instruction to
    // FULFILL the action (call tools, attach, etc.) rather than
    // re-offer it. Routes through the agentic pipeline so tools
    // are available.
    if (offer.kind === "freeform-followup" && offer.freeformAction) {
      this.logger.info(
        { jid, action: offer.freeformAction.slice(0, 80) },
        "executing freeform-followup — re-prompting LLM to fulfill",
      );
      const chatRowid = this.lastChatRowidForHandle.get(jid) || 0;
      // Construct a fulfillment prompt: tell the LLM the user just
      // approved the offer, supply the original turn's context, and
      // ask it to EXECUTE (not re-offer).
      const fulfillmentText = [
        `[CONFIRMED ACTION: ${offer.freeformAction}]`,
        offer.freeformInbound ? `Original ask: ${offer.freeformInbound}` : "",
        offer.freeformPriorReply ? `Your prior reply (containing the offer): ${offer.freeformPriorReply}` : "",
        "",
        `The owner just said YES to your offer. Now FULFILL it: call the right tool (gmail_search, calendar lookup, attach file, etc.) and deliver the result. Don't re-offer; don't ask for permission. Execute and reply with what you found / did. Output a normal-style reply, NOT a marker.`,
      ].filter(Boolean).join("\n");
      void this.handleOwnerDocQuery(jid, fulfillmentText, chatRowid).catch((err) =>
        this.logger.error({ err }, "handleOwnerDocQuery threw"),
      );
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
        // Read the Google Calendar connector + Gmail AND the local Apple
        // Calendar.app in parallel. The device calendar (iCloud/Apple/
        // subscribed) is where appointments the owner actually sees live — and
        // where the bridge writes events — so a query that only hit the Google
        // connector missed iCloud-only appointments entirely.
        const [block, appleEvents] = await Promise.all([
          prefetchAppointmentContext(client, text, this.logger),
          process.platform === "darwin"
            ? this.macActions
                .readUpcomingEvents({ days: 60 })
                .catch((err) => {
                  this.logger.warn({ err }, "apple calendar read failed (continuing)");
                  return [];
                })
            : Promise.resolve([]),
        ]);
        prefetchBlock = (block || "") + formatAppleCalendarBlock(appleEvents);
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
    const ownerFactsBlock = this.ownerProfileStore.factsBlock();
    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his iMessage self-chat.`,
      `Today is ${today}. Local time of day: ${timeOfDay}.`,
      ``,
      ownerProfileProse ? `# Who you are\n${ownerProfileProse}\n` : ``,
      ownerFactsBlock ? `${ownerFactsBlock}\n` : ``,
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
    if (arr.length > OWNER_SENT_DEPTH) arr.splice(0, arr.length - OWNER_SENT_DEPTH);
  }

  // COLD-START VOICE MINING. On boot, ownerSentHistory is only populated
  // from messages the owner types AFTER this process starts — so every
  // contact bucket is empty/thin until they happen to text, leaving the
  // bot with no voice samples to mimic. This pre-seeds each contact's
  // ring from the owner's OWN past sent messages (is_from_me=1, 1:1 only)
  // straight from chat.db.
  //
  // Best-effort by contract: runs once at startup, never blocks boot, and
  // never throws into the caller. Existing buckets (restored from disk)
  // take precedence — we only fill contacts we have no live signal for.
  // No message text is logged (PII); counts only.
  private seedOwnerVoiceFromHistory(): void {
    try {
      const mined = this.db.ownerSentByHandle({ perHandle: OWNER_SENT_DEPTH });
      let contactsSeeded = 0;
      let samplesSeeded = 0;
      for (const [handle, msgs] of mined) {
        // Don't clobber a bucket we already have (disk-restored or live).
        if ((this.ownerSentHistory.get(handle)?.length ?? 0) > 0) continue;
        const clean: string[] = [];
        for (const raw of msgs) {
          const text = raw.trim();
          // Skip the bridge's own past auto-replies — they're not the
          // owner's authentic voice and would poison the few-shot.
          if (!text || isBotSelfMessage(text)) continue;
          clean.push(text);
          if (clean.length >= OWNER_SENT_DEPTH) break;
        }
        if (clean.length === 0) continue;
        this.ownerSentHistory.set(handle, clean);
        contactsSeeded += 1;
        samplesSeeded += clean.length;
      }
      this.logger.info(
        { contactsSeeded, samplesSeeded },
        "seeded owner-voice samples from chat.db history",
      );
    } catch (err) {
      // Never let cold-start mining break the bridge.
      this.logger.warn({ err }, "owner-voice cold-start seeding failed (non-fatal)");
    }
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
  // Record meta of a bot reply so 👎 tapback can later look up what
  // we sent + why and re-prompt the LLM with a critique. Capped
  // FIFO at REPLY_META_MAX.
  private recordReplyMeta(
    sentGuid: string,
    meta: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string },
  ): void {
    if (!sentGuid) return;
    const stored = { ...meta, ts: Date.now() };
    this.bridgeReplyMeta.set(sentGuid, stored);
    // Mirror to the restart-surviving sidecar so a 👎 after a launchd
    // bounce can still find the anchor. Best-effort.
    this.persistReplyMeta(sentGuid, stored);
    if (this.bridgeReplyMeta.size > IMessageSession.REPLY_META_MAX) {
      const it = this.bridgeReplyMeta.keys();
      const drop = this.bridgeReplyMeta.size - IMessageSession.REPLY_META_MAX;
      for (let i = 0; i < drop; i++) {
        const k = it.next().value;
        if (k) this.bridgeReplyMeta.delete(k);
      }
    }
  }

  // Queue meta for a tracked reply send so 👎 self-eval can later
  // map the chat.db GUID → inbound + system hint + reply text. Two
  // storage layers, both consulted by harvestPendingReplyMeta:
  //
  //   1. PRIMARY — attach the meta to the matching entry in the
  //      per-chat `outboundEcho` FIFO. The harvest pops in send
  //      order, so meta moves to bridgeReplyMeta keyed by the
  //      correct GUID even when other empty-fromMe rows (thinking
  //      nudges, status acks) interleave.
  //
  //   2. FALLBACK — `pendingReplyMeta` text-keyed queue. Used when
  //      the outboundEcho path can't find a chatRowid (e.g.
  //      lastChatRowidForHandle hadn't been populated yet) or the
  //      text echoes through with chat.db populating the `text`
  //      column. Survives if the FIFO drained early.
  private queueReplyMeta(
    replyText: string,
    meta: { handle: string; chatRowid: number; inboundText: string; replyText: string; systemHint: string },
  ): void {
    if (!replyText) return;
    const norm = replyText.trim();

    // PRIMARY: attach meta to the most-recent outboundEcho entry
    // for this chat whose text matches. The entry was created by
    // `send(replyText)` immediately before this call, so it should
    // be at or near the tail of the FIFO.
    const q = this.outboundEcho.get(meta.chatRowid);
    if (q) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].text === replyText && !q[i].meta) {
          q[i].meta = meta;
          break;
        }
      }
    }

    // FALLBACK text-keyed queue. GC stale entries first
    // (>TTL old or duplicate of incoming text).
    const now = Date.now();
    this.pendingReplyMeta = this.pendingReplyMeta.filter((e) =>
      now - e.queuedAt < IMessageSession.PENDING_META_TTL_MS && e.text !== norm,
    );
    this.pendingReplyMeta.push({ text: norm, meta, queuedAt: now });
  }

  // Called from the fromMe-echo path. If a queued meta matches this
  // row, promote it into bridgeReplyMeta keyed by the row's GUID and
  // remove the matched entry from the queue. Returns true if a meta
  // was harvested (the caller treats that as "this fromMe row is our
  // own bridge send" and skips the rest of the owner-command handling).
  //
  // Modern macOS Messages stores AppleScript-sent message bodies in
  // the `attributedBody` BLOB and leaves the `text` column empty for
  // the SENDER's view of the chat. The tapback (👎) target GUID
  // points at THIS empty-text row, so we MUST register that GUID even
  // though we have no text to match on. Two-path strategy:
  //   1. Text match — works whenever chat.db populated `text`
  //      (often happens on cross-device echo / older macOS).
  //   2. Empty-text fallback — match by (chatRowid, recency). Pops
  //      the OLDEST pending entry for this chat queued in the last
  //      30s. This is the path that fixes the "👎 didn't work" bug.
  private harvestPendingReplyMeta(text: string, guid: string, chatRowid?: number): boolean {
    if (!guid) return false;
    const now = Date.now();
    // GC stale fallback queue entries.
    this.pendingReplyMeta = this.pendingReplyMeta.filter(
      (e) => now - e.queuedAt < IMessageSession.PENDING_META_TTL_MS,
    );

    const norm = (text || "").trim();

    // PRIMARY PATH — per-chat outbound-echo FIFO. Pop the next
    // expected echo for this chat. This is the ONLY path that
    // preserves send-order when we send multiple messages
    // back-to-back (e.g. "🧠 thinking…" then the actual reply):
    // pairing by text alone can't disambiguate empty-text rows,
    // and pairing by chat+age can pick the wrong one. The FIFO
    // does both correctly.
    if (chatRowid !== undefined) {
      const popped = this.popOutboundEcho(chatRowid);
      if (popped) {
        // Also drop the corresponding fallback queue entry by text
        // so the same meta can't be double-harvested later.
        if (popped.meta) {
          const fbIdx = this.pendingReplyMeta.findIndex(
            (e) => e.text === popped.text.trim(),
          );
          if (fbIdx !== -1) this.pendingReplyMeta.splice(fbIdx, 1);
          this.recordReplyMeta(guid, popped.meta);
          this.logger.debug(
            { guid, matchedBy: "fifo", replyLen: popped.text.length, sentText: popped.text.slice(0, 60) },
            "self-eval: harvested reply-meta for GUID",
          );
          return true;
        }
        // Popped a non-tracked send (thinking nudge, status ack,
        // etc.) — that's expected and consumes the echo without
        // touching bridgeReplyMeta.
        this.logger.debug(
          { guid, sentText: popped.text.slice(0, 60) },
          "self-eval: consumed untracked outbound echo from FIFO",
        );
        return false;
      }
    }

    // FALLBACK PATH 1 — text match against the pending queue.
    // Useful when chat.db populated the text column (older macOS
    // or cross-device echo views) and the FIFO had drained.
    if (norm) {
      const idx = this.pendingReplyMeta.findIndex((e) => e.text === norm);
      if (idx !== -1) {
        const entry = this.pendingReplyMeta[idx];
        this.pendingReplyMeta.splice(idx, 1);
        this.recordReplyMeta(guid, entry.meta);
        this.logger.debug(
          { guid, matchedBy: "text", replyLen: norm.length },
          "self-eval: harvested reply-meta for GUID",
        );
        return true;
      }
    }

    // FALLBACK PATH 2 — chat+recency text-queue lookup. Last
    // resort when both the FIFO and text match miss (e.g. the
    // bridge restarted between send + echo and the FIFO was lost
    // but the persistent fallback queue still has it — currently
    // it doesn't, but reserves the seam).
    if (chatRowid !== undefined) {
      const idx = this.pendingReplyMeta.findIndex(
        (e) => e.meta.chatRowid === chatRowid && now - e.queuedAt < IMessageSession.PENDING_META_TTL_MS,
      );
      if (idx !== -1) {
        const entry = this.pendingReplyMeta[idx];
        this.pendingReplyMeta.splice(idx, 1);
        this.recordReplyMeta(guid, entry.meta);
        this.logger.debug(
          { guid, matchedBy: "chat-time-fallback", replyLen: entry.text.length },
          "self-eval: harvested reply-meta for GUID",
        );
        return true;
      }
    }

    return false;
  }

  // SELF-EVAL retry: full critique-and-rewrite pipeline for iMessage.
  // Triggered when the owner taps 👎 (dislike, type 2002) on a bot
  // reply in their self-chat. Re-prompts the LLM with the original
  // inbound + prior reply + a critique instruction, sends the
  // corrected version as a follow-up. iMessage doesn't reliably
  // support editing arbitrary outbound, so we append rather than
  // replace.
  private async handleTapbackRetry(targetMsgGuid: string, recipientHandle: string): Promise<void> {
    // In-memory first; on a miss, consult the restart-surviving sidecar
    // (the entry may have fallen off the in-memory FIFO, or the bridge
    // bounced between send and the 👎). Only then give up.
    const meta = this.bridgeReplyMeta.get(targetMsgGuid) ?? this.lookupReplyMetaFromSidecar(targetMsgGuid);
    if (!meta) {
      this.logger.info({ targetMsgGuid }, "tapback-retry: no meta (probably aged out or non-tracked send)");
      // No meta — best-effort ack so the owner knows the signal landed.
      try { await this.send(recipientHandle, "noted — what was off?"); } catch {}
      return;
    }
    this.logger.info({ targetMsgGuid, inboundLen: meta.inboundText.length }, "self-eval: 👎 tapback → critique-retry");
    // Permanent calibration: record the (inbound, bad-reply) pair so
    // future replies to this contact AVOID the same shape. The good
    // reply (if the retry succeeds) is patched in below.
    void this.dislikeMemory.record({
      jid: meta.handle,
      inbound: meta.inboundText,
      badReply: meta.replyText,
      channel: "imessage",
    });

    try {
      const critiqueSystemHint = [
        meta.systemHint,
        "",
        "## CRITIQUE-AND-RETRY MODE — IMPORTANT",
        "The owner just tapped 👎 on your previous reply. The previous reply was BAD. Your job is to produce a STRUCTURALLY DIFFERENT, BETTER reply — NOT a cosmetic tweak.",
        "",
        "Step 1 (silent — do NOT include in output): diagnose the failure. The most common failures:",
        "  - TOO TERSE: returned just a name/word/emoji when the owner asked WHO/WHAT/WHY — a one-word answer to 'who is X' is almost always wrong; the owner wants context (relationship, age, role, recent event).",
        "  - DIDN'T USE PROFILE: you have full access to owner profile + relationships above (15+ contacts with roles, dates, family tree). The prior reply ignored them and just regurgitated the question token.",
        "  - WRONG TONE: sounded like a search result instead of a friend.",
        "  - INCOMPLETE: gave one fact when the question implied more (e.g. 'who is my son' → name AND relationship/age/most-recent context).",
        "",
        "Step 2: produce a single corrected reply that:",
        "  - Is at least 2× longer than the prior reply when the original was a 1-3 word answer (one-word retries are auto-rejected).",
        "  - Uses concrete context from the owner profile / relationships / recent messages — name + relationship + one specific detail (DOB, role, last interaction, current status).",
        "  - Speaks like a close friend who actually knows the owner's life, not a directory lookup.",
        "  - Matches the owner's language/script (e.g. if they use Telugu/Hindi mixed, reply in kind).",
        "",
        `Original inbound: ${meta.inboundText}`,
        `Your prior reply (rated bad — DO NOT REPEAT IT): ${meta.replyText}`,
        "",
        "Output ONLY the corrected reply text. No preface, no explanation, no markdown headers, no '[ATTACH:]' / '[NOTE:]' markers.",
      ].join("\n");

      const retried = await this.agent.respondTo(
        recipientHandle,
        meta.inboundText,
        critiqueSystemHint,
        { withTools: false }, // critique fixes style/clarity, not new tool calls
      );

      const trimmed = (retried || "").trim();
      // Reject degenerate retries: empty, emoji-only, or so short it
      // can't carry a real answer to the original inbound. LLMs
      // sometimes return just "🙂" or "ok" when stuck in critique
      // mode — that's strictly worse than the disliked reply.
      const hasWordChar = /[A-Za-z0-9ऀ-ॿ぀-ヿ一-鿿]/.test(trimmed);
      if (!trimmed || !hasWordChar || trimmed.length < 3) {
        this.logger.warn(
          { targetMsgGuid, retriedLen: trimmed.length, retried: trimmed.slice(0, 40) },
          "self-eval retry rejected — degenerate output (no word chars / too short)",
        );
        await this.send(
          recipientHandle,
          "(retry didn't produce a real fix — what was off about it?)",
        );
        return;
      }

      // Reject literal-no-change: if the retry is byte-equal to the
      // disliked reply, the critique loop produced nothing useful.
      if (trimmed === (meta.replyText || "").trim()) {
        this.logger.warn(
          { targetMsgGuid },
          "self-eval retry rejected — identical to original disliked reply",
        );
        await this.send(
          recipientHandle,
          "(same answer — need a hint on what was off)",
        );
        return;
      }

      // Reject low-effort expansion: the retry is supposed to be
      // structurally BETTER (add context, use profile, longer when
      // the original was terse). If the retry is just the original
      // with one extra token (e.g. "ved" → "ved mudarapu") and the
      // original was already a 1-3 word answer, the LLM didn't do
      // the work — fall back to a probe.
      const origWords = (meta.replyText || "").trim().split(/\s+/).filter(Boolean).length;
      const newWords = trimmed.split(/\s+/).filter(Boolean).length;
      if (origWords <= 3 && newWords <= origWords + 1 && trimmed.length < 30) {
        this.logger.warn(
          { targetMsgGuid, origWords, newWords, retried: trimmed },
          "self-eval retry rejected — low-effort expansion of terse original",
        );
        await this.send(
          recipientHandle,
          "(still too terse — what context were you looking for?)",
        );
        return;
      }

      await this.send(recipientHandle, trimmed);
      // Patch the dislike record with the accepted correction so
      // future prompts can show both shapes (BAD + GOOD) for
      // contextual calibration.
      void this.dislikeMemory.patchLastWithGood(meta.handle, trimmed);
      this.logger.info({ targetMsgGuid, retriedLen: trimmed.length }, "self-eval: retry delivered (imessage)");
    } catch (err) {
      this.logger.warn({ err, targetMsgGuid }, "self-eval retry exception (imessage)");
      try { await this.send(recipientHandle, "(retry hit an error — try again in a sec)"); } catch {}
    }
  }

  // Build the SubTaskAdapters map for multi-agent fan-out. Symmetric
  // to the WhatsApp bridge but routed inverse: iMessage adapters
  // hit the local chat.db directly; WhatsApp adapters proxy over
  // loopback to the WhatsApp bridge.
  private buildSubTaskAdapters(originalQuery: string): SubTaskAdapters {
    const tenantId = this.tenantId;
    const waBase = (process.env.LANTERN_WHATSAPP_BRIDGE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
    return {
      // iMessage adapters — direct chat.db access.
      imessageHistory: async (_instruction, hints) => {
        try {
          const hits = this.db.searchMessages({
            keyword: hints?.keyword || originalQuery,
            sinceMs: hints?.sinceMs,
            untilMs: hints?.untilMs,
            limit: 15,
          });
          if (hits.length === 0) return `(no iMessage matched "${hints?.keyword || originalQuery}")`;
          return hits.slice(0, 10).map((h) => {
            const when = new Date(h.unixMs).toISOString().slice(0, 10);
            const who = h.fromMe ? "you" : (this.contactNames.get(h.handle) || h.handle || "?");
            return `[${when}] ${who}: ${h.text.slice(0, 200)}`;
          }).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask imessage-history failed");
          return "(imessage-history unavailable)";
        }
      },
      imessageGroups: async () => {
        try {
          const groups = this.db.listGroups();
          if (groups.length === 0) return "(no iMessage groups)";
          return groups.slice(0, 12).map((g) => `${g.name} — ${g.participantCount} members`).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask imessage-groups failed");
          return "(imessage-groups unavailable)";
        }
      },
      // WhatsApp adapters — proxy to the WhatsApp bridge over loopback.
      whatsappHistory: async (_instruction, hints) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const body: Record<string, unknown> = { keyword: hints?.keyword || originalQuery, limit: 15 };
          if (typeof hints?.sinceMs === "number") body.sinceMs = hints.sinceMs;
          if (typeof hints?.untilMs === "number") body.untilMs = hints.untilMs;
          const res = await fetch(`${waBase}/session/${tenantId}/whatsapp/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (!res.ok) return `(WhatsApp bridge unreachable — HTTP ${res.status})`;
          const data = (await res.json()) as { results?: Array<{ ts: number; senderName: string; participant: string; text: string }> };
          const hits = data.results || [];
          if (hits.length === 0) return `(no WhatsApp matched "${hints?.keyword || originalQuery}")`;
          return hits.slice(0, 10).map((h) => {
            const when = new Date(h.ts).toISOString().slice(0, 10);
            const who = h.senderName || (h.participant || "").split("@")[0] || "?";
            return `[${when}] ${who}: ${h.text.slice(0, 200)}`;
          }).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask whatsapp-history failed");
          return "(whatsapp-history unavailable)";
        }
      },
      whatsappGroups: async () => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(`${waBase}/session/${tenantId}/whatsapp/groups`, { signal: ctrl.signal });
          clearTimeout(t);
          if (!res.ok) return `(WhatsApp groups list unreachable — HTTP ${res.status})`;
          const data = (await res.json()) as { groups?: Array<{ name: string; participants: number; monitored?: boolean }> };
          const groups = data.groups || [];
          if (groups.length === 0) return "(no WhatsApp groups)";
          return groups.slice(0, 12).map((g) => `${g.name} — ${g.participants} members${g.monitored ? " (monitored)" : ""}`).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask whatsapp-groups failed");
          return "(whatsapp-groups unavailable)";
        }
      },
      personalDocs: async (_instruction, hints) => {
        try {
          const hits = await this.docs.search(hints?.keyword || originalQuery);
          if (hits.length === 0) return `(no files matched "${hints?.keyword || originalQuery}")`;
          return hits.slice(0, 6).map((h) => `${h.displayPath} (${h.ext.replace(".", "")}, ${Math.round(h.bytes / 1024)}KB)`).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask personal-docs failed");
          return "(personal-docs unavailable)";
        }
      },
      ownerProfile: async () => {
        const prose = this.ownerProfileStore.prose();
        const rels = this.ownerProfileStore.relationshipsBlock();
        if (!prose && !rels) return "(no owner profile)";
        return [prose, rels].filter(Boolean).join("\n\n").slice(0, 1500);
      },
      gmail: async (_instruction, hints) => {
        try {
          const { defaultConnectorClient } = await import("@lantern/bridge-core/prefetch");
          const client = defaultConnectorClient(this.logger);
          const kw = hints?.keyword || originalQuery;
          const result = await client.execute("gmail", "search", { query: kw, limit: 8 })
            .catch((err) => {
              this.logger.warn({ err }, "subtask gmail search failed");
              return { ok: false, error: "unavailable" };
            });
          if (!result || (result as { ok?: boolean }).ok === false) {
            return "(gmail unavailable)";
          }
          const msgs = ((result as { messages?: Array<{ from?: string; subject?: string; snippet?: string }> }).messages || []).slice(0, 6);
          if (msgs.length === 0) return `(no gmail matched "${kw}")`;
          return msgs.map((m) => `from ${m.from || "?"} — ${m.subject || ""}${m.snippet ? ` — ${m.snippet.slice(0, 150)}` : ""}`).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask gmail adapter failed");
          return "(gmail unavailable)";
        }
      },
      googleCalendar: async (_instruction, hints) => {
        try {
          const { defaultConnectorClient } = await import("@lantern/bridge-core/prefetch");
          const client = defaultConnectorClient(this.logger);
          const params: Record<string, string | number> = { limit: 10 };
          if (typeof hints?.sinceMs === "number") params.timeMin = new Date(hints.sinceMs).toISOString();
          if (typeof hints?.untilMs === "number") params.timeMax = new Date(hints.untilMs).toISOString();
          const result = await client.execute("google-calendar", "list_events", params)
            .catch((err) => {
              this.logger.warn({ err }, "subtask calendar query failed");
              return { ok: false, error: "unavailable" };
            });
          if (!result || (result as { ok?: boolean }).ok === false) {
            return "(calendar unavailable)";
          }
          const events = ((result as { events?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }> }).events || []).slice(0, 8);
          if (events.length === 0) return `(no calendar events in range)`;
          return events.map((e) => `${e.start?.dateTime || e.start?.date || "?"}: ${e.summary || "(no title)"}`).join("\n");
        } catch (err) {
          this.logger.warn({ err }, "subtask calendar adapter failed");
          return "(calendar unavailable)";
        }
      },
    };
  }

  // Owner self-chat auto-profile-update hook. Inspects each self-chat
  // message for durable facts (locations, address-form preferences,
  // schedule updates, life events) and appends them to
  // ~/.lantern/owner-profile.md via the LLM-backed extractor in
  // bridge-core. Sends a one-line ack on successful save so the
  // owner sees what was learned.
  //
  // Fire-and-forget: never blocks the doc-query path.
  private async maybeAutoUpdateOwnerProfileFromSelfChat(
    jid: string,
    text: string,
  ): Promise<void> {
    try {
      const { maybeAutoUpdateOwnerProfile, formatAck } = await import(
        "@lantern/bridge-core/owner-profile-auto-update"
      );
      const result = await maybeAutoUpdateOwnerProfile(text, {
        profilePath: this.ownerProfileStore.getPath(),
        llmCall: async (prompt: string) => {
          // Cheapest model — the extractor is structured + tight.
          // Reuse the agent's completion path so we benefit from
          // the same failover + retry logic.
          //
          // CONCURRENCY: use a DISTINCT session key (suffix
          // "::profile-update") so this fire-and-forget background
          // extraction does NOT enter the same per-jid inflight chain
          // as the owner's foreground doc query. AgentClient.respondTo
          // serializes by key; sharing `jid` would make the user's
          // query wait behind this 1-3s extraction. A separate key
          // also keeps the extractor's structured prompt out of the
          // owner's conversational session history.
          const out = await this.agent.respondTo(`${jid}::profile-update`, prompt, "", { withTools: false });
          return out || "";
        },
        logger: this.logger as any,
        // Drop the cached profile the moment a fact/contact-rule is
        // written so taught facts + naming rules go live immediately
        // (next reply's factsBlock/addressRuleFor reflects them).
        invalidate: () => this.ownerProfileStore.invalidate(),
      });
      // Always try the mention-tagged episode capture, even when the
      // profile-update extractor said "nothing durable here". A
      // current-state ping like "Sujith reached home" is rarely a
      // profile fact but is critical context for the next inbound
      // from that person.
      await this.maybeRecordMentionEpisode(jid, text);
      if (result.appended.length === 0) return;
      // Cache invalidation is handled inside maybeAutoUpdateOwnerProfile
      // via the `invalidate` callback above, so taught facts go live the
      // instant they're written — no explicit invalidate needed here.
      const ack = formatAck(result.appended);
      if (ack) {
        await this.send(jid, ack);
      }
    } catch (err) {
      this.logger.warn({ err }, "owner-profile auto-update failed");
    }
  }

  // Cross-contact context capture from self-chat. Tag episodes with
  // the mentioned person's first name so the next inbound from them
  // surfaces it via forMentions().
  private async maybeRecordMentionEpisode(jid: string, text: string): Promise<void> {
    try {
      const { extractMentionEpisodeFromSelfChat } = await import(
        "@lantern/bridge-core/episodic-memory"
      );
      const knownNames = this.ownerProfileStore.knownFirstNames();
      const ep = extractMentionEpisodeFromSelfChat({
        selfJid: jid,
        text,
        knownNames,
      });
      if (!ep) return;
      await this.episodicMemory.record(ep);
      this.logger.info(
        { mentions: ep.mentions, topic: ep.topic },
        "mention-tagged episode recorded from self-chat",
      );
    } catch (err) {
      this.logger.warn({ err }, "mention-episode capture failed");
    }
  }

  private async handleOwnerDocQuery(
    jid: string,
    query: string,
    chatRowid: number = 0,
  ): Promise<void> {
    this.busyChat.add(jid);
    // Declared before the try so the finally can always clear it — a
    // throw must never leave a stray "🧠 thinking…" timer firing.
    let thinkingTimer: ReturnType<typeof setTimeout> | undefined;
    // The 3s non-chat dashboard heads-up timer — also cleared in finally.
    let thinkingBroadcastTimer: ReturnType<typeof setTimeout> | undefined;
    // CONCURRENCY (#7): release the per-chat busy lock + drain the queued
    // follow-up ONCE, as early as the reply is committed, so the next owner
    // query to this chat doesn't wait behind the slow side-effect tail
    // (attachment delivery, calendar/note/mail writes, outbound calls).
    // Idempotent via `busyReleased` — we call it both at the early point
    // (after the reply text + pendingOffers are committed, preserving
    // latest-wins offer ordering) AND in `finally` (covers the null-draft
    // early return and any throw before the early call). Draining only after
    // pendingOffers.set means a drained follow-up can't overwrite this
    // turn's offer with a staler one — the ordering hazard is closed.
    let busyReleased = false;
    const releaseBusyAndDrain = () => {
      if (busyReleased) return;
      busyReleased = true;
      this.busyChat.delete(jid);
      // Drain queued next-query (latest-wins). Only one at most; if older
      // than TTL we drop it (user has moved on). Fire-and-forget so we
      // don't bottleneck this run's tail.
      const queued = this.queuedQuery.get(jid);
      if (queued) {
        this.queuedQuery.delete(jid);
        const age = Date.now() - (queued.queuedAt as number);
        if (age < IMessageSession.QUEUED_QUERY_TTL_MS) {
          this.logger.info({ chat: jid, ageMs: age, textPreview: queued.text.slice(0, 60) }, "draining queued query");
          void this.handleOwnerDocQuery(jid, queued.text, this.lastChatRowidForHandle.get(jid) || 0).catch((err) =>
            this.logger.error({ err }, "handleOwnerDocQuery threw"),
          );
        } else {
          this.logger.info({ chat: jid, ageMs: age }, "dropping queued query — too old");
        }
      }
    };
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

    // LATENCY-FIRST UX (owner self-chat only — see handleOwnerDocQuery
    // gating):
    //   • No upfront ack — fast queries (<3s) land their answer with
    //     ZERO noise. The chat reads like a real person replying.
    //   • At >3s we emit a NON-CHAT "thinking" signal: a dashboard
    //     broadcast + log, NOT an iMessage bubble. A literal "🧠 thinking…"
    //     text on a 4-second wait clutters the owner's own thread and
    //     reads like a bot. (Sending a real tapback/reaction on the
    //     owner's message would be ideal but Messages.app has no reliable
    //     AppleScript path for it across macOS versions — so we stay quiet
    //     in-thread and surface the heads-up on the dashboard instead.)
    //   • Only when the work runs LONG (>15s) do we send ONE actual
    //     bubble so the owner knows it's alive. Never a second nudge.
    const startedAt = Date.now();
    let thinkingSent = false; // true once an actual bubble was sent (>15s)
    // 3s: quiet, non-chat heads-up on the dashboard.
    thinkingBroadcastTimer = setTimeout(() => {
      this.broadcast({
        type: "activity",
        data: {
          kind: "system",
          summary: "🧠 thinking… (working on owner query)",
          timestamp: Date.now(),
        },
      });
      this.logger.info({ elapsedMs: Date.now() - startedAt }, "owner query still working (3s) — dashboard heads-up, no chat bubble");
    }, 3000);
    if (typeof thinkingBroadcastTimer.unref === "function") thinkingBroadcastTimer.unref();
    // 15s: only NOW does a real iMessage bubble go out, for genuinely
    // long waits. thinkingTimer is the one cleared by the finally/catch.
    thinkingTimer = setTimeout(() => {
      thinkingSent = true;
      void this.send(jid, "🧠 thinking…");
    }, 15_000);

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

    // MULTI-AGENT PLAN — symmetric to the WhatsApp bridge. Planner
    // emits 2-5 sub-tasks; each runs in parallel against a source
    // adapter; results pack into a synthesis brief the lead LLM
    // weaves into ONE reply. Roster + appointment prefetches above
    // are kept (specialized formatting + pre-date the generic
    // planner); the planner picks up everything else (history
    // sweeps, doc + gmail correlations, calendar lookups).
    const plan = planSubTasks(query);
    const planAdapters = this.buildSubTaskAdapters(query);

    // SMART CONTEXT: read the device calendar (source of truth — iCloud +
    // Google + subscribed) when the query looks time-bound / availability /
    // appointment-y. Gated on the same intent detector as the heavier
    // Gmail/Google prefetch so a non-schedule query (e.g. "when is my green
    // card expiring") doesn't dump the whole calendar into the prompt and
    // bloat LLM context. The detector is broad ("when's my next haircut"
    // matches), so genuine schedule questions still get it.
    const wantsCalendar = looksLikeAppointmentQuery(query);
    const deviceCalP: Promise<CalendarEventRead[]> =
      wantsCalendar && process.platform === "darwin" && this.macActions
        ? this.macActions.readUpcomingEvents({ days: 60 }).catch((err) => {
            this.logger.warn({ err }, "device calendar read failed (continuing)");
            return [] as CalendarEventRead[];
          })
        : Promise.resolve([] as CalendarEventRead[]);
    const [gatedApptBlock, deviceEvents, rosterResults, subTaskResults] = await Promise.all([
      wantsCalendar
        ? prefetchAppointmentContext(client, query, this.logger).catch(() => null)
        : Promise.resolve(null),
      deviceCalP,
      rosterSignal.isRoster
        ? prefetchRoster(rosterSignal, rosterAdapters, { maxGroupsPerSurface: 3 }).catch(() => [])
        : Promise.resolve([]),
      plan.shouldDecompose
        ? executeSubTasks(plan.subTasks, planAdapters, { perTaskTimeoutMs: 8000 }).catch(() => [])
        : Promise.resolve([]),
    ]);
    const apptBlock = (((gatedApptBlock as string) || "") + formatAppleCalendarBlock(deviceEvents)) || null;
    const rosterBlock = formatRosterBlock(rosterSignal, rosterResults);
    const planBlock = formatSubTaskBriefs(query, subTaskResults);
    this.logger.info(
      {
        ms: Date.now() - startedAt,
        hasAppt: !!apptBlock,
        isRoster: rosterSignal.isRoster,
        rosterTokens: rosterSignal.tokens,
        rosterMatches: rosterResults.flatMap((r) => r.matches.map((m) => `${r.surface}:${m.groupName}`)),
        planDecompose: plan.shouldDecompose,
        planReason: plan.reasoning,
        subTaskOk: subTaskResults.filter((s) => s.ok).length,
        subTaskFail: subTaskResults.filter((s) => !s.ok).length,
        subTaskMs: subTaskResults.map((s) => `${s.source}:${s.durationMs}`).join(","),
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
    const ownerFactsBlock = this.ownerProfileStore.factsBlock();
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
      ownerFactsBlock ? `\n${ownerFactsBlock}` : "",
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
      "# Honesty about what you checked (HARD RULE — never give a false 'not found')",
      "  • Context blocks below (device calendar, roster, appointment sources) are COMPLETE and AUTHORITATIVE for what they cover — if the answer is in a present block, use it.",
      "  • The 'device calendar' block is the SOURCE OF TRUTH for appointments (iCloud + Google + subscribed). If it's present, trust it over Gmail/files for 'do I have an appointment'.",
      "  • You may ONLY say something doesn't exist ('no haircut appointment', 'no such event') if the AUTHORITATIVE source for it is present below AND empty of it. If that source is ABSENT (not loaded this turn), do NOT deny it exists — say you'll check / ask a clarifying question. A confident 'not found' when you didn't actually look is the worst failure.",
      "  • Prefer 'I don't see one on your calendar for the next N days' (scoped to what you checked) over a blanket 'you have no appointment'.",
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
      "  • Phone call:     [CALL:Manasa|conference|why you're calling]   (mode = conference | voicemail | task)",
      "CALLS: when the owner asks you to call / phone / dial / ring / conference / reach someone (ANY phrasing, any language, typos and all — e.g. 'call manu', 'conference me withe manu', 'can you ring her') you MUST emit a [CALL:...] marker. The bridge places the real call via Twilio and asks the owner to confirm before dialing. NEVER say 'I'll call' / 'calling her' / 'will do' WITHOUT the [CALL:...] marker — a reply that claims a call without the marker is a lie, because no call happens. 'conference me with X' → mode conference. 'leave X a voicemail saying Y' → mode voicemail, message Y. 'call the pharmacy to refill' → mode task. Use the contact's real name as target; the bridge resolves it to a number.",
      "  • Away status:    [STATUS:at the swimming pool|2026-06-02T19:30:00|swimming pool]   (label | until-ISO-or-empty | place)  ·  or  [STATUS:CLEAR]",
      "STATUS: when the owner tells you where they are or that they're away/busy/back (ANY phrasing or language — 'I am at the pool till 7:30pm est', 'in a meeting for 2h', 'driving', 'I'm back', Telugu, etc.), emit a [STATUS:...] marker. Compute the until-ISO from the time they gave (their local timezone; resolve 'till 7:30pm' to today's datetime). When they say they're back/free/available, emit [STATUS:CLEAR]. The bridge then tells anyone who messages — on EVERY channel — that the owner is at <place> and will get back, and offers to take a message. Confirm to the owner in your reply.",
      "OFFER-then-CONFIRM applies ONLY to state-modifying actions (calendar, note, mail, attach). For READ operations (search, list, look up, find), NEVER ask permission — just execute and report results. The user already asked; asking 'shall I search?' is wasted turns.",
      "# No-permission-to-read rule (HARD)",
      "When the user asks a question that needs data ('do you know my X', 'what is my X', 'find my X', 'when is my X', 'who is X', 'show me X'):",
      "  • DO NOT respond with 'want me to dig?' / 'should I search?' / 'do you want me to look up?' / 'shall I check?' — these are bot-tells that waste a turn.",
      "  • EXHAUST the tools FIRST, then answer. If the first sweep is empty, broaden: try synonyms (endoscopy → colonoscopy → GI → gastroenterology; address → lease, utility bill, tax return, bank statement, driver license), search older date ranges, check connector + personal-docs in parallel.",
      "  • Only after you've actually tried multiple angles do you say 'no clean hit on X — here's the closest I found' and stop. Never end with a 'want me to search more?' question.",
      "  • The ONE exception: a state-modifying follow-up ('saved to calendar?', 'want a reminder?') — that's allowed because it changes state.",
      "For ROSTER questions ('who came on X', 'who's in X'): the group rosters above are the truth. If members show as raw phone numbers (no name), their PARTICIPATION in the group already proves they were part of the trip/event. Answer with the FULL roster from the group; mention the unresolved ones as '+ N more (numbers only — names not in contacts yet)'. Do NOT ask the user if they want you to search further; if you can call search_whatsapp_history / search_imessage_history for the trip date range, JUST DO IT in this same turn.",
      apptBlock ? "\n" + apptBlock : "",
      rosterBlock ? "\n" + rosterBlock : "",
      planBlock ? "\n" + planBlock : "",
      // Screen-context (opt-in, off by default). Adds recent
      // foreground-app OCR snippets the user might be referring to.
      this.screenContext.recentContext() ? "\n" + this.screenContext.recentContext() : "",
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
    const { cleanedText: finalText, calendarEvents, notes, mailDrafts, calls, status } = extractActionMarkers(textNoAttach);
    // Presence/away status the LLM parsed (any phrasing/language). Shared file
    // → applies on all channels (incl. WhatsApp). Fast regex path handles
    // common cases before the LLM ever runs.
    if (status) {
      if (status.clear) {
        this.presence.clearOverride();
        this.logger.info({}, "presence cleared via [STATUS:CLEAR]");
      } else if (status.label) {
        const durationMs = status.untilIso ? Math.max(60_000, Date.parse(status.untilIso) - Date.now()) : undefined;
        this.presence.setStatus({ label: status.label, place: status.place, durationMs });
        this.logger.info({ label: status.label, untilIso: status.untilIso }, "presence set via [STATUS:]");
      }
    }

    // Humanize: friendly dates + guaranteed follow-up offer. The
    // returned `offer` lets us deterministically execute the action
    // on the next-turn confirmation — bypasses the LLM's tendency
    // to claim "already done" without emitting the marker.
    const { reply: polished, offer } = humanizeWithOffer(finalText);

    if (polished) {
      await this.send(jid, polished);
      // SELF-EVAL: queue meta so 👎 tapback on this reply can find
      // the inbound + system hint + reply text to re-prompt with.
      // The poll loop pairs this with the GUID on the echo poll.
      this.queueReplyMeta(polished, {
        handle: jid,
        chatRowid: effectiveChatRowid,
        inboundText: query,
        replyText: polished,
        systemHint,
      });
    }

    // Cache the offer keyed by chat so the followup ("yes") in the
    // same self-chat can find + execute it. Overwrites any prior
    // offer (we only care about the most recent one).
    if (offer && jid) {
      // For freeform-followups, attach the original inbound + the
      // bot's prior reply so the confirmation-execute path has full
      // context to re-prompt the LLM with.
      if (offer.kind === "freeform-followup") {
        offer.freeformInbound = query;
        offer.freeformPriorReply = polished;
      }
      this.pendingOffers.set(jid, offer);
    }

    // The user-facing reply + offer are now committed. Release the busy
    // lock + kick the queued-query drain HERE so the next owner query
    // proceeds in parallel with the (potentially slow) side-effect tail
    // below instead of serializing behind it. See releaseBusyAndDrain.
    releaseBusyAndDrain();

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
    // Outbound calls — LLM emitted a [CALL:...] marker. Route through the
    // real Twilio orchestrator (risk-tier → owner ack → dial). The
    // intelligent replacement for brittle "call X" regexes: the model
    // understands intent in any phrasing and only a marker places a call,
    // so it can't claim "i'll call her" without one actually happening.
    for (const c of calls) {
      try {
        this.logger.info({ target: c.target, mode: c.mode }, "LLM [CALL] marker → outbound orchestrator");
        const res = await this.placeOutboundCallFromOwner(jid, {
          intent: c.mode,
          target: c.target,
          message: c.message,
          reason: c.message,
        });
        if (!res.ok) {
          await this.send(jid, `(couldn't set up the call — ${res.reason || "unknown"})`);
        }
      } catch (err) {
        this.logger.warn({ err, target: c.target }, "outbound [CALL] marker exception");
        await this.send(jid, "(couldn't place the call — try again)");
      }
    }
    } catch (err) {
      // Crash-safety + no-leak: a throw anywhere above must never crash
      // the process or surface a raw error to chat. Log it and send a
      // graceful fallback (best-effort).
      this.logger.error({ err }, "owner doc query failed");
      try { await this.send(jid, "hmm, that one didn't go through — give me another minute and ask again"); } catch {}
    } finally {
      // Clear the thinking-timers here so a throw can't leave a stray
      // "🧠 thinking…" bubble or dashboard heads-up firing after the
      // query already finished/failed.
      clearTimeout(thinkingTimer);
      clearTimeout(thinkingBroadcastTimer);
      // Idempotent — no-op if the early release (after the reply was
      // committed) already ran; runs the release + drain for the
      // null-draft early return and any throw before that point.
      releaseBusyAndDrain();
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
  // Multi-channel owner escalation (iMessage bridge version).
  // Symmetric in intent to the WhatsApp bridge's. Fires:
  //   1. iMessage self-chat send (to LANTERN_IMESSAGE_OWNER_HANDLE)
  //   2. WhatsApp self-chat via the WA bridge's loopback
  //   3. Email via Gmail connector (skip-inbox=false so it's seen)
  //   4. macOS desktop notification (life-threat only)
  //   5. Outbound voice call via Twilio (life-threat only) — actually
  //      RINGS the owner's phone with a TwiML <Say>
  // All channels parallel + best-effort.
  private async fireOwnerEscalation(opts: {
    kind: "life-threat" | "prompt-injection" | "relay-promise";
    reason: string;
    from: string;
    senderName?: string;
    contactText: string;
    botReplyPreview?: string;
  }): Promise<void> {
    const who = opts.senderName || opts.from;
    const prefix =
      opts.kind === "life-threat" ? "🚨🚨 LIFE-THREAT ESCALATION" :
      opts.kind === "prompt-injection" ? "🛡 PROMPT-INJECTION (bot refused + paged you)" :
      "📨 bot promised to relay — here's what they said";
    const lines = [
      prefix,
      `from: ${who} (${opts.from})`,
      `signal: ${opts.reason}`,
      "",
      `they said:`,
      `"${opts.contactText.slice(0, 600)}"`,
    ];
    if (opts.botReplyPreview) {
      lines.push("");
      lines.push(`bot's reply (already sent):`);
      lines.push(`"${opts.botReplyPreview.slice(0, 400)}"`);
    }
    const body = lines.join("\n");

    // 1. iMessage self-chat send (primary on this bridge).
    const ownerSelf = (process.env.LANTERN_IMESSAGE_OWNER_HANDLE || "").trim();
    if (ownerSelf) {
      void this.send(ownerSelf, body).catch((err) =>
        this.logger.warn({ err }, "owner escalation: iMessage self-send failed"),
      );
    }

    // 2. WhatsApp loopback — secondary channel.
    const waUrl = process.env.LANTERN_WHATSAPP_BRIDGE_URL || "http://127.0.0.1:3100";
    const tenantId = process.env.LANTERN_DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
    void (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        await fetch(`${waUrl}/session/${tenantId}/send-self`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: body }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (err) {
        this.logger.debug({ err }, "owner escalation: WhatsApp loopback skipped");
      }
    })();

    // 3. Email via Gmail connector (inbox-grabbing, not skip-inbox).
    void (async () => {
      try {
        const ownerEmail = process.env.LANTERN_OWNER_EMAIL;
        if (!ownerEmail) return;
        const { authedFetch } = await import("@lantern/bridge-core/auth");
        const subject =
          opts.kind === "life-threat" ? `🚨 LIFE-THREAT alert from ${who}` :
          opts.kind === "prompt-injection" ? `🛡 prompt-injection probe from ${who}` :
          `📨 bot promised relay from ${who}`;
        await authedFetch("/v1/connectors/gmail/execute?action=send_message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: ownerEmail,
            subject,
            body,
            label: "lantern",
            skipInbox: false,
          }),
        });
      } catch (err) {
        this.logger.warn({ err, kind: opts.kind }, "owner escalation: email failed");
      }
    })();

    // Panic channels (macOS notif + voice + pushover) gated by the
    // master `escalationEnabled` toggle; primary alerts always fire.
    if (opts.kind === "life-threat" && this.escalationEnabled) {
      // 4. macOS desktop notification with sound.
      void (async () => {
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileP = promisify(execFile);
          const safeBody = body.replace(/"/g, '\\"').slice(0, 300);
          await execFileP(
            "osascript",
            ["-e", `display notification "${safeBody}" with title "🚨 Lantern: ${prefix}" sound name "Sosumi"`],
            { timeout: 2000 },
          );
        } catch (err) {
          this.logger.debug({ err }, "owner escalation: macOS notification skipped");
        }
      })();

      // 5. Twilio voice call to LANTERN_OWNER_PHONE.
      void (async () => {
        try {
          const ownerPhone = process.env.LANTERN_OWNER_PHONE;
          if (!ownerPhone) {
            this.logger.warn(
              "owner escalation: LANTERN_OWNER_PHONE not set — voice call skipped",
            );
            return;
          }
          const { authedFetch } = await import("@lantern/bridge-core/auth");
          const listRes = await authedFetch("/v1/connectors");
          if (!listRes.ok) return;
          const installs = (await listRes.json()) as Array<{ connectorId: string; config?: Record<string, unknown> }>;
          const twilio = installs.find((i) => i.connectorId === "twilio");
          const twilioFrom = twilio?.config?.phoneNumber as string | undefined;
          if (!twilio || !twilioFrom) {
            this.logger.warn("owner escalation: Twilio connector not configured — voice call skipped");
            return;
          }
          const senderLabel = (who || "").replace(/[^A-Za-z0-9\s]/g, " ").trim() || "an unknown contact";
          const safeMsg = opts.contactText.replace(/\s+/g, " ").slice(0, 400);
          const speech = `This is Lantern, an urgent alert. ${senderLabel} just messaged you saying: ${safeMsg}. They said it is an emergency. Please open your phone now.`;
          const callRes = await authedFetch(
            "/v1/connectors/twilio/execute?action=place_call",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                to: ownerPhone,
                from: twilioFrom,
                message: speech,
              }),
            },
          );
          if (!callRes.ok) {
            const errBody = await callRes.text();
            this.logger.error(
              { status: callRes.status, body: errBody.slice(0, 300) },
              "owner escalation: Twilio voice call FAILED (iMessage)",
            );
          } else {
            this.logger.info(
              { to: ownerPhone.slice(0, 6) + "***" },
              "owner escalation: Twilio voice call placed (iMessage)",
            );
          }
        } catch (err) {
          this.logger.error({ err }, "owner escalation: Twilio voice call exception (iMessage)");
        }
      })();

      // 6. PUSHOVER priority-2 alert — no-Twilio alternative that
      // still pierces iPhone silent + DND with a siren that repeats
      // until ack'd. Gated by the pushoverEnabled toggle too.
      void (async () => {
        try {
          if (!this.pushoverEnabled) return;
          const token = process.env.LANTERN_PUSHOVER_TOKEN;
          const user = process.env.LANTERN_PUSHOVER_USER;
          if (!token || !user) return;
          const senderLabel = (who || "").replace(/[^A-Za-z0-9\s]/g, " ").trim() || "an unknown contact";
          const msg = `${senderLabel} flagged an emergency. They said: "${opts.contactText.slice(0, 400)}"`;
          const formBody = new URLSearchParams({
            token,
            user,
            title: "🚨 LANTERN — life-threat alert",
            message: msg,
            priority: "2",
            retry: "30",
            expire: "3600",
            sound: "siren",
          });
          const res = await fetch("https://api.pushover.net/1/messages.json", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formBody.toString(),
          });
          if (!res.ok) {
            const txt = await res.text();
            this.logger.error(
              { status: res.status, body: txt.slice(0, 200) },
              "owner escalation: Pushover send FAILED (iMessage)",
            );
          } else {
            this.logger.info("owner escalation: Pushover priority-2 alert sent (iMessage)");
          }
        } catch (err) {
          this.logger.error({ err }, "owner escalation: Pushover exception (iMessage)");
        }
      })();
    }

    this.logger.info(
      { kind: opts.kind, reason: opts.reason, from: opts.from },
      "owner escalation fired (iMessage)",
    );
  }

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
        draftApprovalsEnabled: this.draftApprovalsEnabled,
        escalationEnabled: this.escalationEnabled,
        pushoverEnabled: this.pushoverEnabled,
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
      if (typeof data.draftApprovalsEnabled === "boolean") this.draftApprovalsEnabled = data.draftApprovalsEnabled;
      if (typeof data.escalationEnabled === "boolean") this.escalationEnabled = data.escalationEnabled;
      if (typeof data.pushoverEnabled === "boolean") this.pushoverEnabled = data.pushoverEnabled;
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
