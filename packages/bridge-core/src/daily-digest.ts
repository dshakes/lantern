// Daily morning digest — proactive briefing sent at the same time
// every morning so the user opens their phone to a short report
// instead of having to ask. Mirrors the Apple Health-style "morning
// summary" pattern.
//
// Sample output:
//   📊 lantern morning report — Wed May 21
//   • 14 auto-replies sent overnight
//   • 2 contacts paused (Mom resumes in 38m, work in 1h)
//   • 1 VIP draft waiting (from Boss)
//   • 0 escalations
//   • next event: 10am standup in 45 min
//
// Schedule: env-configurable hour (LANTERN_DIGEST_HOUR, default 8)
// in the user's timezone (LANTERN_OWNER_TIMEZONE). Set
// LANTERN_DIGEST_HOUR=-1 to disable.
//
// Where the data comes from:
//   - Sent / paused / monitored counts: bridge's own in-memory state
//     (passed in via DigestData)
//   - Pending VIP drafts: queried from control-plane
//   - Next calendar event: queried from control-plane's calendar
//     connector (best-effort; empty if not connected)
//
// Delivery: the bridge calls send-self with the formatted text.

import type { Logger } from "pino";
import { authedFetch } from "./auth.js";

export interface DigestData {
  // Total auto-replies sent since last digest (or process start).
  // The bridge tracks this with a counter that resets on send.
  repliesSent: number;
  // Currently-paused contacts. Used to render "N paused" line with
  // remaining time per contact.
  pausedContacts: Array<{ label: string; resumesAtMs: number }>;
  // Number of monitored group chats — informational.
  monitoredChats: number;
  // Escalations triggered since last digest.
  escalations: number;
  // Bridge channel label ("WhatsApp" / "iMessage").
  channelLabel: string;
  // Life-events queued for the batched briefing since the last digest
  // (deliveries, receipts, far-out bills). Each is a short owner-facing line
  // produced by the life-event engine's proactiveDecision. Best-effort; empty
  // when nothing was queued.
  lifeEvents?: string[];

  // ── Narrative enrichment (optional; populated by bridges that support it) ──
  // Pre-fetched next calendar event string (e.g. "1:1 with Raju in 45 min").
  // When present, composeDigestNarrative uses it directly without a re-fetch.
  nextEvent?: string | null;
  // Pre-fetched VIP draft count + sample name.
  drafts?: { count: number; sample?: string };
  // Top open commitments (tasks on the owner's plate).
  commitments?: Array<{ title: string; urgency?: string; assignedBy?: string }>;
  // Contacts with unanswered messages older than the overdue threshold.
  overdueContacts?: Array<{ displayName?: string; daysOverdue: number }>;
  // Sleep hours from the most-recent health signal in the overnight window.
  // null when no signal found; undefined when not yet gathered.
  sleepHours?: number | null;
  // Owner-voice exemplar block (from formatOwnerVoiceBlock). Injected into
  // the LLM system prompt so the narrative matches the owner's actual tone.
  ownerVoiceBlock?: string;
}

export interface DigestConfig {
  hour: number; // 0..23, target hour in owner's timezone. -1 disables.
  timezone?: string;
}

export function defaultDigestConfig(): DigestConfig {
  const hour = parseInt(process.env.LANTERN_DIGEST_HOUR ?? "8", 10);
  const timezone = process.env.LANTERN_OWNER_TIMEZONE || undefined;
  return { hour: Number.isFinite(hour) ? hour : 8, timezone };
}

// Calculate ms until the next time the local hour equals `cfg.hour`.
// Lets us schedule a one-shot setTimeout that fires at the right
// time across DST transitions etc.
export function msUntilNextDigest(now: Date, cfg: DigestConfig): number {
  if (cfg.hour < 0 || cfg.hour > 23) return -1; // disabled
  const target = new Date(now);
  // If a timezone is configured, calculate target by adjusting the
  // owner's local representation. Intl.DateTimeFormat gives us the
  // hour in TZ; we compute the diff and apply it.
  if (cfg.timezone) {
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: cfg.timezone,
        hour: "numeric",
        hour12: false,
      });
      const ownerHour = parseInt(fmt.format(now), 10);
      let hoursAhead = cfg.hour - ownerHour;
      if (hoursAhead <= 0) hoursAhead += 24;
      const ms = hoursAhead * 3600_000 - (now.getMinutes() * 60_000 + now.getSeconds() * 1000);
      return Math.max(60_000, ms);
    } catch {
      // fall through to local-time calc
    }
  }
  target.setHours(cfg.hour, 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

// Fetch pending VIP-draft count (cheap, single API call).
async function fetchPendingDrafts(): Promise<{ count: number; sample?: string }> {
  try {
    const res = await authedFetch("/v1/whatsapp/drafts?status=pending");
    if (!res.ok) return { count: 0 };
    const data = (await res.json()) as { drafts?: Array<{ displayName?: string; jid: string }> };
    const drafts = data.drafts ?? [];
    if (drafts.length === 0) return { count: 0 };
    const first = drafts[0].displayName || drafts[0].jid;
    return { count: drafts.length, sample: first };
  } catch {
    return { count: 0 };
  }
}

// Best-effort next-calendar-event peek.
async function fetchNextEvent(): Promise<string | null> {
  try {
    const res = await authedFetch(
      "/v1/connectors/google-calendar/execute?action=list_events",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 3 }),
      },
    );
    if (!res.ok) return null;
    const payload = (await res.json()) as { data?: { items?: Array<{ summary?: string; start?: { dateTime?: string; date?: string } }> } };
    const items = payload.data?.items ?? [];
    const now = Date.now();
    for (const ev of items) {
      const start = ev.start?.dateTime || ev.start?.date || "";
      const ts = Date.parse(start);
      if (Number.isFinite(ts) && ts > now) {
        const minutes = Math.round((ts - now) / 60_000);
        const when = minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
        return `${ev.summary || "untitled"} in ${when}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Build the formatted digest body. Best-effort: missing data is
// dropped (no nulls or "(unknown)" lines).
export async function buildDigest(data: DigestData): Promise<string> {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const lines: string[] = [`📊 *lantern morning report* — ${dateStr.toLowerCase()}`];

  if (data.repliesSent > 0) {
    lines.push(`• ${data.repliesSent} auto-${data.repliesSent === 1 ? "reply" : "replies"} sent on ${data.channelLabel.toLowerCase()}`);
  } else {
    lines.push(`• quiet night — no auto-replies sent`);
  }

  if (data.pausedContacts.length > 0) {
    const top = data.pausedContacts.slice(0, 3).map((c) => {
      const mins = Math.max(0, Math.round((c.resumesAtMs - Date.now()) / 60_000));
      return `${c.label} (${mins < 60 ? mins + "m" : Math.round(mins / 60) + "h"})`;
    });
    lines.push(`• ${data.pausedContacts.length} paused: ${top.join(", ")}`);
  }

  if (data.monitoredChats > 0) {
    lines.push(`• watching ${data.monitoredChats} group${data.monitoredChats === 1 ? "" : "s"}`);
  }

  if (data.escalations > 0) {
    lines.push(`• 🚨 ${data.escalations} escalation${data.escalations === 1 ? "" : "s"} — check email`);
  }

  // Pending drafts (cross-channel; same DB for both bridges).
  const drafts = await fetchPendingDrafts();
  if (drafts.count > 0) {
    lines.push(`• 👑 ${drafts.count} VIP draft${drafts.count === 1 ? "" : "s"} waiting${drafts.sample ? ` (${drafts.sample})` : ""}`);
  }

  // Next calendar event (when calendar connector is wired).
  const nextEv = await fetchNextEvent();
  if (nextEv) {
    lines.push(`• next: ${nextEv}`);
  }

  // Life-events the engine batched (deliveries / receipts / far-out bills).
  const events = data.lifeEvents ?? [];
  if (events.length > 0) {
    lines.push(`• 📬 ${events.length} update${events.length === 1 ? "" : "s"}:`);
    for (const ev of events.slice(0, 6)) {
      lines.push(`   ${ev}`);
    }
  }

  lines.push("");
  lines.push(`reply *help* anytime to see what i can do.`);
  return lines.join("\n");
}

// On-demand briefing: does the owner self-chat ask for their day / what's on
// their plate? Pure + high-precision — too-generic phrases ("what's up", "hi")
// must NOT trigger a full briefing assembly. Mirrors the scheduled digest but
// fires whenever the owner asks.
export function looksLikeBriefingRequest(text: string): boolean {
  const t = (text || "").trim().toLowerCase().replace(/[?.!]+$/, "");
  if (!t || t.length > 80) return false;
  return (
    /\bbrief me\b/.test(t) ||
    /\b(morning|daily|my) brief(ing)?\b/.test(t) ||
    /^brief(ing)?$/.test(t) ||
    /\bwhat'?s (on )?(my )?(plate|agenda)\b/.test(t) ||
    /\bwhat'?s (on for|happening|going on|up|on) (today|this morning)\b/.test(t) ||
    /\bwhat (do|have) i (have|got)\b.*\b(today|this morning|on)\b/.test(t) ||
    /\b(catch me up|fill me in|run me through|rundown of) (on )?(my |the )?(day|today|morning|plate|schedule)\b/.test(t) ||
    /\bhow('?s| is| does) (my )?(day|today) (look|looking|shaping)/.test(t) ||
    /\bwhere (do |does )?(things|everything) stand\b/.test(t) ||
    /\bmy (day|schedule) today\b/.test(t)
  );
}

// Schedule the digest to run at the configured hour. Returns a
// stop() function the caller invokes on shutdown.
export function scheduleDigest(opts: {
  logger: Logger;
  cfg: DigestConfig;
  collectData: () => DigestData | Promise<DigestData>;
  deliver: (body: string) => Promise<void> | void;
  // Optional narrative composer. When provided, used instead of buildDigest.
  // Falls back to buildDigest on any error. Passes the full DigestData so the
  // composer can use the enrichment fields the bridge pre-fetched.
  compose?: (data: DigestData) => Promise<string>;
}): { stop: () => void } {
  const log = opts.logger.child({ component: "daily-digest" });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    const delay = msUntilNextDigest(new Date(), opts.cfg);
    if (delay < 0) {
      log.info("daily digest disabled (LANTERN_DIGEST_HOUR=-1)");
      return;
    }
    log.info({ delayMs: delay, hour: opts.cfg.hour }, "next digest scheduled");
    timer = setTimeout(async () => {
      try {
        const data = await opts.collectData();
        let body: string;
        if (opts.compose) {
          try {
            body = await opts.compose(data);
          } catch (composeErr) {
            log.warn({ err: composeErr }, "digest compose failed — falling back to buildDigest");
            body = await buildDigest(data);
          }
        } else {
          body = await buildDigest(data);
        }
        await opts.deliver(body);
        log.info({ replies: data.repliesSent, paused: data.pausedContacts.length }, "digest delivered");
      } catch (err) {
        log.warn({ err }, "digest delivery failed");
      }
      // Reschedule for tomorrow.
      schedule();
    }, delay);
  };
  schedule();

  return {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
