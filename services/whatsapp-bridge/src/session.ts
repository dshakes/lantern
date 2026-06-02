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
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, appendFileSync, statSync } from "fs";
import type { Logger } from "pino";
import { AgentClient } from "@lantern/bridge-core/agent";
import { AttentionClassifier } from "./attention.js";
import { authedFetch } from "@lantern/bridge-core/auth";
import { MediaHandler } from "./media.js";
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
import { reactionToAction, dispatchReaction } from "@lantern/bridge-core/reaction-commands";
import { scheduleDigest, defaultDigestConfig } from "@lantern/bridge-core/daily-digest";
import { OfflineMonitor, defaultOfflineMonitorConfig } from "@lantern/bridge-core/offline-monitor";
import { EmailMirror } from "@lantern/bridge-core/email-mirror";
import {
  PersonalDocs,
  defaultPersonalDocsConfig,
  isTrivialChatter,
  isGreetingSmallTalk,
  extractAttachMarkers,
} from "@lantern/bridge-core/personal-docs";
import { isBotSelfMessage } from "@lantern/bridge-core/bot-self";
import { detectLanguageHints, languageModalityHint } from "@lantern/bridge-core/language";
import { looksLikeRosterQuery, prefetchRoster, formatRosterBlock, type RosterPrefetchAdapter } from "@lantern/bridge-core/roster";
import { planSubTasks, executeSubTasks, formatSubTaskBriefs, type SubTaskAdapters } from "@lantern/bridge-core/multi-agent";
import { MacActions, extractActionMarkers, formatAppleCalendarBlock, type CalendarEventRead } from "@lantern/bridge-core/mac-actions";
import { humanizeWithOffer, detectOfferInReply, looksLikeConfirmation, looksLikeRejection, type PendingOffer } from "@lantern/bridge-core/humanize";
import { defaultConnectorClient, prefetchAppointmentContext, looksLikeAppointmentQuery } from "@lantern/bridge-core/prefetch";
import { OwnerProfileStore } from "@lantern/bridge-core/owner-profile";
import { styleBlockFor } from "@lantern/bridge-core/per-contact-style";
import { DislikeMemory, formatDislikeBlock } from "@lantern/bridge-core/dislike-memory";
import { verifyClaims } from "@lantern/bridge-core/verifiable-claims";
import { PresenceTracker } from "@lantern/bridge-core/presence";
import { computeHold, latenciesFromTranscript } from "@lantern/bridge-core/pacing";
import { EpisodicMemory, formatEpisodesBlock, maybeRecordEpisode } from "@lantern/bridge-core/episodic-memory";
import { SocialGraph, extractTopics, formatRelatedBlock } from "@lantern/bridge-core/social-graph";
import { classifyConfidence, tierBadge } from "@lantern/bridge-core/confidence-tier";
import {
  detectLifeThreat,
  detectPromptInjection,
  detectRelayPromise,
  refusalReply as escalationRefusalReply,
} from "@lantern/bridge-core/escalation-detector";
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

  // Public accessor so the HTTP layer can proxy path-restricted
  // personal-docs search/read for the control-plane's LLM tools.
  // Returns null on darwin-non-Macs where docs wasn't initialized.
  getDocs(): PersonalDocs | null { return this.docs; }

  // Build the SubTaskAdapters map for multi-agent fan-out. Each
  // adapter is a small async closure that hits ONE data source and
  // returns a string brief. Run in parallel by executeSubTasks.
  // Adapters that are unavailable on this surface (e.g., iMessage
  // adapters when WhatsApp doesn't have iMessage's chat.db) are
  // proxied over loopback to the sister bridge.
  private buildSubTaskAdapters(originalQuery: string): SubTaskAdapters {
    const tenantId = this.tenantId;
    const imBase = (process.env.LANTERN_IMESSAGE_BRIDGE_URL || "http://127.0.0.1:3200").replace(/\/$/, "");
    return {
      whatsappHistory: async (instruction, hints) => {
        const hits = this.searchHistory({
          keyword: hints?.keyword || originalQuery,
          sinceMs: hints?.sinceMs,
          untilMs: hints?.untilMs,
          limit: 15,
        });
        if (hits.length === 0) return `(no WhatsApp messages matched "${hints?.keyword || originalQuery}")`;
        return hits.slice(0, 10).map((h) => {
          const when = new Date(h.ts).toISOString().slice(0, 10);
          const who = h.senderName || h.participant.split("@")[0] || "?";
          return `[${when}] ${who}: ${h.text.slice(0, 200)}`;
        }).join("\n");
      },
      whatsappGroups: async () => {
        const groups = await this.listGroups().catch(() => []);
        if (groups.length === 0) return "(no WhatsApp groups)";
        return groups.slice(0, 12).map((g) => `${g.name} — ${g.participants} members${g.monitored ? " (monitored)" : ""}`).join("\n");
      },
      imessageHistory: async (instruction, hints) => {
        // Proxy over loopback to the iMessage bridge — same as the
        // roster-prefetch adapter pattern.
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const body: Record<string, unknown> = { keyword: hints?.keyword || originalQuery, limit: 15 };
          if (typeof hints?.sinceMs === "number") body.sinceMs = hints.sinceMs;
          if (typeof hints?.untilMs === "number") body.untilMs = hints.untilMs;
          const res = await fetch(`${imBase}/session/${tenantId}/imessage/search`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          clearTimeout(t);
          if (!res.ok) return `(iMessage bridge unreachable — HTTP ${res.status})`;
          const data = (await res.json()) as { count?: number; results?: Array<{ ts: number; unixMs?: number; text: string; handle: string }> };
          const hits = data.results || [];
          if (hits.length === 0) return `(no iMessage matched "${hints?.keyword || originalQuery}")`;
          return hits.slice(0, 10).map((h) => {
            const when = new Date(h.unixMs || h.ts).toISOString().slice(0, 10);
            return `[${when}] ${h.handle || "?"}: ${h.text.slice(0, 200)}`;
          }).join("\n");
        } catch (err) {
          return `(iMessage bridge unreachable: ${(err as Error).message})`;
        }
      },
      personalDocs: async (instruction, hints) => {
        const docs = this.getDocs();
        if (!docs) return "(personal-docs unavailable)";
        try {
          const hits = await docs.search(hints?.keyword || originalQuery);
          if (hits.length === 0) return `(no files matched "${hints?.keyword || originalQuery}")`;
          return hits.slice(0, 6).map((h) => `${h.displayPath} (${h.ext.replace(".", "")}, ${Math.round(h.bytes / 1024)}KB)`).join("\n");
        } catch (err) {
          return `(personal-docs error: ${(err as Error).message})`;
        }
      },
      ownerProfile: async () => {
        const prose = this.ownerProfileStore.prose();
        const rels = this.ownerProfileStore.relationshipsBlock();
        if (!prose && !rels) return "(no owner profile)";
        return [prose, rels].filter(Boolean).join("\n\n").slice(0, 1500);
      },
      // Gmail / Calendar adapters delegate to the existing prefetch
      // helpers which already handle connector auth + rate limits.
      gmail: async (instruction, hints) => {
        try {
          const { defaultConnectorClient } = await import("@lantern/bridge-core/prefetch");
          const client = defaultConnectorClient(this.logger);
          const kw = hints?.keyword || originalQuery;
          const result = await client.execute("gmail", "search", { query: kw, limit: 8 })
            .catch((err) => ({ ok: false, error: err.message }));
          if (!result || (result as { ok?: boolean }).ok === false) {
            const errMsg = (result as { error?: string })?.error || "unknown";
            return `(gmail search failed: ${errMsg})`;
          }
          const msgs = ((result as { messages?: Array<{ from?: string; subject?: string; snippet?: string }> }).messages || []).slice(0, 6);
          if (msgs.length === 0) return `(no gmail matched "${kw}")`;
          return msgs.map((m) => `from ${m.from || "?"} — ${m.subject || ""}${m.snippet ? ` — ${m.snippet.slice(0, 150)}` : ""}`).join("\n");
        } catch (err) {
          return `(gmail adapter error: ${(err as Error).message})`;
        }
      },
      googleCalendar: async (instruction, hints) => {
        try {
          const { defaultConnectorClient } = await import("@lantern/bridge-core/prefetch");
          const client = defaultConnectorClient(this.logger);
          const params: Record<string, unknown> = { limit: 10 };
          if (typeof hints?.sinceMs === "number") params.timeMin = new Date(hints.sinceMs).toISOString();
          if (typeof hints?.untilMs === "number") params.timeMax = new Date(hints.untilMs).toISOString();
          const result = await client.execute("google-calendar", "list_events", params as Record<string, string | number>)
            .catch((err) => ({ ok: false, error: err.message }));
          if (!result || (result as { ok?: boolean }).ok === false) {
            const errMsg = (result as { error?: string })?.error || "unknown";
            return `(calendar query failed: ${errMsg})`;
          }
          const events = ((result as { events?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }> }).events || []).slice(0, 8);
          if (events.length === 0) return `(no calendar events in range)`;
          return events.map((e) => `${e.start?.dateTime || e.start?.date || "?"}: ${e.summary || "(no title)"}`).join("\n");
        } catch (err) {
          return `(calendar adapter error: ${(err as Error).message})`;
        }
      },
    };
  }

  // Outbound TTS via control-plane → OpenAI tts-1. Returns Buffer
  // (mp3 bytes) or null if disabled / errored. Called by the
  // owner-self-chat sender when LANTERN_VOICE_OUT=on and the reply
  // is short enough to make sense as a voice note.
  private async ttsAudio(text: string): Promise<Buffer | null> {
    if ((process.env.LANTERN_VOICE_OUT ?? "off").toLowerCase() !== "on") return null;
    const t = text.trim();
    if (!t || t.length > 1000) return null;
    try {
      const { authedFetch } = await import("@lantern/bridge-core/auth");
      const voice = process.env.LANTERN_VOICE_OUT_VOICE || "nova";
      const res = await authedFetch("/v1/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: t, voice, format: "mp3" }),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "tts: http error");
        return null;
      }
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    } catch (err) {
      this.logger.warn({ err }, "tts: exception");
      return null;
    }
  }

  // Send an audio voice note to self-chat. Used as the TTS delivery
  // path. Falls back to text-only when TTS fails.
  private async sendVoiceToSelf(text: string, audio: Buffer): Promise<void> {
    const own = this.ownJid();
    if (!own || !this.socket) return;
    try {
      // Baileys voice-note shape: audioMessage with ptt=true (push-to-
      // talk = renders as voice waveform on WhatsApp clients).
      const sent = await this.socket.sendMessage(own, {
        audio,
        mimetype: "audio/mp4",
        ptt: true,
      } as never);
      if (sent?.key?.id) {
        this.bridgeSentIds.set(sent.key.id, Date.now());
        this.lastSelfSentMsgId = sent.key.id;
      }
      this.logger.info({ bytes: audio.length, textLen: text.length }, "voice-out delivered");
    } catch (err) {
      this.logger.warn({ err }, "voice-out send failed");
    }
  }

  // JARVIS-ASK — synchronous single-turn endpoint for iOS Shortcut,
  // Siri, CLI, dashboard, voice-out. Runs the FULL owner-self-chat
  // pipeline (profile + tools + language modality) and returns the
  // bot's reply as a string. No message is sent on any surface; the
  // caller decides what to do with it (speak it, render it, etc.).
  // Throws if the LLM round-trip fails completely.
  async askJarvis(text: string): Promise<string> {
    const ownJid = this.ownJid() || "self";
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? "late night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "late night";
    const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];

    const langHint = detectLanguageHints(text);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    const ownerProfileProse = this.ownerProfileStore.prose();
    const relationshipsBlock = this.ownerProfileStore.relationshipsBlock();
    const systemHint = [
      `You are Lantern — ${ownerName}'s Jarvis, replying via voice/iOS shortcut. Answer is going to be SPOKEN aloud, so:`,
      `  • One short sentence is ideal. Two short sentences max.`,
      `  • No markdown, no bullet lists, no emoji. Just words.`,
      `  • Direct and confident. Don't hedge.`,
      `  • Conversational tone — sound like a person, not a chatbot.`,
      `Today is ${today}, ${timeOfDay}.`,
      ``,
      ownerProfileProse ? `# Who you are\n${ownerProfileProse}\n` : ``,
      relationshipsBlock ? `# Your people\n${relationshipsBlock}\n` : ``,
      `Use tools if needed for the answer — search_personal_files, gmail_search, calendar, etc. Don't ask permission for read operations; just execute and answer.`,
      languageModality,
    ].filter(Boolean).join("\n");

    const reply = await this.agent.respondTo(ownJid, text, systemHint, { withTools: true });
    return (reply || "").trim() || "i couldn't get an answer right now — try again";
  }

  // On-demand backfill for an already-paired session. Baileys only
  // delivers messaging-history.set automatically on FRESH pair — for an
  // established device we have to manually request older messages via
  // fetchMessageHistory(). This walks the JSONL, finds the oldest
  // known message for the target jid, and asks WhatsApp for `count`
  // messages older than that. Results stream back through the same
  // history-sync handler we already wired.
  //
  // Returns the request ID + the anchor it used. If no anchor exists
  // (we've never seen a message in that chat) returns null — the
  // caller should send at least one message in the chat OR request a
  // re-pair (which triggers the full automatic sync).
  async backfillGroup(opts: { jid: string; count?: number }): Promise<{
    requestId: string;
    anchorMsgId: string;
    anchorTs: number;
    requestedCount: number;
  } | null> {
    if (!this.socket) return null;
    const targetJid = opts.jid.trim();
    if (!targetJid) return null;
    const count = Math.min(Math.max(opts.count ?? 50, 1), 500);

    // Find the oldest msgId we have for this jid in the JSONL.
    let oldestEntry: { ts: number; msgId: string; fromMe: boolean; participant: string } | null = null;
    if (existsSync(this.historyFile)) {
      try {
        const raw = readFileSync(this.historyFile, "utf-8");
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as {
              ts?: number;
              jid?: string;
              msgId?: string;
              fromMe?: boolean;
              participant?: string;
            };
            if (e.jid !== targetJid || !e.msgId || typeof e.ts !== "number") continue;
            if (!oldestEntry || e.ts < oldestEntry.ts) {
              oldestEntry = { ts: e.ts, msgId: e.msgId, fromMe: !!e.fromMe, participant: e.participant || "" };
            }
          } catch { /* skip malformed */ }
        }
      } catch (err) {
        this.logger.warn({ err, targetJid }, "backfillGroup: failed reading JSONL");
      }
    }

    if (!oldestEntry) {
      this.logger.info({ targetJid }, "backfillGroup: no anchor message found — need at least one message in this chat first");
      return null;
    }

    try {
      const key = {
        remoteJid: targetJid,
        id: oldestEntry.msgId,
        fromMe: oldestEntry.fromMe,
        participant: oldestEntry.participant || undefined,
      };
      // tsRaw is Unix ms; Baileys wants seconds.
      const tsSeconds = Math.floor(oldestEntry.ts / 1000);
      const requestId = await this.socket.fetchMessageHistory(count, key, tsSeconds);
      this.logger.info(
        { targetJid, anchorMsgId: oldestEntry.msgId, anchorTs: oldestEntry.ts, count, requestId },
        "backfillGroup: fetchMessageHistory dispatched — results will arrive via messaging-history.set",
      );
      return {
        requestId: String(requestId),
        anchorMsgId: oldestEntry.msgId,
        anchorTs: oldestEntry.ts,
        requestedCount: count,
      };
    } catch (err) {
      this.logger.warn({ err, targetJid }, "backfillGroup: fetchMessageHistory failed");
      return null;
    }
  }

  // Build a JID → pushName map by scanning the wa-history JSONL.
  // Cached for 5 minutes — re-built lazily on next call. The most
  // RECENT non-empty senderName per JID wins (handles cases where
  // someone changes their WhatsApp display name).
  private historyNameCache: Map<string, string> | null = null;
  private historyNameCacheAt: number = 0;
  private static readonly HISTORY_NAME_TTL_MS = 5 * 60_000;
  private buildHistoryNameMap(): Map<string, string> {
    const now = Date.now();
    if (this.historyNameCache && now - this.historyNameCacheAt < WhatsAppSession.HISTORY_NAME_TTL_MS) {
      return this.historyNameCache;
    }
    const map = new Map<string, string>();
    if (this.historyFile && existsSync(this.historyFile)) {
      try {
        const raw = readFileSync(this.historyFile, "utf-8");
        // The JSONL stores per-message {jid, participant, senderName, ts}.
        // The KEY for individual-person resolution is `participant` in
        // groups (the actual sender JID) and `jid` in DMs.
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as {
              jid?: string;
              participant?: string;
              senderName?: string;
              isGroup?: boolean;
              fromMe?: boolean;
              ts?: number;
            };
            const name = (e.senderName || "").trim();
            if (!name) continue;
            // Skip outgoing messages — pushName there is OUR own name.
            if (e.fromMe) continue;
            // In groups the participant JID is the real sender; in DMs
            // the jid IS the sender.
            const personJid = e.isGroup ? (e.participant || "") : (e.jid || "");
            if (!personJid) continue;
            // Most-recent wins — JSONL is append-order so later entries
            // overwrite. (If we want strict latest-ts we'd need to sort
            // but order is good enough.)
            map.set(personJid, name);
          } catch { /* malformed */ }
        }
      } catch (err) {
        this.logger.warn({ err }, "buildHistoryNameMap: read failed");
      }
    }
    this.historyNameCache = map;
    this.historyNameCacheAt = now;
    this.logger.info({ size: map.size }, "buildHistoryNameMap: built");
    return map;
  }

  // Public surface for the dashboard / debugging — how many messages
  // are in the history log + dedup-set size + oldest/newest ts.
  historyStats(): {
    fileBytes: number;
    seenIds: number;
    oldestTs: number | null;
    newestTs: number | null;
    backfillEnabled: boolean;
  } {
    let fileBytes = 0;
    let oldestTs: number | null = null;
    let newestTs: number | null = null;
    try {
      if (this.historyFile && existsSync(this.historyFile)) {
        fileBytes = statSync(this.historyFile).size;
        // Read once to compute bounds. For a 50MB file that's ~50ms.
        const raw = readFileSync(this.historyFile, "utf-8");
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as { ts?: number };
            if (typeof e.ts === "number") {
              if (oldestTs === null || e.ts < oldestTs) oldestTs = e.ts;
              if (newestTs === null || e.ts > newestTs) newestTs = e.ts;
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* best-effort */ }
    return {
      fileBytes,
      seenIds: this.historySeenIds.size,
      oldestTs,
      newestTs,
      backfillEnabled: WhatsAppSession.HISTORY_BACKFILL_ENABLED,
    };
  }

  // Append one message to the per-tenant JSONL history log. Debounced
  // (1s) so a burst of inbound doesn't fsync per message.
  appendHistory(entry: {
    ts: number;
    jid: string;
    isGroup: boolean;
    fromMe: boolean;
    senderName: string;
    participant: string;
    text: string;
    msgId?: string;
  }): void {
    if (!this.historyFile) return;
    // De-dupe — same logical message from live + history paths.
    if (entry.msgId) {
      if (this.historySeenIds.has(entry.msgId)) return;
      this.historySeenIds.add(entry.msgId);
      // FIFO-ish eviction: when the set hits the cap, drop the first
      // 10% of insertion order. Set.iterator preserves insertion order
      // per the spec.
      if (this.historySeenIds.size > WhatsAppSession.HISTORY_DEDUP_MAX_IDS) {
        const drop = Math.floor(WhatsAppSession.HISTORY_DEDUP_MAX_IDS * 0.1);
        const it = this.historySeenIds.values();
        for (let i = 0; i < drop; i++) {
          const v = it.next().value;
          if (v) this.historySeenIds.delete(v);
        }
      }
    }
    try {
      this.historyAppendBuffer.push(JSON.stringify(entry));
      if (this.historyFlushTimer) return;
      this.historyFlushTimer = setTimeout(() => this.flushHistory(), 1000);
    } catch (err) {
      this.logger.warn({ err }, "history append failed");
    }
  }

  // Extract a single text body from a Baileys WAMessage, handling all
  // common message shapes (conversation, extendedText, image+caption,
  // video+caption, document+caption, etc.). Returns "" for media-only
  // or unsupported types — we don't try to OCR/transcribe in the
  // history backfill (live path already does that for incoming).
  private extractWAMessageText(msg: { message?: unknown }): string {
    if (!msg.message) return "";
    const m = msg.message as Record<string, { text?: string; caption?: string } | string | undefined>;
    const get = (k: string): string => {
      const v = m[k];
      if (!v) return "";
      if (typeof v === "string") return v;
      return v.text || v.caption || "";
    };
    return (
      get("conversation") ||
      get("extendedTextMessage") ||
      get("imageMessage") ||
      get("videoMessage") ||
      get("documentMessage") ||
      get("ephemeralMessage") ||
      ""
    ).trim();
  }

  // Hook the Baileys `messaging-history.set` event. WhatsApp delivers
  // server-synced history in batches after pair (and on later
  // re-syncs). Typical reach: ~14 days of history for a fresh device,
  // multiple batches per sync, isLatest=true on the final batch.
  //
  // Idempotent: appendHistory dedupes by msgId, so re-running the
  // backfill (after a reconnect) doesn't double-write. Non-blocking:
  // we don't await anything that could stall the bridge boot.
  // Persistent JID → name index. Populated from contacts.upsert /
  // contacts.update events Baileys fires on pair + when contacts
  // change. Survives restarts via the same JSONL pattern as wa-history.
  // The historyNameMap layers OVER this for group-roster resolution.
  private contactNamesFile: string = "";
  private contactNameBuffer: Array<{ jid: string; name: string }> = [];
  private contactNameFlushTimer: NodeJS.Timeout | null = null;

  private hookContactsSync(): void {
    if (!this.socket) return;
    this.contactNamesFile = join(this.authDir, "wa-contact-names.jsonl");

    // Pre-seed the in-memory contactNames Map from the persisted file
    // on every boot. Means a paired-once-then-restart bridge starts
    // with full name resolution from previous sessions' contacts events.
    try {
      if (existsSync(this.contactNamesFile)) {
        const raw = readFileSync(this.contactNamesFile, "utf-8");
        let n = 0;
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as { jid?: string; name?: string };
            if (e.jid && e.name) { this.contactNames.set(e.jid, e.name); n++; }
          } catch {}
        }
        this.logger.info({ loaded: n }, "wa-contact-names seeded from disk");
      }
    } catch (err) {
      this.logger.warn({ err }, "wa-contact-names seed failed");
    }

    const ingest = (contacts: Array<{ id?: string; name?: string; notify?: string; verifiedName?: string }>) => {
      for (const c of contacts) {
        const jid = c.id || "";
        // Names come in order of preference: explicit name > notify
        // (the pushName the contact set) > verifiedName (business).
        const name = (c.name || c.notify || c.verifiedName || "").trim();
        if (!jid || !name) continue;
        // Don't overwrite an existing better mapping with a worse one.
        const existing = this.contactNames.get(jid);
        if (existing && existing.length > 0 && existing === name) continue;
        this.contactNames.set(jid, name);
        this.contactNameBuffer.push({ jid, name });
      }
      if (this.contactNameBuffer.length > 0) this.scheduleContactNameFlush();
      // Invalidate the cached history-name map so the next group
      // members query sees the new names.
      this.historyNameCache = null;
    };

    this.socket.ev.on("contacts.upsert", (cs) => ingest(cs));
    this.socket.ev.on("contacts.update", (cs) => ingest(cs as Array<{ id?: string; name?: string; notify?: string; verifiedName?: string }>));
  }

  private scheduleContactNameFlush(): void {
    if (this.contactNameFlushTimer) return;
    this.contactNameFlushTimer = setTimeout(() => {
      this.contactNameFlushTimer = null;
      if (this.contactNameBuffer.length === 0) return;
      try {
        const batch = this.contactNameBuffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
        this.contactNameBuffer = [];
        appendFileSync(this.contactNamesFile, batch);
      } catch (err) {
        this.logger.warn({ err }, "wa-contact-names flush failed");
      }
    }, 2000);
  }

  private hookHistorySync(): void {
    if (!this.socket) return;
    if (!WhatsAppSession.HISTORY_BACKFILL_ENABLED) {
      this.logger.info({}, "WhatsApp history backfill disabled by LANTERN_WA_HISTORY_BACKFILL=off");
      return;
    }
    // Pre-seed historySeenIds from the existing JSONL so a restart
    // doesn't re-append everything that's already on disk. Cheap —
    // single pass, O(n) lines, ~50ms for 100k.
    try {
      if (existsSync(this.historyFile)) {
        const raw = readFileSync(this.historyFile, "utf-8");
        let seeded = 0;
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const e = JSON.parse(line) as { msgId?: string };
            if (e.msgId) {
              this.historySeenIds.add(e.msgId);
              seeded++;
              if (this.historySeenIds.size >= WhatsAppSession.HISTORY_DEDUP_MAX_IDS) break;
            }
          } catch { /* malformed line, skip */ }
        }
        this.logger.info({ seeded }, "WhatsApp history dedup seeded from JSONL");
      }
    } catch (err) {
      this.logger.warn({ err }, "WhatsApp history dedup seed failed (continuing)");
    }

    this.socket.ev.on("messaging-history.set", (h) => {
      const startedAt = Date.now();
      const messages = h.messages || [];
      let appended = 0;
      let skippedNoText = 0;
      let skippedBotSelf = 0;
      let skippedNoJid = 0;
      let skippedDuplicate = 0;
      const startSeen = this.historySeenIds.size;

      for (const msg of messages) {
        const jid = msg.key?.remoteJid || "";
        if (!jid) { skippedNoJid++; continue; }
        const text = this.extractWAMessageText(msg);
        if (!text) { skippedNoText++; continue; }
        if (isBotSelfMessage(text)) { skippedBotSelf++; continue; }
        const msgId = msg.key?.id || "";
        if (msgId && this.historySeenIds.has(msgId)) { skippedDuplicate++; continue; }
        // messageTimestamp is seconds (or a Long); coerce to Unix ms.
        const tsRaw = typeof msg.messageTimestamp === "number"
          ? msg.messageTimestamp
          : msg.messageTimestamp ? Number((msg.messageTimestamp as { toString(): string }).toString()) : 0;
        this.appendHistory({
          ts: tsRaw * 1000,
          jid,
          isGroup: this.isGroupJid(jid),
          fromMe: !!msg.key?.fromMe,
          senderName: msg.pushName || "",
          participant: msg.key?.participant || "",
          text,
          msgId,
        });
        appended++;
      }

      this.logger.info({
        syncType: h.syncType,
        isLatest: !!h.isLatest,
        progress: h.progress,
        batchSize: messages.length,
        appended,
        skippedNoText,
        skippedBotSelf,
        skippedNoJid,
        skippedDuplicate,
        seenIdsBefore: startSeen,
        seenIdsAfter: this.historySeenIds.size,
        durationMs: Date.now() - startedAt,
      }, "WhatsApp history backfill batch");

      this.broadcast({
        type: "activity",
        data: {
          kind: "system",
          summary: `📥 wa-history sync: +${appended} msgs${h.isLatest ? " (final)" : ""}`,
          detail: `syncType=${h.syncType} batch=${messages.length} dup=${skippedDuplicate}`,
          timestamp: Date.now(),
        },
      });
    });
  }

  private flushHistory(): void {
    this.historyFlushTimer = null;
    if (this.historyAppendBuffer.length === 0) return;
    try {
      // Use the already-imported fs module — this file is ESM, so
      // `require` is not defined. The `appendFileSync`/`statSync` etc.
      // names below come from the top-level `import { ... } from "fs"`
      // statements at the top of the file.
      const batch = this.historyAppendBuffer.join("\n") + "\n";
      this.historyAppendBuffer = [];
      appendFileSync(this.historyFile, batch);
      // Truncate on overflow — keep the most recent half.
      try {
        const st = statSync(this.historyFile);
        if (st.size > WhatsAppSession.HISTORY_MAX_BYTES) {
          const raw = readFileSync(this.historyFile, "utf-8");
          const lines = raw.split("\n");
          const kept = lines.slice(Math.floor(lines.length / 2)).join("\n");
          writeFileSync(this.historyFile, kept);
          this.logger.info({ before: st.size, after: kept.length }, "wa-history truncated");
        }
      } catch {}
    } catch (err) {
      this.logger.warn({ err }, "history flush failed");
    }
  }

  // Search the WhatsApp history log. Returns at most `limit` messages
  // (default 25, max 50) matching the filters. Sub-second on typical
  // ~MB history files because we stream + early-exit.
  searchHistory(opts: {
    keyword?: string;
    sinceMs?: number;
    untilMs?: number;
    jid?: string;
    groupOnly?: boolean;
    fromContact?: string; // case-insensitive substring on senderName
    limit?: number;
  }): Array<{
    ts: number;
    jid: string;
    isGroup: boolean;
    fromMe: boolean;
    senderName: string;
    participant: string;
    text: string;
  }> {
    if (!this.historyFile) return [];
    // Flush pending writes so a query immediately after sending
    // includes the just-arrived message.
    if (this.historyFlushTimer) {
      clearTimeout(this.historyFlushTimer);
      this.flushHistory();
    }
    if (!existsSync(this.historyFile)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.historyFile, "utf-8");
    } catch (err) {
      this.logger.warn({ err }, "history read failed");
      return [];
    }
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const kw = (opts.keyword || "").trim().toLowerCase();
    const fromContact = (opts.fromContact || "").trim().toLowerCase();
    const since = typeof opts.sinceMs === "number" ? opts.sinceMs : -Infinity;
    const until = typeof opts.untilMs === "number" ? opts.untilMs : Infinity;
    const out: Array<{ ts: number; jid: string; isGroup: boolean; fromMe: boolean; senderName: string; participant: string; text: string }> = [];
    // Walk newest first by parsing lines in reverse.
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let e: { ts?: number; jid?: string; isGroup?: boolean; fromMe?: boolean; senderName?: string; participant?: string; text?: string };
      try { e = JSON.parse(line); } catch { continue; }
      if (typeof e.ts !== "number" || typeof e.text !== "string") continue;
      if (e.ts < since || e.ts > until) continue;
      if (opts.jid && e.jid !== opts.jid) continue;
      if (opts.groupOnly && !e.isGroup) continue;
      if (kw && !e.text.toLowerCase().includes(kw)) continue;
      if (fromContact && !(e.senderName || "").toLowerCase().includes(fromContact)) continue;
      out.push({
        ts: e.ts,
        jid: e.jid || "",
        isGroup: !!e.isGroup,
        fromMe: !!e.fromMe,
        senderName: e.senderName || "",
        participant: e.participant || "",
        text: e.text,
      });
      if (out.length >= limit) break;
    }
    return out;
  }
  private macActions: MacActions | null = null;
  // Per-chat cache of the most recent offer (humanize follow-up).
  // On next-turn "yes" we execute it deterministically — bypasses
  // LLM hallucination where it claims an action happened without
  // emitting a marker.
  private pendingOffers: Map<string, PendingOffer> = new Map();
  private static readonly OFFER_TTL_MS = 10 * 60_000;
  // Per-chat concurrency lock. A single doc / natural-chat
  // round-trip can take 60+ seconds. Without this lock, rapid-fire
  // messages spawn parallel pipelines that all reply minutes later.
  // Acquired on owner-query handler entry, released in `finally`.
  private busyChat: Set<string> = new Set();

  // Latest-wins queue (mirrors iMessage bridge). When a user fires
  // multiple substantive queries while the bot is mid-OCR or mid-tool
  // call, hold only the most recent one and process it as soon as
  // the current run finishes.
  private queuedQuery: Map<string, { text: string; queuedAt: number }> = new Map();
  private static readonly QUEUED_QUERY_TTL_MS = 5 * 60_000;

  // Persistent message-history ring (per tenant). Every real text
  // message (inbound + outbound, individual + group) is appended as
  // one JSONL line so the LLM tool `search_whatsapp_history` can
  // answer cross-source questions. Cap by file size: when it crosses
  // HISTORY_MAX_BYTES we truncate the older half.
  //
  // Two sources feed the log:
  //   1. LIVE messages.upsert (real-time, ~1s flush debounce).
  //   2. messaging-history.set BACKFILL on pair + subsequent syncs
  //      (Baileys delivers WhatsApp's server-side history, typically
  //      the last ~14 days, in batches of up to ~5000 messages each).
  // Both paths share appendHistory() + dedupe by message GUID so a
  // live message that's then replayed via history sync isn't double-
  // logged.
  private static readonly HISTORY_MAX_BYTES =
    Number(process.env.LANTERN_WA_HISTORY_MAX_BYTES) > 0
      ? Number(process.env.LANTERN_WA_HISTORY_MAX_BYTES)
      : 50 * 1024 * 1024; // 50MB (history sync can push 10s of MB)
  private historyFile: string = "";
  private historyAppendBuffer: string[] = [];
  private historyFlushTimer: NodeJS.Timeout | null = null;

  // De-dupe set for the history pipeline. Keyed by Baileys message
  // key.id (globally unique per chat-message). Survives within-
  // process but resets on restart — that's OK because the JSONL is
  // re-scanned on load to seed it. Cap at HISTORY_DEDUP_MAX_IDS;
  // FIFO eviction past that (oldest IDs are least likely to be
  // re-seen anyway because WhatsApp's history sync only goes ~weeks
  // back).
  private static readonly HISTORY_DEDUP_MAX_IDS = 200_000;
  private historySeenIds: Set<string> = new Set();

  // Auto-backfill bookkeeping: per-jid one-time attempt flag so a
  // group with sparse history gets ONE automatic fetchMessageHistory
  // shortly after its first live message arrives. Without this, the
  // user would have to manually trigger backfill (or wait for the
  // group to accumulate messages organically) before old-history
  // searches yield anything.
  private autoBackfillAttempted: Set<string> = new Set();
  private static readonly AUTO_BACKFILL_DELAY_MS = 5_000;
  private static readonly AUTO_BACKFILL_COUNT = 200;

  // History backfill on/off. Default on. Set
  // LANTERN_WA_HISTORY_BACKFILL=off if a host is memory-constrained
  // or doesn't want the JSONL to grow.
  private static readonly HISTORY_BACKFILL_ENABLED =
    (process.env.LANTERN_WA_HISTORY_BACKFILL ?? "on").toLowerCase() !== "off";
  private attention: AttentionClassifier;
  private media: MediaHandler;
  private personal: PersonalClient;
  private calendar: CalendarLookup;
  private ownerProfileStore: OwnerProfileStore;
  private dislikeMemory: DislikeMemory;
  private presence: PresenceTracker;
  private episodicMemory: EpisodicMemory;
  private socialGraph: SocialGraph;
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
  // Conflict recovery backoff. A "conflict: replaced" (440) means another
  // WhatsApp Web session took our slot. Rather than dying permanently
  // (which left the bridge DOWN), we auto-reconnect with growing backoff:
  // a TRANSIENT conflict (e.g. a brief double-instance) recovers in ~60s;
  // a PERSISTENT one (owner genuinely has WhatsApp Web open elsewhere)
  // retries quietly every few minutes and recovers the instant that other
  // session closes. Capped so we never storm. Reset on a clean connect.
  private conflictBackoffMs = 60_000;
  private static readonly CONFLICT_BACKOFF_MAX_MS = 300_000;
  // Conflict-storm watchdog. A single transient 440 is fine (stray double
  // instance, recovers in ~60s). But SUSTAINED conflicts mean a second
  // long-lived bridge genuinely owns this WhatsApp slot — fighting it
  // forever just flaps the connection every 60s and drops inbound messages.
  // After CONFLICT_STORM_THRESHOLD conflicts within CONFLICT_STORM_WINDOW_MS
  // we go dormant (stop reconnecting) so the OTHER instance can hold the slot
  // cleanly. The owner recovers with POST /start once the duplicate is gone.
  private conflictStormCount = 0;
  private conflictStormStartedAt = 0;
  private conflictDormant = false;
  private static readonly CONFLICT_STORM_THRESHOLD = 5;
  private static readonly CONFLICT_STORM_WINDOW_MS = 360_000; // 6 min
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
  // Draft-approval queue toggle. When OFF (default), VIPs stay silent
  // and unfamiliar contacts auto-reply. When ON, both queue a draft
  // for owner approval via the dashboard. Seeded from env var
  // LANTERN_DRAFT_APPROVALS on first boot; once persisted in
  // agent_state.json, the saved value wins so phone commands stick.
  // Toggle from self-chat: "approvals on" / "approvals off" /
  // /lantern approvals on|off.
  private draftApprovalsEnabled =
    (process.env.LANTERN_DRAFT_APPROVALS || "").toLowerCase() === "on";
  // Master switch for the panic channels on life-threat escalation
  // (Pushover siren + Twilio voice call + macOS notification).
  // Default ON — life-threat is the one event class where the
  // default MUST be "fire". Primary alerts (WA self / iMessage self /
  // email) always fire regardless of this flag.
  private escalationEnabled = true;
  // Just the Pushover siren channel toggle. Inside escalationEnabled
  // so turning the master off also turns this off; setting this off
  // while master stays on just mutes Pushover.
  private pushoverEnabled = true;
  // Anti-weaponization: dedup/cooldown for owner escalations. A hostile
  // inbound that trips the regex (or quoted text) must not be able to
  // spam the owner with calls + sirens. Keyed by `${kind}:${jid}:${reason}`
  // → last-fired epoch ms. Duplicate escalations inside the window are
  // suppressed (logged, not sent). Real emergencies re-firing within 90s
  // are the same incident — suppressing the dupes is correct.
  private escalationLastFired = new Map<string, number>();
  private static readonly ESCALATION_COOLDOWN_MS = 90_000;
  private stateFile: string;
  // Opted-in group JIDs. Groups not in this set are ignored entirely; in
  // opted-in groups the agent runs the attention classifier on every message
  // and auto-replies only when the owner is @mentioned or quoted.
  private monitoredGroups: Set<string> = new Set();
  // 1:1 JIDs the owner has explicitly opted in for auto-reply. Empty =
  // bot stays silent to everyone but the owner. Same model as the
  // iMessage bridge's enabledContacts.
  private enabledContacts: Set<string> = new Set();
  // msg.key.id -> epoch_ms when the id was added. We suppress the echo that
  // comes back through messages.upsert (fromMe=true) for messages we sent
  // from the bridge. Stored with a timestamp so we can GC entries whose
  // echo never arrived — otherwise this Set would grow forever.
  private bridgeSentIds: Map<string, number> = new Map();
  private static readonly BRIDGE_SENT_TTL_MS = 5 * 60_000;
  // jid -> epoch_ms of last live/static-location ack. Live locations
  // re-emit on every coordinate update (every few seconds while
  // sharing), so we ack the FIRST share per jid and stay silent for
  // every subsequent update. TTL is generous so a re-share an hour
  // later still gets acked.
  private lastLocationAckAt: Map<string, number> = new Map();
  private static readonly LOCATION_ACK_TTL_MS = 60 * 60_000;

  // SELF-EVAL — per-msgId record of WHAT we sent + WHY. Lets the
  // critique-retry handler reconstruct the prompt when the owner
  // reacts with 🔁 / 🤦 on a bot reply. Capped at 200 entries (FIFO);
  // older entries fall off as new replies are recorded. In-memory
  // only — retries lose their anchor if the bridge restarts between
  // send and react, which is fine (the owner can re-send their query).
  private bridgeReplyMeta: Map<string, {
    jid: string;
    inboundText: string;
    replyText: string;
    systemHint: string;
    surface: "contact-reply" | "owner-self-chat";
    ts: number;
  }> = new Map();
  private static readonly REPLY_META_MAX = 200;
  // Tracks the msg.id of the most recent message confirmToSelf() sent.
  // Owner-self-chat reply paths read this immediately after their
  // confirmToSelf() call to pair the sent id with the inbound text +
  // system hint (so 🔁 can later look it up).
  private lastSelfSentMsgId: string = "";
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
    this.historyFile = join(this.authDir, "wa-history.jsonl");
    this.agent = new AgentClient(this.logger, {
      agentName: process.env.LANTERN_AGENT_NAME || "whatsapp-assistant",
      sessionsFile: join(this.authDir, "agent_sessions.json"),
    });
    this.attention = new AttentionClassifier(this.logger);
    this.media = new MediaHandler(this.logger);
    this.personal = new PersonalClient(this.logger);
    this.calendar = new CalendarLookup(this.logger);
    this.ownerProfileStore = new OwnerProfileStore(this.logger);
    this.dislikeMemory = new DislikeMemory({ logger: this.logger });
    this.presence = new PresenceTracker({ logger: this.logger });
    this.episodicMemory = new EpisodicMemory({ logger: this.logger });
    this.socialGraph = new SocialGraph({ logger: this.logger });
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
    // A manual start() is the recovery path out of conflict dormancy:
    // clear the storm so we genuinely re-attempt instead of immediately
    // re-dormant. (Reconnect-timer-driven starts never reach here while
    // dormant because we cancel the timer when going dormant.)
    this.conflictDormant = false;
    this.conflictStormCount = 0;
    this.conflictStormStartedAt = 0;
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
        let remoteJid = "";
        try {
          const m = (typeof obj === "object" && obj && (obj as { msg?: string }).msg) || msg || "";
          probe = String(m);
          // Stringify is best-effort — Baileys logs can contain
          // Buffers/circular refs that throw. Failure here MUST NOT
          // break logging.
          probe += " " + JSON.stringify(obj, (_k, v) => (v instanceof Error ? v.message : v));
          // Grab the offending remoteJid so we can targeted-bootstrap
          // the session via assertSessions(jid, force=true). Pattern
          // matches both libsignal error envelopes + Baileys' own
          // shape (key.remoteJid).
          const m2 = probe.match(/"remoteJid"\s*:\s*"([^"]+)"/);
          if (m2) remoteJid = m2[1];
        } catch {
          // Probe falls back to just the msg string
        }
        if (/failed to decrypt message|No session record|No matching sessions|MessageCounterError|Bad MAC/i.test(probe)) {
          this.noteDecryptError(remoteJid);
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
        // Ask WhatsApp for the FULL history sync on initial pair (rather
        // than the trimmed default of ~3 days). This is what makes
        // `search_whatsapp_history` actually useful for past questions
        // like "what did the family group say during my Turkey trip".
        // Disabled when LANTERN_WA_HISTORY_BACKFILL=off.
        syncFullHistory: WhatsAppSession.HISTORY_BACKFILL_ENABLED,
        // Accept every history message regardless of type. Default
        // returns false for ephemeral/protocol messages; we want
        // everything text-bearing for the search index.
        shouldSyncHistoryMessage: () => WhatsAppSession.HISTORY_BACKFILL_ENABLED,
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
          this.conflictBackoffMs = 60_000; // clean connect resets conflict backoff
          this.conflictDormant = false;
          this.lastConnectionEventAt = Date.now();
          this.lastError = null;
          // A connection that survives past the storm window is genuinely
          // stable — clear the storm counter so a future isolated conflict
          // starts fresh. Flap cycles (open→440→open every ~60s) re-arm it
          // faster than this fires, so sustained fighting still trips dormancy.
          const stableFor = setTimeout(() => {
            if (this.connected) { this.conflictStormCount = 0; this.conflictStormStartedAt = 0; }
          }, WhatsAppSession.CONFLICT_STORM_WINDOW_MS);
          stableFor.unref?.();
          // Each fresh connection gets its own bootstrap quota — the
          // peer device's session state may have changed under us.
          this.bootstrappedJids.clear();

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
            // Track the conflict storm. A real competing bridge produces a
            // steady drumbeat of 440s; count them within a rolling window.
            const now = Date.now();
            if (now - this.conflictStormStartedAt > WhatsAppSession.CONFLICT_STORM_WINDOW_MS) {
              this.conflictStormStartedAt = now;
              this.conflictStormCount = 0;
            }
            this.conflictStormCount += 1;
            if (this.conflictStormCount >= WhatsAppSession.CONFLICT_STORM_THRESHOLD) {
              // Sustained fighting → another instance genuinely owns this
              // slot. Stop reconnecting (going dormant) so it can hold the
              // connection cleanly instead of both flapping every 60s and
              // dropping inbound messages. Owner resumes via POST /start
              // once the duplicate bridge is shut down.
              this.conflictDormant = true;
              if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
              this.setConnectionState(
                "conflict",
                "Another Lantern bridge is using this WhatsApp session. Went dormant to stop fighting — shut down the duplicate, then Reconnect.",
              );
              this.logger.error(
                { conflicts: this.conflictStormCount, windowMs: WhatsAppSession.CONFLICT_STORM_WINDOW_MS },
                "conflict storm — going dormant; a second bridge instance owns this WhatsApp slot",
              );
              return;
            }
            // Self-healing conflict recovery (was previously terminal,
            // which left the bridge DOWN until a manual reconnect — the
            // opposite of "always up"). Schedule a single backed-off
            // reconnect; the backoff grows on consecutive conflicts and
            // resets on a clean connect. Transient conflicts (a stray
            // double-instance) recover in ~60s; a real competing session
            // is retried quietly until it closes.
            const delay = this.conflictBackoffMs;
            this.setConnectionState(
              "conflict",
              `Another WhatsApp Web session took this slot. Auto-reconnecting in ${Math.round(delay / 1000)}s — if it persists, close other Linked Devices.`,
            );
            this.reconnectAttempts = 0;
            if (!this.reconnectTimer) {
              this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.start();
              }, delay);
            }
            this.conflictBackoffMs = Math.min(
              WhatsAppSession.CONFLICT_BACKOFF_MAX_MS,
              this.conflictBackoffMs * 2,
            );
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

      // WhatsApp history sync (backfill ~14 days of past messages
      // from groups + DMs on initial pair, more on re-syncs). Must be
      // registered BEFORE the first sync event fires.
      this.hookHistorySync();

      // Hook contacts events so we capture pushName / notify name /
      // verifiedName the moment WhatsApp pushes them — critical for
      // group-roster name resolution since backfilled history
      // messages don't carry senderName.
      this.hookContactsSync();

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
              // A reaction is "on a bot reply" if we sent that message id OR
              // we have reply-meta for it. Checking both is more robust than
              // bridgeSentIds alone (which is cleared on restart).
              const onBotReply = !!(targetKeyId && (this.bridgeSentIds.has(targetKeyId) || this.bridgeReplyMeta.has(targetKeyId)));
              this.logger.info({ emoji, action, threadJid: from, onBotReply }, "reaction command");
              // 👎 / ❌ on a BOT REPLY is the intuitive "that was bad" gesture.
              // The default mapping (discard VIP draft) is a no-op on WhatsApp,
              // so thumbs-down silently did NOTHING. Route it to real negative
              // feedback: record the dislike (future replies calibrate away from
              // it) + ack the owner. No auto-retry — that's 🔁's explicit job,
              // and we must never auto-send a fresh message into a contact thread.
              if (action === "discard-draft" && onBotReply) {
                void this.recordDislikeFromReaction(from, targetKeyId);
                continue;
              }
              void dispatchReaction(
                { action, threadJid: from, onBotReply, targetMsgId: targetKeyId },
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
                    await this.handleSelfChatCommand({ action: "status", echo: "status", explicit: true }, from);
                  },
                  approveDraft: async () => { /* WhatsApp reaction-to-draft path is dashboard-only for now */ },
                  discardDraft: async () => {},
                  acknowledge: async (jid, ack) => {
                    if (reactionMsg.key) await this.sendReaction(jid, reactionMsg.key, ack);
                  },
                  feedbackGood: (jid, msgId) => {
                    // Log positive feedback — used later for offline
                    // analysis / per-contact bias tuning. No reply.
                    this.logger.info({ jid, msgId }, "self-eval: 👏 positive feedback");
                    this.logActivity("attention_dm", "👏 positive feedback on bot reply", {
                      jid, scope: "self",
                    });
                  },
                  feedbackBadRetry: async (jid, msgId) => {
                    if (!msgId) {
                      this.logger.warn({ jid }, "feedback-bad-retry: no msgId");
                      return;
                    }
                    await this.handleBadFeedbackRetry(jid, msgId);
                  },
                },
              );
            }
            continue; // reactions don't fall through to text processing
          }

          // LIVE / STATIC LOCATION SHARE — WhatsApp Web/Desktop can't
          // render `liveLocationMessage` / `locationMessage`, so the
          // bridge never sees text. We surface ONE acknowledgement per
          // jid per LOCATION_ACK_TTL_MS so the sender knows it landed,
          // then stay silent for the subsequent coord updates (a single
          // live-location share fires `liveLocationMessage` every few
          // seconds while active).
          const liveLoc = (msg.message as any)?.liveLocationMessage;
          const staticLoc = (msg.message as any)?.locationMessage;
          const isOwnerOnThisChan = this.isOwnerChat(from);
          if (
            !msg.key?.fromMe &&
            !isOwnerOnThisChan &&
            !this.isGroupJid(from) &&
            (liveLoc || staticLoc)
          ) {
            const now = Date.now();
            const lastAck = this.lastLocationAckAt.get(from) || 0;
            if (now - lastAck < WhatsAppSession.LOCATION_ACK_TTL_MS) {
              // Within the ack window — drop silently. This is the
              // common case for the live-location stream.
              continue;
            }
            this.lastLocationAckAt.set(from, now);
            // Best-effort ack. Failures are logged but don't block the
            // poll loop.
            const ack = liveLoc ? "got your location, watching 👀" : "got it 📍";
            try {
              await this.sendMessage(from, ack);
              this.logger.info(
                { jid: from, kind: liveLoc ? "live" : "static" },
                "location share acknowledged",
              );
            } catch (err) {
              this.logger.warn({ err, jid: from }, "location ack send failed");
            }
            continue; // location messages don't fall through to text
          }

          let text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            "";
          const isGroup = this.isGroupJid(from);

          // BOT-SELF HARD-SKIP. Any WhatsApp message whose body matches
          // a known bot-emitted prefix (acks, progress nudges, status,
          // digests, action confirmations) is NEVER a fresh user query.
          // Without this, the bot's own outputs cycled back through the
          // event stream — sometimes seconds later, sometimes after a
          // reconnect — could re-fire the agentic pipeline and trigger
          // a cascading echo. This is the catastrophic-bug fix that
          // matches the iMessage-bridge logic.
          if (text && isBotSelfMessage(text)) {
            this.logger.debug(
              { jid: from, textPreview: text.slice(0, 80) },
              "skipping bot-self message — hard match on bot-emitted pattern",
            );
            continue;
          }

          // HISTORY LOG. Persist every real text message (not bot-self,
          // not reactions) to a JSONL ring per tenant so the LLM tool
          // `search_whatsapp_history` can answer cross-source queries.
          // appendHistory dedupes by msgId so a message that's also
          // delivered via the messaging-history.set backfill stream
          // isn't double-logged.
          if (text && from) {
            this.appendHistory({
              ts: (msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
              jid: from,
              isGroup: this.isGroupJid(from),
              fromMe: !!msg.key.fromMe,
              senderName: msg.pushName || "",
              participant: msg.key.participant || "",
              text,
              msgId: msg.key.id || "",
            });
            // AUTO-BACKFILL: first time we see a message in a GROUP
            // with a valid msgId, schedule a one-time on-demand
            // history pull. Gives sparse groups (like a trip group
            // the user rarely chats in) instant searchable depth
            // without the user having to invoke a tool. Per-jid
            // dedup so we never fire twice.
            if (
              this.isGroupJid(from) &&
              msg.key.id &&
              !this.autoBackfillAttempted.has(from) &&
              WhatsAppSession.HISTORY_BACKFILL_ENABLED
            ) {
              this.autoBackfillAttempted.add(from);
              setTimeout(() => {
                void this.backfillGroup({ jid: from, count: WhatsAppSession.AUTO_BACKFILL_COUNT })
                  .then((r) => {
                    if (r) this.logger.info({ jid: from, requestId: r.requestId }, "auto-backfill dispatched");
                  })
                  .catch((err) => this.logger.debug({ err, jid: from }, "auto-backfill failed"));
              }, WhatsAppSession.AUTO_BACKFILL_DELAY_MS);
            }
          }

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
                await this.handleSelfChatCommand(voiceCmd, from);
                continue;
              }
              // Not a "lantern …" command — treat the transcript as a normal
              // owner message so a voice note gets a conversational reply
              // exactly like typed text (was: silently dropped because `text`
              // stayed empty → the fromMe `if (!text) continue` below ate it).
              this.logger.info({ transcript: transcript.slice(0, 80) }, "owner voice note → routing as chat");
              this.broadcast({
                type: "activity",
                data: { kind: "message_in", summary: "🎙️ voice note transcribed", detail: transcript.slice(0, 200), jid: from, timestamp: Date.now() },
              });
              text = transcript;
            } else if (annotation.kind === "voice") {
              // Transcription failed — acknowledge instead of going silent.
              await this.confirmToSelf("🎙️ i couldn't make out that voice note — mind typing it or re-recording?");
              continue;
            }
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
            // If annotation produced nothing usable, synthesize a
            // minimal placeholder so the bot doesn't go stone-silent
            // on attachments it couldn't decode. This was the bug:
            // owner sends a screenshot → vision fails → text stays
            // empty → reply path drops the message. Now: bot at least
            // ACKS that something arrived and can ask what's in it.
            if (!text) {
              text = "[they sent an attachment I couldn't decode]";
            }
          }

          // Messages flagged fromMe include both:
          //   (a) replies the bridge itself just sent — echo back; skip.
          //   (b) replies the owner typed from native WhatsApp on phone —
          //       treat as command or takeover.
          //   (c) HISTORY-SYNC REPLAYS — every reconnect, Baileys
          //       backfills old messages through the SAME upsert event
          //       with m.type==="append" (not "notify"). Without this
          //       guard, the bridge re-pauses every contact you've
          //       ever messaged on EACH reconnect, resetting the 60min
          //       take-over timer indefinitely. Result: you appear
          //       perma-paused even when idle.
          if (msg.key.fromMe) {
            if (msg.key.id && this.bridgeSentIds.has(msg.key.id)) {
              this.bridgeSentIds.delete(msg.key.id);
              continue;
            }
            if (!text) continue;
            // Skip history-sync replays — only LIVE owner messages
            // should trigger take-over + persona learning.
            if (m.type !== "notify") {
              this.logger.debug({ from, type: m.type }, "skipping fromMe replay (history-sync)");
              continue;
            }
            // "remember X about this person" — owner teaching a durable
            // fact about the CONTACT in this thread. Saved server-side +
            // injected into future replies via factsBlock. The bot does
            // NOT reply in the contact's thread (would leak the note);
            // it acks to the owner's self-chat. Contact threads only.
            if (!isGroup && !this.isSelfChat(from)) {
              const fact = parseRememberCommand(text);
              if (fact) {
                const contactJid = from;
                const label = this.contactNames.get(contactJid) || contactJid.split("@")[0];
                void this.personal.addFact(contactJid, fact).then((ok) => {
                  void this.confirmToSelf(
                    ok ? `📝 got it — noted about ${label}: ${fact}` : `couldn't save that note about ${label}, try again`,
                  );
                });
                continue; // a memory command is not a voice exemplar + no contact reply
              }
            }
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

          // PROACTIVE MEMORY (additive — never throws, never blocks the
          // reply pipeline). Pattern-extract high-confidence facts about
          // the sender (DMs only — group authorship is ambiguous) and
          // persist via PersonalClient.addFact with source="auto-extract".
          // Surfaces on future replies via factsBlock.
          if (!isGroup && !this.isOwnerChat(from)) {
            void (async () => {
              try {
                const facts = extractAutoFacts(text);
                for (const f of facts) {
                  if (f.perspective !== "self") continue;
                  const ok = await this.personal.addFact(from, f.content, "auto-extract").catch(() => false);
                  this.logger.info(
                    { jid: from, fact: f.content, pattern: f.pattern, confidence: f.confidence, ok },
                    ok ? "auto-fact saved" : "auto-fact skipped",
                  );
                }
              } catch (err) {
                this.logger.debug({ err, jid: from }, "auto-fact scan failed");
              }
            })();
          }

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
          //
          // Hard-skip non-conversational JIDs — WhatsApp Status updates
          // (status@broadcast) and newsletters (@newsletter) are one-way
          // broadcasts, not messages addressed to the owner. Treating
          // them as escalations spams the self-chat every time a contact
          // posts a Story.
          const senderName = msg.pushName || undefined;
          const isBroadcast = from === "status@broadcast"
            || from.endsWith("@broadcast")
            || from.endsWith("@newsletter");
          if (isBroadcast) {
            this.logger.debug({ from }, "skipping attention check — broadcast JID");
          } else {
            this.checkAttention(from, text, senderName, isGroup).catch((err) =>
              this.logger.warn({ err, from }, "attention check failed")
            );
          }
          // Also short-circuit the rest of the message-handling pipeline
          // for broadcast JIDs — auto-reply / monitor / store-history
          // make no sense for one-way Status posts.
          if (isBroadcast) continue;

          if (!this.agent.enabled()) continue;
          // PROACTIVE INGESTER (unknown senders): appointment confirmations →
          // surface + offer to add to calendar; marketing/spam → suppress.
          if (text && !this.isGroupJid(from)) {
            const ingest = await this.maybeIngestUnknownInbound(from, text).catch(() => "pass" as const);
            if (ingest === "handled") continue;
          }
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
          // NOTE: no hard allow-list gate here. The old default-deny was
          // over-correction — it silenced EVERY contact. The real spam
          // problem (wooden replies to strangers) is handled downstream
          // by confidence-gating (unknown contacts → draft for approval,
          // never auto-sent) + the bot-tell filter + escalation guard.
          // So: known contacts (relationship/samples/facts) auto-reply
          // authentically; unknown contacts get held as a draft; nobody
          // gets spam. Owner can still globally mute or pause per-contact.
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
    // FINAL PASS — verifiable-claims rewriter. Catches false-action
    // claims ("I sent him", "I added it") with no matching tool
    // invocation and rewrites to honest intent. Skip bridge-self
    // prefixes (acks/nudges) so they don't get mangled.
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
    // If this delivery (e.g. a morning brief or concierge summary) ends in
    // a "want me to X?" offer, arm it so the owner's "yes" executes the
    // follow-up instead of falling through to generic chatter.
    this.cacheOwnerFollowupOffer(text, own);
    // Mirror to email + telegram so the user still gets it if WA
    // itself is degraded. mirrorToEmail is throttled per-text.
    void this.mirrorToEmail(text);
    void this.mirrorToTelegram(text);
    return own;
  }

  // Detect a "want me to X?" follow-up offer in an owner-facing delivery and
  // cache it under the owner JID so a later "yes" / "do it" runs the offer via
  // the existing pendingOffer → executeCachedOffer (freeform-followup) path.
  // Scoped to freeform-followup so action acks ("✅ done") never arm a
  // confirmation. This is what was missing for the proactive morning brief:
  // its closing question was delivered via sendSelf, which never ran offer
  // detection, so "yes" hit the chat handler instead.
  private cacheOwnerFollowupOffer(text: string, ownJid: string): void {
    if (!ownJid) return;
    const offer = detectOfferInReply(text);
    if (!offer || offer.kind !== "freeform-followup") return;
    offer.issuedAt = Date.now();
    offer.freeformPriorReply = text;
    this.pendingOffers.set(ownJid, offer);
    this.logger.info(
      { action: (offer.freeformAction || "").slice(0, 80) },
      "armed owner follow-up offer from delivered message",
    );
  }

  /**
   * Public read of the owner's device calendar (iCloud + Google + subscribed),
   * straight from the macOS Calendar store. Backs the `read_calendar` agentic
   * tool (control-plane calls this via the bridge callback) AND the diagnostic
   * endpoint. Returns a plain, model-friendly shape.
   */
  async getUpcomingCalendar(
    opts: { days?: number; max?: number; query?: string; fromIso?: string; toIso?: string } = {},
  ): Promise<Array<{ title: string; start: string; end: string | null; calendar: string }>> {
    if (!this.macActions) return [];
    const events = await this.macActions.readUpcomingEvents(opts);
    return events.map((e) => ({
      title: e.title,
      start: e.start.toISOString(),
      end: e.end ? e.end.toISOString() : null,
      calendar: e.calendar,
    }));
  }

  // Proactive ingester for UNKNOWN-sender inbound. Appointment confirmation →
  // DM the owner + arm a "yes" offer that adds it to the calendar (via the
  // freeform-followup → [CALENDAR:] path). Marketing/spam → suppress. Returns
  // "handled" to skip the auto-reply path. Best-effort + flag-gated.
  private async maybeIngestUnknownInbound(from: string, text: string): Promise<"handled" | "pass"> {
    if ((process.env.LANTERN_APPT_INGEST || "on").toLowerCase() === "off") return "pass";
    if (!from || !text || this.isGroupJid(from)) return "pass";
    if (this.contactNames.has(from)) return "pass";
    if (this.ownerProfileStore.relationshipFor(from, undefined)) return "pass";
    let kind: "appointment" | "spam" | "other";
    let signals: string[];
    try {
      const { classifyUnknownInbound } = await import("@lantern/bridge-core/inbound-classifier");
      ({ kind, signals } = classifyUnknownInbound(text));
    } catch { return "pass"; }
    if (kind === "other") return "pass";
    if (kind === "spam") {
      this.logger.info({ from, signals }, "ingest: suppressed marketing/spam from unknown sender");
      return "handled";
    }
    this.logger.info({ from, signals }, "ingest: appointment confirmation from unknown sender");
    const ownJid = this.ownJid();
    const snippet = text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (ownJid) {
      const offerText = `📅 Looks like an appointment text from ${from.split("@")[0]}:\n"${snippet}"\nReply "yes" to add it to your calendar.`;
      await this.confirmToSelf(offerText).catch(() => {});
      this.pendingOffers.set(ownJid, {
        kind: "freeform-followup",
        freeformAction: `Add this appointment to my calendar — emit a [CALENDAR:Title|start-ISO|end-ISO?|notes] marker with the correct title, date, and time parsed from: "${snippet}"`,
        freeformInbound: text,
        freeformPriorReply: offerText,
        issuedAt: Date.now(),
      } as any);
    }
    return "handled";
  }

  // Apply an owner presence/status command from self-chat (set place + timer,
  // or clear). Acks with a reaction + a confirmation line.
  private async applyPresenceCommand(
    pres: PresenceCommand,
    jid: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null },
  ): Promise<void> {
    if (pres.action === "clear") {
      this.presence.clearOverride();
      this.logActivity("bot_on", "presence cleared — available", { scope: "self" });
      await this.sendReaction(jid, key, "✅").catch(() => {});
      await this.confirmToSelf("✅ status cleared — you're marked available again.");
      return;
    }
    this.presence.setStatus({ label: pres.label, place: pres.place, durationMs: pres.durationMs });
    const mins = pres.durationMs ? Math.round(pres.durationMs / 60_000) : null;
    const forText = mins ? (mins >= 60 && mins % 60 === 0 ? ` for ${mins / 60}h` : ` for ${mins}m`) : "";
    this.logActivity("attention_dm", `presence set: ${pres.label}${forText}`, { scope: "self" });
    await this.sendReaction(jid, key, "📍").catch(() => {});
    await this.confirmToSelf(
      `📍 got it — you're ${pres.label}${forText}. I'll tell anyone who messages that you'll get back, and offer to take a message. Say "I'm back" to clear.`,
    );
  }

  /**
   * Public contact search over the macOS AddressBook (name → phones + emails).
   * Backs the `search_contacts` agentic tool.
   */
  async searchContacts(query: string, limit?: number) {
    const { searchAddressBookContacts } = await import("@lantern/bridge-core/contact-resolver");
    return searchAddressBookContacts(query, { limit, logger: this.logger });
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

  // --- 1:1 contact allow-list (opt-in auto-reply) ----------------------
  //
  // Default-deny: friends, family, strangers don't get any auto-reply
  // unless the owner explicitly opts them in. Mirrors the iMessage
  // bridge's enabledContacts. Owner channel (self-chat / dedicated bot
  // DM) is always exempt — the bot still replies to its owner.
  enableContact(jid: string): void {
    const norm = this.normalizeContactJid(jid);
    if (!norm) return;
    this.enabledContacts.add(norm);
    this.saveState();
    this.logger.info({ jid: norm }, "auto-reply enabled for contact");
  }
  disableContact(jid: string): void {
    const norm = this.normalizeContactJid(jid);
    if (!norm) return;
    if (this.enabledContacts.delete(norm)) {
      this.saveState();
      this.logger.info({ jid: norm }, "auto-reply disabled for contact");
    }
  }
  listEnabledContacts(): string[] {
    return [...this.enabledContacts];
  }
  isContactEnabled(jid: string): boolean {
    const norm = this.normalizeContactJid(jid);
    if (!norm) return false;
    return this.enabledContacts.has(norm);
  }
  private normalizeContactJid(input: string): string {
    // Strip device suffix and bare-phone variants so "15125551234" and
    // "15125551234@s.whatsapp.net" hit the same allow-list entry.
    let s = (input || "").trim();
    if (!s) return "";
    // Strip ":<N>" device suffix Baileys sometimes carries.
    s = s.replace(/:\d+@/, "@");
    if (!s.includes("@")) s = `${s}@s.whatsapp.net`;
    return s;
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
   * Returns the full member list of a group by JID OR by name (case-
   * insensitive substring). Member entries include phone-number JID
   * and the contact's pushName when known. Used by the LLM tool
   * `get_whatsapp_group` to answer "who's in the Japan trip group?"
   * queries — generic, works for any group the user is a member of.
   */
  async getGroupMembers(opts: { jid?: string; name?: string }): Promise<{
    jid: string;
    name: string;
    members: Array<{ jid: string; name: string; isAdmin: boolean }>;
  } | null> {
    if (!this.socket) return null;
    let targetJid = (opts.jid || "").trim();
    let targetName = (opts.name || "").trim().toLowerCase();
    if (!targetJid && !targetName) return null;

    // Resolve by name → JID via the full group list.
    if (!targetJid && targetName) {
      try {
        const groups = await this.listGroups();
        const match = groups.find((g) => g.name.toLowerCase().includes(targetName));
        if (!match) return null;
        targetJid = match.jid;
      } catch (err) {
        this.logger.warn({ err, name: opts.name }, "getGroupMembers: name resolution failed");
        return null;
      }
    }

    try {
      const meta = (await this.socket.groupMetadata(targetJid)) as {
        id?: string;
        subject?: string;
        participants?: Array<{ id?: string; lid?: string; admin?: string | null }>;
      };
      // Build a JID → name map from the wa-history JSONL. Five years
      // of message history is a much richer name source than the
      // in-memory contactNames map (which only has names for contacts
      // who DM'd US recently). For each group member's JID, we want
      // the most-recent pushName they used in ANY chat we've seen.
      const historyNames = this.buildHistoryNameMap();
      const members = (meta.participants || []).map((p) => {
        const jid = p.id || p.lid || "";
        const pushName =
          this.contactNames.get(jid)
          || historyNames.get(jid)
          || "";
        const local = jid.split("@")[0];
        const isLid = jid.endsWith("@lid");
        // @lid local-parts are NOT phone numbers — they're opaque
        // privacy-preserving identifiers WhatsApp generates for
        // group-member visibility without leaking phone numbers.
        // Showing them as "+xxx" would be misleading. Real
        // @s.whatsapp.net JIDs DO have phone-number local parts and
        // should be shown as "+number".
        let human: string;
        if (pushName) {
          human = pushName;
        } else if (isLid) {
          human = "(name unknown — group privacy)";
        } else if (local.match(/^\d+$/)) {
          human = `+${local}`;
        } else {
          human = local;
        }
        return { jid, name: human, isAdmin: p.admin === "admin" || p.admin === "superadmin" };
      });
      return {
        jid: meta.id || targetJid,
        name: (meta.subject || "").trim() || targetJid.split("@")[0],
        members,
      };
    } catch (err) {
      this.logger.warn({ err, targetJid }, "getGroupMembers: groupMetadata failed");
      return null;
    }
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
          enabledContacts?: string[];
          disclosedJids?: string[];
          ownerSentHistory?: Record<string, string[]>;
          personalDocsEnabled?: boolean;
          killSwitch?: boolean;
          draftApprovalsEnabled?: boolean;
          escalationEnabled?: boolean;
          pushoverEnabled?: boolean;
        };
        this.muted = !!raw.muted;
        // Toggles default to safe values: docs ON, killswitch OFF.
        if (typeof raw.personalDocsEnabled === "boolean") this.personalDocsEnabled = raw.personalDocsEnabled;
        if (typeof raw.killSwitch === "boolean") this.killSwitch = raw.killSwitch;
        if (typeof raw.draftApprovalsEnabled === "boolean") this.draftApprovalsEnabled = raw.draftApprovalsEnabled;
        if (typeof raw.escalationEnabled === "boolean") this.escalationEnabled = raw.escalationEnabled;
        if (typeof raw.pushoverEnabled === "boolean") this.pushoverEnabled = raw.pushoverEnabled;
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
        for (const c of raw.enabledContacts ?? []) {
          if (typeof c === "string") {
            const norm = this.normalizeContactJid(c);
            if (norm) this.enabledContacts.add(norm);
          }
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
        enabledContacts: [...this.enabledContacts],
        disclosedJids: [...this.disclosedJids],
        ownerSentHistory,
        personalDocsEnabled: this.personalDocsEnabled,
        killSwitch: this.killSwitch,
        draftApprovalsEnabled: this.draftApprovalsEnabled,
        escalationEnabled: this.escalationEnabled,
        pushoverEnabled: this.pushoverEnabled,
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

  // Set of remoteJids we've already force-bootstrapped this connection
  // — assertSessions() is idempotent but fetching pre-key bundles
  // has a server-side rate-limit risk so we only do it once per JID
  // per connection lifetime.
  private bootstrappedJids: Set<string> = new Set();

  // Increment decrypt-error counter; trigger targeted assertSessions
  // for the offending remoteJid, AND self-heal when the storm crosses
  // threshold inside the rolling window.
  //
  // assertSessions(jid, force=true) force-fetches a fresh pre-key
  // bundle from the WhatsApp server for the peer device and
  // establishes a new Signal session — bypassing the retry-receipt
  // round-trip that the multi-device protocol gets stuck on when
  // the peer device's session state has diverged from ours (common
  // after multiple bridge restarts / re-pairs).
  private noteDecryptError(remoteJid?: string): void {
    const now = Date.now();
    if (now - this.decryptErrorWindowStart > WhatsAppSession.DECRYPT_STORM_WINDOW_MS) {
      this.decryptErrorWindowStart = now;
      this.decryptErrorCount = 0;
    }
    this.decryptErrorCount++;

    // Targeted bootstrap: force a fresh session with the failing peer
    // device. This is what unsticks the "phone keeps sending with a
    // session the bridge has no record of" deadlock.
    if (remoteJid && !this.bootstrappedJids.has(remoteJid) && this.socket) {
      this.bootstrappedJids.add(remoteJid);
      const sock = this.socket;
      void (async () => {
        try {
          await sock.assertSessions([remoteJid], true);
          this.logger.info({ remoteJid }, "force-bootstrapped Signal session for failing peer");
        } catch (err) {
          this.logger.warn({ err, remoteJid }, "assertSessions force-bootstrap failed");
        }
      })();
    }

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
    // Presence / "I'm away" status — owner sets a timed, free-text status
    // from self-chat ("I'm at the temple for 2h", "I'm back") so the bot can
    // tell contacts where they are + offer to take a message.
    if (self && !group && trimmed) {
      const pres = parsePresenceCommand(text);
      if (pres) {
        await this.applyPresenceCommand(pres, jid, key);
        return;
      }
    }

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
          await this.handleSelfChatCommand(parsed, jid);
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
    // CONFIRMATION / REJECTION INTERCEPTS + BUSY GATE for owner chat.
    if (this.personalDocsEnabled && self && !group && this.docs && this.macActions) {
      this.gcPendingOffers();
      const cachedOffer = this.pendingOffers.get(jid);
      if (cachedOffer && looksLikeConfirmation(text)) {
        this.logger.info({ kind: cachedOffer.kind, jid }, "executing cached offer on confirmation");
        this.pendingOffers.delete(jid);
        void this.executeCachedOffer(jid, cachedOffer);
        return;
      }
      // Short "no" / "nope" / "skip" with a pending offer → drop the
      // offer and ack briefly. Stops every rejection from spawning a
      // fresh agent round-trip + reply.
      if (cachedOffer && looksLikeRejection(text)) {
        this.logger.info({ kind: cachedOffer.kind, jid }, "dropping cached offer on rejection");
        this.pendingOffers.delete(jid);
        void this.confirmToSelf("👍 no worries");
        return;
      }
      // CHAT-BUSY GATE — queue latest substantive message silently.
      // No nudge: the user knows they typed a second message, and the
      // real answer to the queued one lands when the current run
      // finishes (drained in handleOwnerDocQuery's finally block).
      if (this.busyChat.has(jid)) {
        if (!isTrivialChatter(text)) {
          this.queuedQuery.set(jid, { text, queuedAt: Date.now() });
          this.logger.info({ jid, textPreview: text.slice(0, 60) }, "queued — chat busy, will process next");
        } else {
          this.logger.info({ jid, textPreview: text.slice(0, 60) }, "skipping — chat busy (trivial)");
        }
        return;
      }
    }

    // OWNER SELF-CHAT — every substantive message goes through the
    // agentic pipeline with tools attached. The LLM decides whether to
    // search local files (search_personal_files / read_personal_file),
    // call Gmail / Calendar, etc. Trivial chatter ("thanks", "ok",
    // "👍") still skips the heavy path. No more regex pre-deciders —
    // the model is the router.
    if (self && !group && text) {
      const nlEnabled = (process.env.LANTERN_OWNER_CHAT_NL || "on").toLowerCase() !== "off";
      // Acks/rejections AND greetings/small-talk skip the agentic tool
      // pipeline — they never need file/Gmail/Calendar tools, and routing
      // them to natural chat replies in a fraction of the time.
      if (isTrivialChatter(text) || isGreetingSmallTalk(text)) {
        if (nlEnabled && !this.muted) {
          this.logger.info({ jid, textPreview: text.slice(0, 60) }, "owner greeting/chatter → natural chat (fast-path)");
          void this.handleOwnerNaturalChat(jid, text);
        }
        return;
      }
      if (this.personalDocsEnabled && this.docs) {
        this.logger.info({ jid, textPreview: text.slice(0, 60) }, "owner self-chat → agentic pipeline (LLM-driven tools)");
        // Fire-and-forget: scan for durable facts and auto-append to
        // the owner profile. Sends a one-line ack if anything was
        // learned. Never blocks the doc-query path.
        void this.maybeAutoUpdateOwnerProfileFromSelfChat(jid, text);
        void this.handleOwnerDocQuery(jid, text, key);
        return;
      }
      // personal-docs disabled — fall through to natural chat so the
      // bridge still replies.
      if (nlEnabled && !this.muted) {
        void this.handleOwnerNaturalChat(jid, text);
        return;
      }
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
        `You took over the thread with ${jid.split("@")[0]} — auto-reply paused ${Math.round(PAUSE_TTL_MS / 60_000)}m`,
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
  private async handleSelfChatCommand(parsed: ParsedCommand, chatJid?: string): Promise<void> {
    await executeCommand(parsed, {
      channelLabel: "WhatsApp",
      chatJid: chatJid || this.ownJid() || "",
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
          `• approval queue: ${this.draftApprovalsEnabled ? "on" : "off"}`,
          `• panic channels: ${this.escalationEnabled ? "on" : "off"} (pushover: ${this.pushoverEnabled ? "on" : "off"})`,
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
      setApprovals: async (enabled: boolean) => {
        this.draftApprovalsEnabled = enabled;
        this.saveState();
        this.logActivity(enabled ? "bot_on" : "bot_off", `approval queue ${enabled ? "ENABLED" : "DISABLED"}`, { scope: "self" });
      },
      listVips: async () => {
        try {
          const res = await authedFetch("/v1/whatsapp/vips");
          if (!res.ok) return `⚠️ couldn't fetch VIPs (HTTP ${res.status})`;
          const data = (await res.json()) as { vips?: Array<{ jid: string; displayName?: string }> };
          const vips = data.vips ?? [];
          if (vips.length === 0) return "📭 no VIPs.";
          return [
            `👑 VIPs (${vips.length}):`,
            ...vips.map((v) => `• ${v.displayName || v.jid.split("@")[0]}`),
            "",
            `tap ❤️ on a contact's message to add; 🗑 to remove.`,
          ].join("\n");
        } catch (err) {
          this.logger.warn({ err }, "vip-list failed");
          return "⚠️ couldn't fetch VIPs (network error)";
        }
      },
      clearVips: async () => {
        try {
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
        this.saveState();
        this.logActivity(enabled ? "bot_on" : "bot_off", `panic channels ${enabled ? "ENABLED" : "DISABLED"}`, { scope: "self" });
      },
      setPushover: async (enabled: boolean) => {
        this.pushoverEnabled = enabled;
        this.saveState();
        this.logActivity(enabled ? "bot_on" : "bot_off", `pushover siren ${enabled ? "ENABLED" : "DISABLED"}`, { scope: "self" });
      },
      placeOutboundCall: async (req) => {
        return this.placeOutboundCallFromOwner(req);
      },
    });
  }

  private async placeOutboundCallFromOwner(
    intent: { intent: "conference" | "voicemail" | "task"; target: string; message?: string; reason?: string; chatJid: string },
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      const { authedFetch } = await import("@lantern/bridge-core/auth");
      const listRes = await authedFetch("/v1/connectors");
      if (!listRes.ok) return { ok: false, reason: "couldn't fetch connectors" };
      const installs = (await listRes.json()) as Array<{ connectorId: string; config?: Record<string, unknown> }>;
      const twilio = installs.find((i) => i.connectorId === "twilio");
      const twilioFrom = twilio?.config?.phoneNumber as string | undefined;
      if (!twilio || !twilioFrom) {
        return { ok: false, reason: "Twilio connector not installed — set up via dashboard /connectors → Twilio" };
      }
      const { executeOutboundCall: exec, renderTextWithElevenLabs: render } =
        await import("@lantern/bridge-core/call-orchestrator");
      // chatJid is the jid of the chat where the call command was
      // issued — pendingOffer + notify go here so the "yes" arriving
      // in the SAME chat fires the intercept. Falls back to ownJid()
      // when the caller didn't pass one (e.g. test path).
      const offerJid = intent.chatJid || this.ownJid() || "";
      const deps = {
        logger: this.logger as any,
        twilioFromNumber: twilioFrom,
        ownerPhone: process.env.LANTERN_OWNER_PHONE,
        // Show the owner's own (verified) number to contacts so they answer.
        callerId: process.env.LANTERN_VOICE_CALLER_ID || undefined,
        ownerName: process.env.LANTERN_OWNER_NAME || undefined,
        smsHeadsUp: (process.env.LANTERN_VOICE_SMS_HEADSUP || "on").toLowerCase() !== "off",
        resolveContact: async (nameOrNumber: string) => this.resolveCallTarget(nameOrNumber),
        authedFetch: authedFetch as any,
        notifyOwner: async (text: string) => {
          // sendSelf fans out across all linked devices (including
          // the owner's phone) — that's where the "yes" will arrive.
          await this.sendSelf(text).catch(() => {});
        },
        cachePendingOffer: (offer: any) => {
          if (!offerJid) return;
          this.pendingOffers.set(offerJid, {
            kind: "outbound-call",
            callRequest: offer.payload,
            callPlan: offer.plan,
            issuedAt: offer.issuedAt,
          } as any);
        },
        renderVoice: this.makeVoiceRenderer(render),
      };
      this.lastCallDeps = deps;
      const res = await exec(intent, deps, { ownerInitiated: true });
      return { ok: res.ok, reason: res.reason };
    } catch (err) {
      this.logger.error({ err }, "outbound call orchestrator failed (wa)");
      return { ok: false, reason: (err as Error).message };
    }
  }

  // Cached orchestrator deps from the most recent placeOutboundCallFromOwner
  // call. Used by the pendingOffer 'yes' path to call placeCallNow without
  // rebuilding the entire deps surface (renderVoice closure, etc.).
  private lastCallDeps: any = null;

  private lastResolveSuggestions: Array<{ name: string; phone?: string; relationship?: string }> = [];

  private async resolveCallTarget(input: string): Promise<{ phone: string; name?: string; relationship?: string } | null> {
    const { resolveContact: universalResolve } = await import("@lantern/bridge-core/contact-resolver");
    const result = await universalResolve(input, {
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

  getLastResolveSuggestions(): string {
    const { formatSuggestions } = require("@lantern/bridge-core/contact-resolver") as typeof import("@lantern/bridge-core/contact-resolver");
    return formatSuggestions(this.lastResolveSuggestions);
  }

  private makeVoiceRenderer(
    render: (text: string, o: { apiKey: string; voiceId: string }) => Promise<Buffer | null>,
  ): ((text: string) => Promise<string | null>) | undefined {
    const apiKey = process.env.LANTERN_ELEVENLABS_KEY;
    const voiceId = process.env.LANTERN_ELEVENLABS_VOICE_ID;
    const publicUrlBase = process.env.LANTERN_VOICE_CACHE_PUBLIC_URL;
    if (!apiKey || !voiceId || !publicUrlBase) return undefined;
    return async (text: string) => {
      try {
        const buf = await render(text, { apiKey, voiceId });
        if (!buf) return null;
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

  // Owner self-chat auto-profile-update hook. Inspects each owner
  // self-chat message for durable facts and appends them to the
  // shared ~/.lantern/owner-profile.md via the LLM-backed extractor.
  // Sends a one-line ack so the owner sees what was committed.
  // Fire-and-forget — never blocks the doc-query path.
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
          const out = await this.agent.respondTo(jid, prompt, "", { withTools: false });
          return out || "";
        },
        logger: this.logger as any,
      });
      if (result.appended.length === 0) {
        // Even when nothing was profile-worthy, the message may
        // still be a cross-contact context ping ("Sujith reached
        // home", "driving Madhu to the airport"). Try to capture
        // it as a mention-tagged episode so the next inbound from
        // that person surfaces it.
        await this.maybeRecordMentionEpisode(jid, text);
        return;
      }
      this.ownerProfileStore.invalidate();
      // Also try a mention-tagged episode — orthogonal to profile.
      await this.maybeRecordMentionEpisode(jid, text);
      const ack = formatAck(result.appended);
      if (ack) {
        // Mirror to self-chat. confirmToSelf handles the
        // bridge-sent dedup + email/telegram mirroring.
        await this.confirmToSelf(ack);
      }
    } catch (err) {
      this.logger.warn({ err }, "owner-profile auto-update failed");
    }
  }

  // Capture cross-contact context from owner self-chat utterances.
  // ("Sujith reached home" → episode tagged ["sujith"] under self-jid.)
  // Used to surface the right context when the mentioned contact
  // messages later.
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

  // Personal-docs Q&A in WhatsApp self-chat. Owner asked about a
  // local file. Search → inject into LLM → reply → optionally attach
  // the file via Baileys's document message type.
  private async handleOwnerDocQuery(
    jid: string,
    query: string,
    key: { id?: string | null; remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null },
  ): Promise<void> {
    if (!this.docs) return;
    this.busyChat.add(jid);
    try {
    this.logger.info({ query: query.slice(0, 80) }, "owner doc query (whatsapp)");
    this.logActivity("attention_dm", `🧠 owner query: ${query.slice(0, 60)}`, { scope: "self" });

    // LATENCY-FIRST UX (mirrors iMessage):
    //   • Subtle reaction so the user knows we received them — no
    //     text ack on fast paths so the chat reads like a real reply.
    //   • A single "🧠 thinking…" text only if work runs >3s.
    //   • Nothing further until the answer (or graceful fallback).
    try { await this.sendReaction(jid, key, "🧠"); } catch {}
    const startedAt = Date.now();
    let thinkingSent = false;
    const thinkingTimer = setTimeout(() => {
      thinkingSent = true;
      void this.confirmToSelf("🧠 thinking…");
    }, 3000);

    // Deterministic Gmail + Calendar prefetch in parallel for
    // appointment-y queries — optimization only (the LLM could call
    // those tools too).
    const client = defaultConnectorClient(this.logger);
    // ROSTER pre-fetch: hand the LLM the full WhatsApp + iMessage
    // group rosters that match topic tokens BEFORE it writes a token.
    // Without this it lazy-paths to docs and answers with a subset.
    const rosterSignal = looksLikeRosterQuery(query);
    const imBase = (process.env.LANTERN_IMESSAGE_BRIDGE_URL || "http://127.0.0.1:3200").replace(/\/$/, "");
    const rosterAdapters: RosterPrefetchAdapter[] = [
      {
        surface: "whatsapp",
        listGroups: async () => {
          const all = await this.listGroups().catch(() => []);
          return all.map((g) => ({ id: g.jid, name: g.name, participantCount: g.participants }));
        },
        getGroupMembers: async (opts) => {
          const out = await this.getGroupMembers({ jid: opts.id, name: opts.name }).catch(() => null);
          if (!out) return null;
          return { id: out.jid, name: out.name, members: out.members };
        },
      },
      {
        surface: "imessage",
        listGroups: async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          try {
            const res = await fetch(`${imBase}/session/${this.tenantId}/imessage/groups`, { signal: ctrl.signal });
            if (!res.ok) return [];
            const data = (await res.json()) as { groups?: Array<{ chatRowid: number; name: string; participantCount: number }> };
            return (data.groups || []).map((g) => ({ id: String(g.chatRowid), name: g.name, participantCount: g.participantCount }));
          } catch { return []; }
          finally { clearTimeout(t); }
        },
        getGroupMembers: async (opts) => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          try {
            const res = await fetch(`${imBase}/session/${this.tenantId}/imessage/group`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chatRowid: opts.id ? parseInt(opts.id, 10) || undefined : undefined,
                name: opts.name,
              }),
              signal: ctrl.signal,
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { chatRowid: number; name: string; members: string[] };
            return {
              id: String(data.chatRowid),
              name: data.name,
              members: data.members.map((h) => ({ name: this.contactNames.get(h) || h, isAdmin: false })),
            };
          } catch { return null; }
          finally { clearTimeout(t); }
        },
      },
    ];

    // MULTI-AGENT PLAN. For complex cross-source queries the planner
    // emits 2-5 sub-tasks (e.g. "search docs for X", "search whatsapp
    // history for X", "search imessage history for X"). Each runs in
    // PARALLEL against its source adapter; results pack into a
    // synthesis brief the lead LLM weaves into one reply.
    //
    // The roster + appointment prefetches above are SPECIALIZED
    // versions of this — kept because they pre-date the generic
    // planner and have richer per-source formatting. The planner picks
    // up everything else (history sweeps, doc + gmail correlations,
    // calendar lookups).
    const plan = planSubTasks(query);
    const planAdapters = this.buildSubTaskAdapters(query);

    // SMART CONTEXT: the device calendar is the source of truth for the
    // owner's appointments (iCloud + Google + subscribed) and is a cheap,
    // local SQLite read — so read it for EVERY substantive owner query, NOT
    // gated behind a brittle keyword regex (which missed "when's my next
    // haircut" because it had no "appointment" token). The model ignores it
    // when irrelevant; when relevant it can never give a false "not found".
    // The heavier Gmail/Google appointment prefetch stays keyword-gated.
    const deviceCalP: Promise<CalendarEventRead[]> =
      process.platform === "darwin" && this.macActions
        ? this.macActions.readUpcomingEvents({ days: 60 }).catch((err) => {
            this.logger.warn({ err }, "device calendar read failed (continuing)");
            return [] as CalendarEventRead[];
          })
        : Promise.resolve([] as CalendarEventRead[]);
    const [gatedApptBlock, deviceEvents, rosterResults, subTaskResults] = await Promise.all([
      looksLikeAppointmentQuery(query)
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
      "agentic prefetch done (whatsapp)",
    );

    // OWNER PROFILE — same context the natural-chat path uses, so
    // profile-answerable questions ("who is my son", "what do I work
    // on") resolve in one round-trip without a tool-loop timeout.
    const ownerProfile = this.ownerProfileStore.prose();
    const relationshipsBlock = this.ownerProfileStore.relationshipsBlock();
    const today = new Date().toISOString().slice(0, 10);
    const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];
    // Language modality applies to owner self-chat too.
    const langHint = detectLanguageHints(query);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his WhatsApp self-chat as if you ARE him talking to himself.`,
      `Today is ${today}.`,
      ``,
      ownerProfile ? `# Who you are\n${ownerProfile}` : "",
      relationshipsBlock ? `\n# Your people\n${relationshipsBlock}` : "",
      languageModality ? `\n${languageModality}` : "",
      ``,
      `# Decide BEFORE calling tools`,
      `Many questions are answerable from the profile above. Skip tool calls for:`,
      `  • Relationship / family questions ('who is my son', 'what's my wife's name') — answer from 'Your people'.`,
      `  • Style / identity questions — answer from 'Who you are'.`,
      `  • Conversational follow-ups that don't need fresh data.`,
      `Call tools only when you actually need data the profile doesn't have. The full toolkit:`,
      `  • search_personal_files / read_personal_file — Mac files. Passport, license, green card, I-485, taxes, receipts, insurance, visas. PDFs/images OCR'd.`,
      `  • list_imessage_groups / get_imessage_group — chat.db iMessage GROUPS. Find a trip/family group by name, then pull members.`,
      `  • search_imessage_history — chat.db messages (DMs + groups). Filter by keyword, date range, contact handle, groupOnly.`,
      `  • list_whatsapp_groups / get_whatsapp_group — WhatsApp GROUPS. Find a group by name, then pull members.`,
      `  • search_whatsapp_history — WhatsApp messages (DMs + groups). Filter by keyword, date range, jid, fromContact.`,
      `  • backfill_whatsapp_history — when search_whatsapp_history returns empty for an older date range, call this with the group jid to fetch older messages from WhatsApp. Use ONCE per group per session.`,
      `  • gmail_search / gmail_list_messages — appointment confirmations, receipts, orders, doctor visits.`,
      `  • google-calendar_list_events — anything time-bound, next 30 days.`,
      ``,
      `# Multi-source playbook`,
      `1. 'Who came on X trip' / 'who's in X group' →`,
      `   a. list_whatsapp_groups + list_imessage_groups in PARALLEL.`,
      `   b. find the group whose name contains the trip/topic.`,
      `   c. get_whatsapp_group(name=…) / get_imessage_group(name=…) for the FULL members.`,
      `   d. cross-check with personal-docs (visa/insurance often lists travelers).`,
      `   e. answer with ALL the people from the group, not just docs.`,
      `2. 'During my X trip' →`,
      `   a. narrow date range from concrete source (visa, calendar, flight email).`,
      `   b. search_imessage_history + search_whatsapp_history + gmail_search across that range IN PARALLEL.`,
      `   c. synthesize across all three; never stop at the first source.`,
      ``,
      `Never reply "I can't access your files/emails/messages" — the tools are right here.`,
      ``,
      `# Honesty about what you checked (HARD RULE — never give a false "not found")`,
      `  • Context blocks below (device calendar, roster, appointment sources) are COMPLETE and AUTHORITATIVE for what they cover — if the answer is in a present block, use it.`,
      `  • The "device calendar" block is the SOURCE OF TRUTH for appointments (iCloud + Google + subscribed). If it's present, trust it over Gmail/files for "do I have an appointment".`,
      `  • You may ONLY say something doesn't exist ("no haircut appointment", "no such event") if the AUTHORITATIVE source for it is present below AND empty of it. If that source is ABSENT (not loaded this turn), do NOT deny it exists — say you'll check / ask a clarifying question instead. A confident "not found" when you didn't actually look is the worst failure.`,
      `  • Prefer "I don't see one on your calendar for the next N days" (scoped to what you checked) over a blanket "you have no appointment".`,
      ``,
      `# Voice`,
      `  • Direct answer first, lowercase, conversational. 1-3 short lines max.`,
      `  • No "I'd be happy to" / "feel free" / "certainly" — sound like ${ownerName}.`,
      `  • State the FACT when you have it.`,
      ``,
      `# Agentic follow-ups (mandatory when applicable)`,
      `  • Answer mentions an EXPIRY / DEADLINE → end with ONE short question offering a calendar reminder ~60 days before.`,
      `  • Answer mentions a NUMBER worth remembering (passport #, license #) → offer to save as Note.`,
      `  • Answer references a FILE → offer to attach it.`,
      ``,
      `# Actions — emit ONE marker per action on its own line at the END`,
      `  • Attach file:    [ATTACH:/absolute/path]  (COPY paths from read_personal_file — never invent)`,
      `  • Calendar event: [CALENDAR:Title|2026-08-19T09:00:00|2026-08-19T10:00:00|Optional notes]`,
      `  • Note:           [NOTE:Title|Body text]`,
      `  • Mail draft:     [MAIL:to@x.com|Subject|Body]`,
      `  • Phone call:     [CALL:Manasa|conference|why you're calling]   (mode = conference | voicemail | task)`,
      `CALLS: when ${ownerName} asks you to call / phone / dial / ring / conference / reach someone (ANY phrasing, any language, typos and all — e.g. "call manu", "conference me withe manmanu", "can you ring her") you MUST emit a [CALL:...] marker. The bridge places the real call via Twilio and asks ${ownerName} to confirm before dialing. NEVER say "I'll call" / "calling her" / "will do" WITHOUT the [CALL:...] marker — a reply that claims a call without the marker is a lie, because no call happens. "conference me with X" → mode conference. "leave X a voicemail saying Y" → mode voicemail, message Y. "call the pharmacy to refill" → mode task, message the task. Use the contact's real name as target; the bridge resolves it to a number.`,
      `OFFER-then-CONFIRM applies ONLY to state-modifying actions (calendar, note, mail). For READ operations (search, list, look up, find), NEVER ask permission — just execute and report results. The user already asked; asking "shall I search?" is wasted turns.`,
      `For ROSTER questions ("who came on X", "who's in X"): the group rosters above are the truth. If a member appears as "(name unknown — group privacy)", that's WhatsApp's new privacy-preserving identifier (@lid) — we genuinely don't have their name because they haven't DM'd us. State the FULL roster size from the group AND list every name we DO have; for the rest say "N others (WhatsApp doesn't expose names of non-contacts in groups, unless they DM you)". Their PARTICIPATION in the group still proves they were on the trip. Do NOT ask the user if they want you to search further; if you can search WhatsApp/iMessage history for the trip date range, JUST DO IT in this same turn.`,
      apptBlock ? "\n" + apptBlock : "",
      rosterBlock ? "\n" + rosterBlock : "",
      planBlock ? "\n" + planBlock : "",
    ].filter(Boolean).join("\n");

    // First attempt + silent auto-retry on null (timeout / transient).
    let draft = await this.agent.respondTo(jid, query, systemHint, { withTools: true });
    if (!draft) {
      this.logger.warn({ totalMs: Date.now() - startedAt }, "agent returned null — retrying once");
      draft = await this.agent.respondTo(jid, query, systemHint, { withTools: true });
    }

    clearTimeout(thinkingTimer);
    this.logger.info({ totalMs: Date.now() - startedAt, hadDraft: !!draft, thinkingSent }, "doc query done (whatsapp)");
    if (!draft) {
      await this.confirmToSelf("hmm, that one took longer than I'd like. give me another minute and ask again");
      return;
    }

    const { cleanedText: textNoAttach, paths } = extractAttachMarkers(draft);
    const { cleanedText: finalText, calendarEvents, notes, mailDrafts, calls } = extractActionMarkers(textNoAttach);
    // Humanize: friendly dates + guaranteed offer + deterministic
    // execution path on next-turn confirmation.
    const { reply: polished, offer } = humanizeWithOffer(finalText);
    if (polished) {
      await this.confirmToSelf(polished);
      // SELF-EVAL — record so 🔁 / 🤦 can re-prompt with critique.
      if (this.lastSelfSentMsgId) {
        this.recordReplyMeta(this.lastSelfSentMsgId, {
          jid,
          inboundText: query,
          replyText: polished,
          systemHint,
          surface: "owner-self-chat",
        });
      }
    }
    if (offer && jid) {
      // Attach context for freeform-followup offers so the
      // confirmation-execute path can re-prompt the LLM correctly.
      if (offer.kind === "freeform-followup") {
        offer.freeformInbound = query;
        offer.freeformPriorReply = polished;
      }
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
    // Outbound calls — LLM emitted a [CALL:...] marker. Route through the
    // real Twilio orchestrator (risk-tier classify → pre-flight summary →
    // owner ack → dial). Runs regardless of macActions (calls are Twilio,
    // not AppleScript). This is the intelligent replacement for the brittle
    // "call X" regexes: the model understands intent in any phrasing.
    for (const c of calls) {
      try {
        this.logger.info({ target: c.target, mode: c.mode }, "LLM [CALL] marker → outbound orchestrator");
        const res = await this.placeOutboundCallFromOwner({
          intent: c.mode,
          target: c.target,
          message: c.message,
          reason: c.message,
          chatJid: jid,
        });
        if (!res.ok) {
          await this.confirmToSelf(`(couldn't set up the call — ${res.reason || "unknown"})`);
        }
      } catch (err) {
        this.logger.warn({ err, target: c.target }, "outbound [CALL] marker exception");
        await this.confirmToSelf(`(call failed — ${(err as Error).message})`);
      }
    }
    } finally {
      this.busyChat.delete(jid);
      // Drain queued next-query (latest-wins).
      const queued = this.queuedQuery.get(jid);
      if (queued) {
        this.queuedQuery.delete(jid);
        const age = Date.now() - queued.queuedAt;
        if (age < WhatsAppSession.QUEUED_QUERY_TTL_MS) {
          this.logger.info({ jid, ageMs: age, textPreview: queued.text.slice(0, 60) }, "draining queued query");
          // Synthesize a minimal `key` placeholder — the real Baileys
          // key for the QUEUED message isn't carried through. The
          // doc-query path uses `key` only for sendReaction; safely
          // skip the reaction if id is missing (sendReaction is best-
          // effort already).
          void this.handleOwnerDocQuery(jid, queued.text, { id: null, remoteJid: jid, fromMe: true, participant: null });
        } else {
          this.logger.info({ jid, ageMs: age }, "dropping queued query — too old");
        }
      }
    }
  }

  // Execute a cached offer (calendar reminder / save note / outbound call).
  // Deterministic, bypasses the LLM. Sends a natural confirmation.
  private async executeCachedOffer(jid: string, offer: PendingOffer): Promise<void> {
    // Outbound calls go through Twilio, NOT macActions — handle them before
    // the macActions guard so a "yes" can never be silently swallowed if
    // macActions is ever unavailable (e.g. a headless deployment).
    if (offer.kind === "outbound-call" && (offer as any).callRequest && (offer as any).callPlan) {
      try {
        const { placeCallNow } = await import("@lantern/bridge-core/call-orchestrator");
        const deps = this.lastCallDeps;
        if (!deps) {
          await this.confirmToSelf("(can't place the call — orchestrator deps missing, ask me again)");
          return;
        }
        const res = await placeCallNow((offer as any).callRequest, (offer as any).callPlan, deps);
        if (!res.ok) await this.confirmToSelf(`(couldn't place call: ${res.reason || "unknown"})`);
      } catch (err) {
        this.logger.error({ err }, "outbound-call offer execution failed");
        await this.confirmToSelf(`(call failed — ${(err as Error).message})`);
      }
      return;
    }
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
    // (outbound-call is handled at the TOP of this method, before the
    // macActions guard — see above.)

    // Freeform follow-up — bot offered something arbitrary ("attach
    // the receipt", "forward the link") and owner confirmed. Re-prompt
    // the LLM with the original context + an explicit fulfillment
    // instruction. Routes through the agentic doc-query path so tools
    // are attached.
    if (offer.kind === "freeform-followup" && offer.freeformAction) {
      this.logger.info(
        { jid, action: offer.freeformAction.slice(0, 80) },
        "executing freeform-followup — re-prompting LLM to fulfill",
      );
      const fulfillmentText = [
        `[CONFIRMED ACTION: ${offer.freeformAction}]`,
        offer.freeformInbound ? `Original ask: ${offer.freeformInbound}` : "",
        offer.freeformPriorReply ? `Your prior reply (containing the offer): ${offer.freeformPriorReply}` : "",
        "",
        `The owner just said YES to your offer. Now FULFILL it: call the right tool (gmail_search, calendar lookup, attach file, etc.) and deliver the result. Don't re-offer; don't ask for permission. Execute and reply with what you found / did.`,
      ].filter(Boolean).join("\n");
      void this.handleOwnerDocQuery(jid, fulfillmentText, "" as any);
      return;
    }
  }

  // Owner free-form chat handler. Same shape as iMessage's — agent
  // round-trip with a Jarvis-tuned prompt so the owner channel
  // doubles as a chatbot on top of commands + docs.
  private async handleOwnerNaturalChat(jid: string, text: string): Promise<void> {
    this.busyChat.add(jid);
    try {
    const today = new Date().toISOString().slice(0, 10);
    const hour = new Date().getHours();
    const timeOfDay = hour < 5 ? "late night" : hour < 12 ? "morning" : hour < 17 ? "afternoon" : hour < 22 ? "evening" : "late night";
    const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];

    // Pre-fetch Gmail + Calendar for appointment-style queries so
    // the LLM receives all live data up-front and just synthesizes.
    let prefetchBlock = "";
    if (looksLikeAppointmentQuery(text)) {
      try {
        const client = defaultConnectorClient(this.logger);
        const block = await prefetchAppointmentContext(client, text, this.logger);
        if (block) prefetchBlock = block;
      } catch (err) {
        this.logger.warn({ err }, "wa prefetch failed (continuing without)");
      }
    }

    // Language modality: owner self-chat respects the language he
    // typed in. If he asks in Telugu, reply in Telugu (Telangana
    // dialect, owner vocab preferences from profile).
    const langHint = detectLanguageHints(text);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    const ownerProfileProse = this.ownerProfileStore.prose();
    const systemHint = [
      `You are Lantern — ${ownerName}'s personal agent, replying in his WhatsApp self-chat.`,
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
      // STREAMING path — only for the natural-chat surface (no tools,
      // pure synthesis). The agentic doc-query path uses respondTo
      // (with tools) and is untouched. Streaming opt-out via env in
      // case any provider stream chokes mid-rollout.
      const streamEnabled = (process.env.LANTERN_JARVIS_STREAM ?? "on").toLowerCase() !== "off";
      if (streamEnabled) {
        const streamT0 = Date.now();
        let firstChunkAt = 0;
        let firstSentText = ""; // EXACT text we sent as the first chunk
        let buffer = "";
        // First-sentence terminator: . ? ! followed by whitespace OR end.
        // Use a regex that matches all three terminators — the prior
        // code used indexOf(".") which silently failed for the much-
        // more-common "?" / "!" endings, causing the remainder calc
        // to slice from offset 0 and re-send the whole message.
        const sendFirstSentenceIfReady = async () => {
          if (firstSentText) return;
          const m = buffer.match(/^[\s\S]*?[.!?](?=\s|$)/);
          if (!m) return;
          const first = m[0].trim();
          if (first.length < 12) return; // too short, wait for more
          firstSentText = first;
          this.logger.info({ jid, firstLen: first.length }, "jarvis-stream: first sentence");
          await this.confirmToSelf(first);
          if (this.lastSelfSentMsgId) {
            this.recordReplyMeta(this.lastSelfSentMsgId, {
              jid,
              inboundText: text,
              replyText: first,
              systemHint,
              surface: "owner-self-chat",
            });
          }
        };
        // SPEED MATTERS for natural-chat. Force a fast model:
        // - Opus 4.8 (the default 'auto') takes 5-15s for trivial
        //   conversational replies — overkill for "hi" → "hey".
        // - Sonnet 4.6 is the sweet spot: ~1-2s, conversational
        //   quality indistinguishable from opus at this length.
        // - Override per-deploy via LANTERN_NATURAL_CHAT_MODEL
        //   (e.g., "claude-haiku-4-5-20251001" for sub-second).
        const fastModel =
          process.env.LANTERN_NATURAL_CHAT_MODEL ||
          "reasoning-large"; // resolves to sonnet
        const draft = await this.agent.respondToStream(systemHint, text, (chunk) => {
          if (!firstChunkAt) firstChunkAt = Date.now() - streamT0;
          buffer += chunk;
          if (!firstSentText && buffer.length > 30) {
            // Async fire-and-forget — don't block the stream consumer.
            void sendFirstSentenceIfReady().catch(() => {});
          }
        }, { model: fastModel });
        this.logger.info(
          { jid, model: fastModel, firstChunkAt, totalMs: Date.now() - streamT0, draftLen: (draft || "").length, firstSentEarly: !!firstSentText },
          "jarvis-stream: done",
        );
        const clean = (draft || "").trim();
        if (!clean) return;
        if (!firstSentText) {
          // Never sent the first chunk early — send the whole thing.
          await this.confirmToSelf(clean);
          if (this.lastSelfSentMsgId) {
            this.recordReplyMeta(this.lastSelfSentMsgId, {
              jid,
              inboundText: text,
              replyText: clean,
              systemHint,
              surface: "owner-self-chat",
            });
          }
        } else {
          // Already sent firstSentText. Compute the REMAINDER as the
          // portion of `clean` after that exact prefix. Tolerate
          // whitespace differences (trim variants from the LLM).
          let remainder = "";
          if (clean.startsWith(firstSentText)) {
            remainder = clean.slice(firstSentText.length).trim();
          } else {
            // The LLM rephrased its own first sentence between stream
            // and end (rare) — try substring fallback.
            const idx = clean.indexOf(firstSentText);
            if (idx >= 0) {
              remainder = clean.slice(idx + firstSentText.length).trim();
            } else {
              // Couldn't locate the first sentence in the final — give
              // up on the remainder rather than risk duplicating.
              this.logger.warn(
                { jid, firstSentText: firstSentText.slice(0, 60), cleanPreview: clean.slice(0, 80) },
                "jarvis-stream: first sentence not found in final draft — skipping remainder",
              );
              return;
            }
          }
          // Send only if substantively more content (>=25 chars).
          if (remainder.length >= 25) {
            await this.confirmToSelf(remainder);
          }
        }
        return;
      }

      // Non-streaming fallback (kept for env-disabled deployments).
      const draft = await this.agent.respondTo(jid, text, systemHint, { withTools: true });
      if (!draft) return;
      const clean = draft.trim();
      await this.confirmToSelf(clean);
      if (this.lastSelfSentMsgId) {
        this.recordReplyMeta(this.lastSelfSentMsgId, {
          jid,
          inboundText: text,
          replyText: clean,
          systemHint,
          surface: "owner-self-chat",
        });
      }
    } catch (err) {
      this.logger.warn({ err, jid }, "owner natural chat exception (whatsapp)");
    }
    } finally {
      this.busyChat.delete(jid);
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
      if (sent?.key?.id) {
        this.bridgeSentIds.set(sent.key.id, Date.now());
        // Best-effort retry-tracking: confirmToSelf is called from many
        // sites with no inbound context (status echoes, system acks),
        // so we don't have a meaningful inboundText to record. The
        // call sites that DO have one (handleOwnerNaturalChat /
        // handleOwnerDocQuery) call recordReplyMeta directly via the
        // sentSelfWithMeta helper below.
        this.lastSelfSentMsgId = sent.key.id;
      }
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

  // Record the metadata of a bot reply so 🔁 / 🤦 reactions can
  // later look up what we sent + why and re-prompt the LLM with a
  // critique. Called at every owner-facing send site that wants to
  // be retry-able. Capped FIFO (oldest dropped at REPLY_META_MAX).
  private recordReplyMeta(
    sentMsgId: string,
    meta: {
      jid: string;
      inboundText: string;
      replyText: string;
      systemHint: string;
      surface: "contact-reply" | "owner-self-chat";
    },
  ): void {
    if (!sentMsgId) return;
    this.bridgeReplyMeta.set(sentMsgId, { ...meta, ts: Date.now() });
    if (this.bridgeReplyMeta.size > WhatsAppSession.REPLY_META_MAX) {
      const it = this.bridgeReplyMeta.keys();
      const drop = this.bridgeReplyMeta.size - WhatsAppSession.REPLY_META_MAX;
      for (let i = 0; i < drop; i++) {
        const k = it.next().value;
        if (k) this.bridgeReplyMeta.delete(k);
      }
    }
  }

  // 👎 / ❌ on a bot reply: record the dislike for permanent calibration
  // and acknowledge to the owner — WITHOUT retrying/sending anything into
  // the contact thread. This is the lightweight counterpart to the 🔁
  // retry path: "noted, learn from it" vs "noted, try again now".
  private async recordDislikeFromReaction(jid: string, msgId: string | undefined): Promise<void> {
    this.logger.info({ jid, msgId }, "self-eval: 👎 negative feedback");
    this.logActivity("attention_dm", "👎 owner flagged a bad reply", { jid, scope: "self" });
    const meta = msgId ? this.bridgeReplyMeta.get(msgId) : undefined;
    if (!meta) {
      // Reply-meta aged out or predates the last restart — still acknowledge
      // so the owner sees the thumbs-down registered.
      try { await this.confirmToSelf("👎 noted — what was off about that one?"); } catch {}
      return;
    }
    void this.dislikeMemory.record({
      jid: meta.jid,
      inbound: meta.inboundText,
      badReply: meta.replyText,
      channel: "whatsapp",
    });
    try { await this.confirmToSelf("👎 noted — I'll steer clear of that next time."); } catch {}
  }

  // SELF-EVAL retry: full critique-and-rewrite pipeline.
  // On 🔁 / 🤦 from the owner on a bot reply, re-prompt the LLM with:
  //   - the original inbound (what the contact / owner said)
  //   - the prior bad reply
  //   - a critique instruction ("the user disliked this — analyze
  //     why in one private sentence, then write a better version")
  // Send the better version as a follow-up. WhatsApp doesn't reliably
  // support editing arbitrary outbound messages, so we don't try to
  // replace the original — appending the corrected version preserves
  // conversation continuity AND leaves a paper trail.
  private async handleBadFeedbackRetry(jid: string, msgId: string | undefined): Promise<void> {
    this.logger.info({ jid, msgId }, "self-eval: 🔁 bad-feedback signal");
    this.logActivity("attention_dm", "🔁 owner flagged bad reply — retrying", {
      jid, scope: "self",
    });

    const meta = msgId ? this.bridgeReplyMeta.get(msgId) : undefined;
    if (!meta) {
      // No stored meta — earliest entries may have aged out, or this
      // was a one-off send (status echo, ack, etc.) that we don't
      // retry-track. Fall back to just acknowledging the signal.
      try { await this.confirmToSelf("noted — what was off?"); } catch {}
      return;
    }
    // Permanent calibration: persist (inbound, bad-reply) so future
    // replies to this contact AVOID the same shape. Patched with the
    // accepted retry below.
    void this.dislikeMemory.record({
      jid: meta.jid,
      inbound: meta.inboundText,
      badReply: meta.replyText,
      channel: "whatsapp",
    });

    try {
      const critiqueSystemHint = [
        meta.systemHint,
        "",
        "## CRITIQUE-AND-RETRY MODE",
        "The owner just flagged your previous reply as bad. Re-read the inbound + your prior reply below.",
        "",
        "Step 1 (silent — DO NOT include in your output): briefly identify what was wrong about the prior reply. Common failure modes: too long, too formal, wrong language/script, missed nuance, recited generic info instead of using profile/tools, hallucinated facts, sounded like a bot.",
        "Step 2: produce a SINGLE corrected reply that fixes the failure. Keep the same intent (answer the same question) but execute it the way the owner actually would.",
        "",
        `Original inbound: ${meta.inboundText}`,
        `Your prior reply (rated bad): ${meta.replyText}`,
        "",
        "Output ONLY the corrected reply. No preface, no explanation, no markdown headers.",
      ].join("\n");

      const retried = await this.agent.respondTo(
        jid,
        meta.inboundText,
        critiqueSystemHint,
        { withTools: false }, // critique should fix style/clarity, not run more tool calls
      );

      if (!retried || retried.trim().length === 0) {
        await this.confirmToSelf("(couldn't generate a better version — try rephrasing your ask)");
        return;
      }

      // Send the retried version. For owner-self-chat we send to
      // self; for contact-reply we send back to the contact thread.
      const sendJid = meta.surface === "contact-reply" ? meta.jid : jid;
      const sent = await this.socket?.sendMessage(sendJid, { text: retried.trim() });
      if (sent?.key?.id) {
        this.bridgeSentIds.set(sent.key.id, Date.now());
        // Also retry-track THIS reply so the owner can 🔁 again if
        // V2 is also bad (3 strikes and they probably need to give
        // up + rephrase the original ask).
        this.recordReplyMeta(sent.key.id, {
          jid: meta.jid,
          inboundText: meta.inboundText,
          replyText: retried.trim(),
          systemHint: meta.systemHint,
          surface: meta.surface,
        });
      }
      // Patch the dislike record with the accepted correction so
      // future prompts can show BAD + GOOD for contextual calibration.
      void this.dislikeMemory.patchLastWithGood(meta.jid, retried.trim());
      this.logger.info({ jid, originalMsgId: msgId, retriedLength: retried.length }, "self-eval: retry delivered");
    } catch (err) {
      this.logger.warn({ err, jid, msgId }, "self-eval retry exception");
      try { await this.confirmToSelf("(retry hit an error — try again in a sec)"); } catch {}
    }
  }

  // Multi-channel owner escalation. Used for life-threat,
  // prompt-injection, and relay-promise events. Fires:
  //   1. WhatsApp self-chat (sendSelf) — primary, highest reliability
  //   2. iMessage self-chat via the iMessage bridge's loopback (if up)
  //   3. Email via Gmail connector (lantern-self label, IN inbox so
  //      it grabs attention — NOT skip-inbox like normal status mail)
  //   4. macOS notification via osascript (best-effort, surfaces on
  //      the Mac dock even when the owner is heads-down in another app)
  //
  // All channels fired in parallel. None block the bot's reply path.
  // Failures log a warning but never throw — escalation is best-effort
  // across channels, not all-or-nothing.
  private async fireOwnerEscalation(opts: {
    kind: "life-threat" | "prompt-injection" | "relay-promise";
    reason: string;
    from: string;
    senderName?: string;
    contactText: string;
    botReplyPreview?: string;
  }): Promise<void> {
    // Cooldown/dedup — suppress the same (kind, sender, reason) within the
    // window so a hostile or quoted message can't weaponize the escalation
    // into call + siren spam. Cleanup keeps the map from growing unbounded.
    const dedupKey = `${opts.kind}:${opts.from}:${opts.reason}`;
    const now = Date.now();
    const last = this.escalationLastFired.get(dedupKey);
    if (last !== undefined && now - last < WhatsAppSession.ESCALATION_COOLDOWN_MS) {
      this.logger.warn(
        { kind: opts.kind, reason: opts.reason, from: opts.from, sinceMs: now - last },
        "owner escalation suppressed (cooldown) — duplicate within window",
      );
      return;
    }
    this.escalationLastFired.set(dedupKey, now);
    if (this.escalationLastFired.size > 256) {
      for (const [k, t] of this.escalationLastFired) {
        if (now - t > WhatsAppSession.ESCALATION_COOLDOWN_MS) this.escalationLastFired.delete(k);
      }
    }

    const who = opts.senderName || opts.from.split("@")[0];
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

    // 1. WhatsApp self-chat — primary.
    void this.sendSelf(body).catch((err) =>
      this.logger.warn({ err, kind: opts.kind }, "owner escalation: WA self-chat failed"),
    );

    // 2. iMessage loopback — secondary channel. Fire-and-forget HTTP
    // to the iMessage bridge on localhost:3200. Owner gets the same
    // alert on their Mac's iMessage.app.
    const imUrl = process.env.LANTERN_IMESSAGE_BRIDGE_URL || "http://127.0.0.1:3200";
    const tenantId = process.env.LANTERN_DEFAULT_TENANT_ID || "00000000-0000-0000-0000-000000000001";
    void (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        await fetch(`${imUrl}/session/${tenantId}/send-self`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: body }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
      } catch (err) {
        this.logger.debug({ err }, "owner escalation: iMessage loopback skipped");
      }
    })();

    // 3. Email mirror via Gmail connector. Skip-inbox=false so it
    // lands in the primary inbox (this is the one type of bot mail
    // we WANT to interrupt).
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

    // 4. macOS desktop notification — surfaces on the Mac even when
    // the owner is heads-down. Cheap; best-effort. Only fires for
    // life-threat (we don't want injection probes to pop a dialog
    // every time someone tests).
    // Panic channels (macOS notif + voice + pushover) are gated by the
    // master `escalationEnabled` toggle so the owner can mute the siren
    // batch without losing primary alerts (WA/iM/email always fire).
    if (opts.kind === "life-threat" && this.escalationEnabled) {
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
    }

    // 5. OUTBOUND VOICE CALL via Twilio — life-threat only. Actually
    // rings the owner's phone with a TwiML <Say> reading out the
    // sender + their message. This is the channel that survives
    // a backgrounded phone, focus mode, and a screen-off device.
    //
    // Requires:
    //   - LANTERN_OWNER_PHONE env (E.164, e.g. "+15126088977")
    //   - Twilio connector installed with accountSid/authToken/from
    // If either is missing we silently skip — the other 4 channels
    // still deliver the alert.
    if (opts.kind === "life-threat" && this.escalationEnabled) {
      void (async () => {
        try {
          const ownerPhone = process.env.LANTERN_OWNER_PHONE;
          if (!ownerPhone) {
            this.logger.warn(
              "owner escalation: LANTERN_OWNER_PHONE not set — voice call skipped (other channels still firing)",
            );
            return;
          }
          const { authedFetch } = await import("@lantern/bridge-core/auth");
          // Pull the Twilio "from" number directly from the
          // connector config so we don't duplicate it in env.
          const listRes = await authedFetch("/v1/connectors");
          if (!listRes.ok) {
            this.logger.warn(
              { status: listRes.status },
              "owner escalation: couldn't fetch connectors for Twilio from-number",
            );
            return;
          }
          const installs = (await listRes.json()) as Array<{ connectorId: string; config?: Record<string, unknown> }>;
          const twilio = installs.find((i) => i.connectorId === "twilio");
          const twilioFrom = twilio?.config?.phoneNumber as string | undefined;
          if (!twilio || !twilioFrom) {
            this.logger.warn(
              "owner escalation: Twilio connector not configured — voice call skipped",
            );
            return;
          }
          // Speak the alert. Tight + actionable — Twilio Say tops out
          // around 4000 chars but readability drops fast past 200.
          const senderLabel = who.replace(/[^A-Za-z0-9\s]/g, " ").trim() || "an unknown contact";
          const safeMsg = opts.contactText.replace(/\s+/g, " ").slice(0, 400);
          const speech = `This is Lantern, an urgent alert. ${senderLabel} just messaged you saying: ${safeMsg}. They said it is an emergency. Please open WhatsApp now.`;
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
              "owner escalation: Twilio voice call FAILED",
            );
          } else {
            this.logger.info(
              { to: ownerPhone.slice(0, 6) + "***", from: twilioFrom },
              "owner escalation: Twilio voice call placed",
            );
          }
        } catch (err) {
          this.logger.error({ err }, "owner escalation: Twilio voice call exception");
        }
      })();
    }

    // 6. PUSHOVER PRIORITY-2 push — pierces iPhone silent + Do Not
    // Disturb with a siren-style alert that repeats every 30s until
    // the owner ack's. Works as a no-Twilio alternative for ringing
    // the phone. Requires LANTERN_PUSHOVER_TOKEN (app API key) and
    // LANTERN_PUSHOVER_USER (user key) in env. Both come from
    // pushover.net dashboard. Skipped silently when either is unset
    // OR when the master escalationEnabled / pushoverEnabled is off.
    if (opts.kind === "life-threat" && this.escalationEnabled && this.pushoverEnabled) {
      void (async () => {
        try {
          const token = process.env.LANTERN_PUSHOVER_TOKEN;
          const user = process.env.LANTERN_PUSHOVER_USER;
          if (!token || !user) return;
          const senderLabel = who.replace(/[^A-Za-z0-9\s]/g, " ").trim() || "an unknown contact";
          const msg = `${senderLabel} flagged an emergency. They said: "${opts.contactText.slice(0, 400)}"`;
          // Priority 2 = emergency — Pushover keeps re-alerting on
          // the device every `retry` seconds (min 30) until either
          // the user acks OR `expire` seconds (max 10800) elapse.
          // We use 30s retry / 3600s expire so it nags for an hour
          // unless ack'd. Sound "siren" overrides phone silent mode.
          const body = new URLSearchParams({
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
            body: body.toString(),
          });
          if (!res.ok) {
            const txt = await res.text();
            this.logger.error(
              { status: res.status, body: txt.slice(0, 200) },
              "owner escalation: Pushover send FAILED",
            );
          } else {
            this.logger.info(
              "owner escalation: Pushover priority-2 alert sent",
            );
          }
        } catch (err) {
          this.logger.error({ err }, "owner escalation: Pushover exception");
        }
      })();
    }

    this.logger.info(
      { kind: opts.kind, reason: opts.reason, from: opts.from },
      "owner escalation fired",
    );
    this.logActivity("attention_dm", `🚨 ${opts.kind} escalation: ${opts.reason}`, {
      jid: opts.from,
      pushName: opts.senderName,
      scope: "self",
    });
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

    // ─────────────────────────────────────────────────────
    // SAFETY GUARDS — run BEFORE the LLM so the bot can't
    // be social-engineered into wrong behavior.
    //
    // 1. Life-threat inbound → immediately page the owner
    //    on every channel, send a short truthful reply
    //    that includes 911 redirect. NEVER let the LLM
    //    handle this alone — empathy theater without an
    //    actual escalation kills people.
    // 2. Prompt-injection probe ("forgot all instructions",
    //    "are you an AI", money probe, access probe) →
    //    refuse + escalate. Don't engage.
    // ─────────────────────────────────────────────────────
    if (!opts.isGroup) {
      const ownerName = (process.env.LANTERN_OWNER_NAME || "Shekhar").split(/\s+/)[0];
      const lifeThreat = detectLifeThreat(text);
      if (lifeThreat) {
        this.logger.warn(
          { from, reason: lifeThreat.reason, pattern: lifeThreat.pattern, textPreview: text.slice(0, 140) },
          "🚨 LIFE-THREAT detected — escalating to owner on every channel",
        );
        await this.fireOwnerEscalation({
          kind: "life-threat",
          reason: lifeThreat.reason,
          from,
          senderName: opts.senderName,
          contactText: text,
        });
        try {
          const reply = escalationRefusalReply("life-threat", ownerName);
          await this.sendMessage(from, reply);
        } catch (err) {
          this.logger.error({ err, from }, "life-threat refusal send failed");
        }
        return;
      }

      const injection = detectPromptInjection(text);
      if (injection) {
        this.logger.warn(
          { from, reason: injection.reason, pattern: injection.pattern, textPreview: text.slice(0, 140) },
          "🛡 PROMPT-INJECTION detected — refusing + escalating",
        );
        await this.fireOwnerEscalation({
          kind: "prompt-injection",
          reason: injection.reason,
          from,
          senderName: opts.senderName,
          contactText: text,
        });
        try {
          await this.sendMessage(from, escalationRefusalReply("prompt-injection", ownerName));
        } catch (err) {
          this.logger.error({ err, from }, "prompt-injection refusal send failed");
        }
        return;
      }
    }

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
    // Owner profile + relationship — the "sounds like me" context.
    const ownerProfile = this.ownerProfileStore.prose();
    const relationship = opts.isGroup
      ? undefined
      : this.ownerProfileStore.relationshipFor(from, opts.senderName ?? this.contactNames.get(from));
    // Recent thread context. WhatsApp has no chat.db, so we interleave the
    // bridge's captured inbound (them) + owner-sent (you) tails into a
    // rough recent transcript. Grounds the reply in what's being discussed
    // rather than answering the last line in a vacuum.
    const recentTranscript = this.buildRecentTranscript(from, opts.isGroup);
    // Detect inbound language so the reply can match it (script + dialect).
    // Bias the dialect by the owner's nativity (parsed from their profile).
    const langHint = detectLanguageHints(text);
    const nativity = this.ownerProfileStore.nativity();
    const languageModality = languageModalityHint(langHint, { nativity });
    if (languageModality) {
      this.logger.info(
        { from, lang: langHint.primary, confidence: langHint.confidence, nativeScript: langHint.hasNativeScript, romanized: langHint.hasRomanized },
        "language-modality engaged",
      );
    }
    // World-class authenticity blocks. Each best-effort with empty
    // fallback so cold contacts and groups keep prior behavior.
    const contactStyleBlock = !opts.isGroup ? styleBlockFor(ownerSamples) : "";
    const dislikeEntries = !opts.isGroup ? await this.dislikeMemory.forJid(from, 3) : [];
    const dislikeBlock = formatDislikeBlock(dislikeEntries);
    const episodes = !opts.isGroup ? await this.episodicMemory.forJid(from, 5) : [];
    // Cross-contact recall: pull episodes from OTHER chats (most
    // importantly self-chat) that mention this contact by first name.
    // This is how "Sujith was here this weekend" — said in self-chat —
    // surfaces when Sujith messages two days later.
    const contactFirstNames: string[] = [];
    const senderName = opts.senderName || this.contactNames.get(from);
    if (senderName && !opts.isGroup) {
      const first = senderName.split(/\s+/)[0]?.toLowerCase();
      if (first && first.length >= 2) contactFirstNames.push(first);
    }
    const mentionEpisodes = !opts.isGroup && contactFirstNames.length > 0
      ? await this.episodicMemory.forMentions(contactFirstNames, { excludeJid: from, limit: 3, maxAgeDays: 30 })
      : [];
    const allEpisodes = [...episodes, ...mentionEpisodes]
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 6);
    const episodesBlock = formatEpisodesBlock(allEpisodes);
    // Ambiguity-guardrail signal: if the inbound is short AND we have
    // no recent context for this contact, the persona prompt should
    // suppress speculative forward commitments. We pass this as a
    // hint via the stylePrompt-merge path so the model gets a clear
    // "don't invent plans" instruction inline.
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    const lowContext =
      !opts.isGroup &&
      wordCount <= 6 &&
      allEpisodes.length === 0 &&
      dislikeEntries.length === 0 &&
      (!recentTranscript || recentTranscript.trim().length < 20);
    const inboundTopics = !opts.isGroup ? extractTopics(text) : [];
    const related = !opts.isGroup && inboundTopics.length > 0
      ? await this.socialGraph.related({ topics: inboundTopics, excludeJid: from, limit: 4 })
      : [];
    const relatedBlock = formatRelatedBlock(related);
    if (!opts.isGroup && inboundTopics.length > 0) {
      void this.socialGraph.record({
        jid: from,
        contactName: opts.senderName ?? this.contactNames.get(from),
        text: text.slice(0, 200),
        fromMe: false,
        topics: inboundTopics,
      });
    }
    const presenceSnap = await this.presence.current({
      nextEvent: async () => {
        try { return await this.calendar.nextMeetingWindow?.(); } catch { return null; }
      },
    });
    let presenceLine = presenceSnap.line || "";
    // AWAY directive: when the owner set a status, tell the contact where he
    // is + that he'll get back, and offer to take a message. This is the
    // "Shekhar's at the temple right now, can I pass a message?" behavior.
    if (presenceSnap.away && !opts.isGroup) {
      const where = presenceSnap.place ? `at ${presenceSnap.place}` : presenceSnap.line;
      presenceLine =
        `${ownerName} is ${where} right now and away from messages. ` +
        `If this needs ${ownerName}, tell them warmly that he's ${where} and will get back to them` +
        (presenceSnap.takeMessage
          ? `, then OFFER to take a message ("want me to pass anything along?"). If they leave one, acknowledge you'll make sure ${ownerName} gets it.`
          : `.`) +
        ` Keep it short and natural — don't pretend to be ${ownerName} mid-activity.`;
    }

    let systemHint = agentPersonaPrompt(
      ownerName,
      style,
      !!opts.isGroup,
      {
        ownerSamples,
        disclosed: this.disclosedJids.has(from),
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
      }
    );

    // Inject durable contact facts ("her daughter is Maya", "works at
    // Stripe") so the assistant doesn't cold-start each conversation.
    // Empty string when no facts exist — zero overhead.
    if (!opts.isGroup) {
      // Unified cross-channel memory: facts + semantically-relevant
      // timeline for this person regardless of which channel they last
      // used. Passing the inbound text ranks memories by relevance (vector
      // recall). Degrades to the per-jid facts block if unreachable.
      const memBlock = await this.personal.unifiedBlock("whatsapp", from, text);
      if (memBlock) systemHint += memBlock;
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

    // BOT-TELL FILTER — same defense as the iMessage bridge. Catches
    // "I can't see your message", "looks like an issue", customer-
    // service phrasing, AI tell-words. Suppressed drafts log to the
    // dashboard so the owner can see what was almost sent.
    const tellCheck = detectBotTells(draft);
    if (!tellCheck.ok) {
      this.logger.info({ from, reason: tellCheck.reason, draftPreview: draft.slice(0, 120) }, "draft suppressed by bot-tell filter");
      this.broadcast({
        type: "activity",
        data: {
          kind: "agent_skipped",
          summary: `draft suppressed — ${tellCheck.reason}`,
          detail: draft.slice(0, 200),
          jid: from,
          timestamp: Date.now(),
        },
      });
      return;
    }

    // CONFIDENCE GATE + VIP gate. Route to human approval instead of
    // auto-sending when:
    //   - VIP: contact is on the owner's VIP list (boss, parents, top
    //     customers) — never auto-send to them.
    //   - Low confidence: no prior owner-sent samples AND no known
    //     relationship AND no captured facts. An unfamiliar contact —
    //     draft, don't send, so the owner trains trust over time. Once
    //     samples accumulate the gate opens automatically.
    // Two-layer gate, controlled by LANTERN_DRAFT_APPROVALS (default off):
    //
    //   APPROVALS=on  → VIP + low-conf both queue a draft for the owner
    //                   to approve (old behavior, opt-in).
    //   APPROVALS=off → VIP stays silent (the owner explicitly flagged
    //                   them as sensitive — never auto-send). Low-conf
    //                   FALLS THROUGH to auto-reply: an unfamiliar
    //                   contact is the bot's job to handle, and
    //                   silencing them defeats the purpose of having
    //                   an assistant.
    // Reads the persisted toggle (NOT the env var). Env is only the
    // first-boot default; runtime is owned by `approvals on|off`
    // commands from self-chat / dashboard so phone control sticks
    // across restarts.
    const draftApprovalsOn = this.draftApprovalsEnabled;
    // If we know their name (push name OR a saved contact name), the
    // contact is FAMILIAR even without a stored relationship/facts —
    // the user explicitly asked: "anything that has a name should be
    // familiar". Falls through to auto-reply.
    const displayName = (opts.senderName || this.contactNames.get(from) || "").trim();
    const lowConfidence =
      !opts.isGroup &&
      ownerSamples.length === 0 &&
      !relationship &&
      !displayName &&
      !(await this.personal.factsBlock(from));
    const isVIP = !opts.isGroup && (await this.personal.isVIP(from));

    // VIP: always-special. Either queue-for-approval or stay silent.
    if (isVIP) {
      if (!draftApprovalsOn) {
        this.logger.info({ from }, "auto-reply suppressed — VIP (drafts off)");
        this.broadcast({
          type: "activity",
          data: {
            kind: "agent_skipped",
            summary: "silent on VIP (drafts disabled)",
            detail: draft.slice(0, 200),
            jid: from,
            pushName: opts.senderName,
            timestamp: Date.now(),
          },
        });
        return;
      }
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
          summary: queued ? "VIP draft queued for approval" : "VIP — auto-reply suppressed (queue failed)",
          detail: draft.slice(0, 200),
          jid: from,
          pushName: opts.senderName,
          timestamp: Date.now(),
        },
      });
      this.logger.info({ from, queued: !!queued }, "VIP draft queued for approval");
      return;
    }

    // Low-confidence: only queue-for-approval when explicitly opted in.
    // Default = fall through to auto-reply. The downstream bot-tell
    // filter + naturalize still guards against obviously-wooden replies.
    if (lowConfidence && draftApprovalsOn) {
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
            ? "draft queued for approval — low-confidence (unfamiliar contact)"
            : "low-confidence — auto-reply suppressed (queue failed)",
          detail: draft.slice(0, 200),
          jid: from,
          pushName: opts.senderName,
          timestamp: Date.now(),
        },
      });
      this.logger.info({ from, queued: !!queued }, "low-conf draft queued for approval");
      return;
    }

    // Confidence-tier classification — HIGH sends normally, MEDIUM
    // sends + mirrors to owner for audit, LOW delays 30s with
    // owner override window.
    const dislikesForContact = !opts.isGroup ? await this.dislikeMemory.forJid(from, 1) : [];
    const tier = classifyConfidence({
      replyText: draft,
      inboundText: text,
      relationship,
      hasPriorSamples: ownerSamples.length > 0,
      hasPriorDislikes: dislikesForContact.length > 0,
    });
    this.logger.info({ from, tier: tierBadge(tier) }, "wa reply confidence");
    if (tier.tier === "LOW" && !opts.isGroup) {
      try {
        await this.sendSelf(`🟡 LOW-confidence draft to ${opts.senderName ?? from.split("@")[0]}\n\nThey: ${text.slice(0, 200)}\n\nDraft: ${draft.slice(0, 300)}\n\n(holding 30s — say "cancel" in self-chat to abort)`);
      } catch {}
      await sleep(30_000);
    }

    // Pace-mirror hold — based on the owner's prior reply latency to
    // this contact. Computed from recent history + jittered.
    let paceHoldMs = 0;
    if (!opts.isGroup && ownerSamples.length > 0) {
      // Approximate history timestamps from index since the
      // ownerSentHistory map doesn't store ts. The median across
      // samples is robust enough.
      const histPseudo = ownerSamples.slice(-30).map((_, i) => ({
        fromMe: true,
        ts: Date.now() - (ownerSamples.length - i) * 60_000,
      }));
      const latencies = latenciesFromTranscript(histPseudo, 15);
      const verdict = computeHold({
        ownerLatencies: latencies,
        msSinceLastInbound: 0,
        isActiveBurst: ownerSamples.length >= 4,
      });
      paceHoldMs = verdict.holdMs;
    }
    if (paceHoldMs > 0) await sleep(paceHoldMs);

    // Relay-promise truth-up: if the draft contains "I'll let him
    // know" / "i'll alert" / "cheptha once I hear" / etc., the bot
    // MUST actually do that or it's lying. We fire a real escalation
    // to the owner's self-chat so the claim becomes truthful BEFORE
    // sending. Side-effect → make-it-true approach is safer than
    // rewriting away the promise (which could leave the contact
    // mid-conversation without a path forward).
    if (!opts.isGroup) {
      const relayP = detectRelayPromise(draft);
      if (relayP) {
        this.logger.info(
          { from, reason: relayP.reason, draftPreview: draft.slice(0, 120) },
          "RELAY-PROMISE detected — firing matching owner escalation so the claim is truthful",
        );
        void this.fireOwnerEscalation({
          kind: "relay-promise",
          reason: relayP.reason,
          from,
          senderName: opts.senderName,
          contactText: text,
          botReplyPreview: draft,
        });
      }
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

    // MEDIUM-confidence audit ping for non-group sends.
    if (tier.tier === "MEDIUM" && !opts.isGroup) {
      try {
        await this.sendSelf(`🟡 MEDIUM-confidence reply sent to ${opts.senderName ?? from.split("@")[0]}\n\nThey: ${text.slice(0, 200)}\n\nYou: ${draft.slice(0, 300)}`);
      } catch {}
    }

    // Episodic memory — record this exchange.
    if (!opts.isGroup) {
      void maybeRecordEpisode({
        memory: this.episodicMemory,
        jid: from,
        inbound: text,
        outbound: draft,
        llmCall: async (prompt) => {
          try {
            const out = await this.agent.respondTo(from, prompt, "", { withTools: false });
            return out || "";
          } catch { return ""; }
        },
      });
    }

    // Unified cross-channel timeline — record this exchange against the
    // canonical person so it surfaces on every other channel (iMessage,
    // SMS, voice, email). Best-effort; never blocks the reply.
    if (!opts.isGroup) {
      void this.personal.ingestEvent("whatsapp", from, "message_in", "in", text);
      void this.personal.ingestEvent("whatsapp", from, "message_out", "out", draft);
    }

    // Social-graph index the outbound topics.
    if (!opts.isGroup) {
      const outboundTopics = extractTopics(draft);
      if (outboundTopics.length > 0) {
        void this.socialGraph.record({
          jid: from,
          contactName: opts.senderName ?? this.contactNames.get(from),
          text: draft.slice(0, 200),
          fromMe: true,
          topics: outboundTopics,
        });
      }
    }
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

  // Build a compact recent-thread transcript for the persona prompt.
  // WhatsApp has no chat.db, so we approximate from the captured inbound
  // (them) tail; for 1:1 we also weave in the owner-sent (you) tail so
  // the model sees both voices. Best-effort + bounded; "" when empty.
  private buildRecentTranscript(from: string, isGroup?: boolean): string {
    try {
      const key = isGroup ? `group:${from}` : from;
      const theirs = (this.inboundHistory.get(key) ?? []).slice(-6);
      if (theirs.length === 0) return "";
      const yours = isGroup ? [] : (this.ownerSentHistory.get(from) ?? []).slice(-4);
      // We can't perfectly interleave without timestamps, so present the
      // owner's recent voice first (older context) then the contact's
      // recent messages (newest, what to reply to). The labels keep it
      // unambiguous for the model.
      const lines: string[] = [];
      for (const y of yours) lines.push(`you: ${y.replace(/\s+/g, " ").slice(0, 240)}`);
      for (const t of theirs) lines.push(`them: ${t.replace(/\s+/g, " ").slice(0, 240)}`);
      return lines.join("\n");
    } catch {
      return "";
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
