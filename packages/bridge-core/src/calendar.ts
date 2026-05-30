// Calendar-aware availability replies. When a contact asks "are you
// free?" / "what time works?" / "can we meet next week?", the bridge
// pulls the user's Google Calendar via the connector and injects the
// next ~5 events into the persona prompt as context. The LLM then
// crafts a reply with actual honest options instead of hallucinating
// availability.

import { authedFetch } from "./auth.js";
import type { Logger } from "pino";

// Cheap keyword check. False-positives just mean an extra calendar
// fetch that doesn't materially change the reply — acceptable.
// False-negatives are worse (assistant invents availability).
const AVAILABILITY_PATTERNS = [
  /\b(free|available|busy|swamped)\b/i,
  /\b(meet|catch up|chat|call|sync|talk|hop on)\b/i,
  /\b(what time|when (works|can|are you)|do you have time)\b/i,
  /\b(next (week|monday|tuesday|wednesday|thursday|friday|sat|sun))\b/i,
  /\b(this (afternoon|evening|morning|weekend))\b/i,
  /\b(tomorrow|tonight|today)\b/i,
];

export function needsCalendar(text: string): boolean {
  // Need at least one availability verb AND a temporal hint to fire.
  // "free" alone isn't enough ("feel free to ...").
  const hasVerb = AVAILABILITY_PATTERNS.slice(0, 3).some((re) => re.test(text));
  const hasTime = AVAILABILITY_PATTERNS.slice(3).some((re) => re.test(text));
  return hasVerb && (hasTime || /\b(meet|call|sync|catch up)\b/i.test(text));
}

interface CalendarEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export class CalendarLookup {
  private logger: Logger;
  constructor(logger: Logger) {
    this.logger = logger.child({ component: "calendar" });
  }

  // Returns a short markdown block with the next few events, formatted
  // for prompt injection. Returns empty string on failure / no events.
  async upcomingBlock(maxEvents = 8): Promise<string> {
    try {
      const res = await authedFetch(
        `/v1/connectors/google-calendar/execute?action=list_events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: maxEvents }),
        },
      );
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "calendar fetch failed");
        return "";
      }
      const payload = (await res.json()) as { data?: { items?: CalendarEvent[]; events?: CalendarEvent[] } };
      const items = payload.data?.items ?? payload.data?.events ?? [];
      if (items.length === 0) return "";
      const lines: string[] = [];
      for (const ev of items.slice(0, maxEvents)) {
        const start = ev.start?.dateTime || ev.start?.date || "";
        const summary = ev.summary || "(no title)";
        if (!start) continue;
        // Render times in the owner's timezone if configured.
        const tz = process.env.LANTERN_OWNER_TIMEZONE;
        const when = formatWhen(start, tz);
        lines.push(`- ${when} — ${summary}`);
      }
      if (lines.length === 0) return "";
      return `\n\nUser's upcoming calendar (use to give honest availability — don't invent free slots):\n${lines.join("\n")}\n\nWhen suggesting times, pick concrete slots that don't conflict with these. Lowercase the day names.`;
    } catch (err) {
      this.logger.warn({ err }, "calendar lookup exception");
      return "";
    }
  }

  /**
   * Returns the next meeting-like event that is either active right
   * now or starts within the next 30 minutes. Used by the presence
   * tracker to detect "in a meeting" without re-rendering an entire
   * formatted block. Returns null when there's no qualifying event
   * or the fetch fails.
   */
  async nextMeetingWindow(): Promise<{ summary?: string; startMs: number; endMs: number } | null> {
    try {
      const res = await authedFetch(
        `/v1/connectors/google-calendar/execute?action=list_events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 4 }),
        },
      );
      if (!res.ok) return null;
      const payload = (await res.json()) as { data?: { items?: CalendarEvent[]; events?: CalendarEvent[] } };
      const items = payload.data?.items ?? payload.data?.events ?? [];
      const now = Date.now();
      const horizon = now + 30 * 60_000;
      for (const ev of items) {
        const startIso = ev.start?.dateTime || ev.start?.date;
        const endIso = ev.end?.dateTime || ev.end?.date;
        if (!startIso || !endIso) continue;
        const startMs = new Date(startIso).getTime();
        const endMs = new Date(endIso).getTime();
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
        // Active OR starts within 30 min from now.
        if ((startMs <= now && endMs > now) || (startMs > now && startMs <= horizon)) {
          return { summary: ev.summary, startMs, endMs };
        }
      }
      return null;
    } catch {
      return null;
    }
  }
}

function formatWhen(iso: string, tz?: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const opts: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };
    if (tz) opts.timeZone = tz;
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  } catch {
    return iso;
  }
}
