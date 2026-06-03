// Connector pre-fetch for the bridges.
//
// Background: relying on the LLM to call multiple tools (Gmail +
// Calendar) in one turn is unreliable — Claude/OpenAI often stop
// after one tool returns nothing and respond "couldn't find it".
// Real-world example: "when's my colonoscopy?" — model called
// google-calendar_list_events, got nothing, declared failure, never
// tried gmail_search where the appointment confirmation actually
// lived.
//
// Pattern here: the bridge knows the query INTENT (appointment /
// event / booking) and proactively runs BOTH gmail_search AND
// google-calendar_list_events in parallel, formats the results into
// a context block, and injects it into the system prompt. The LLM
// receives all relevant data up-front and just synthesizes a clean
// answer — one round-trip, deterministic recall, no tool-loop
// gambling.

import type { Logger } from "pino";

// Intent regex — same nouns CONNECTOR_DOMAIN_RE uses, but here we
// USE the match to pre-fetch instead of just routing.
const APPOINTMENT_INTENT_RE = /\b(appointment|appointments|booking|reservation|meeting|meetings|event|events|flight|flights|hotel|hotels|doctor|dentist|endoscop|colonoscop|surgery|procedure|visit|consult|interview|callback|rsvp|standup|sync|1:1|one[-\s]on[-\s]one|interview|call|conference|webinar|appt)\b/i;

// Keyword nouns that drive a Gmail search. We extract the
// distinguishing noun from the query and run targeted searches
// against it + related broad terms.
const KEYWORD_EXPANSIONS: Record<string, string[]> = {
  // medical
  endoscop: ["endoscopy", "colonoscopy", "gastroenterology", "appointment"],
  colonoscop: ["colonoscopy", "endoscopy", "gastroenterology", "appointment"],
  doctor: ["doctor", "appointment", "visit", "physician"],
  dentist: ["dentist", "dental", "appointment", "cleaning"],
  surgery: ["surgery", "procedure", "operation", "appointment"],
  procedure: ["procedure", "appointment"],
  visit: ["visit", "appointment", "consultation"],
  consult: ["consult", "consultation", "appointment"],
  // travel
  flight: ["flight", "boarding pass", "itinerary", "reservation", "confirmation"],
  hotel: ["hotel", "reservation", "booking", "check-in", "confirmation"],
  reservation: ["reservation", "booking", "confirmation"],
  booking: ["booking", "reservation", "confirmation"],
  // work
  interview: ["interview", "call", "meeting"],
  meeting: ["meeting", "invite", "calendar"],
  callback: ["callback", "interview", "call"],
};

export interface ConnectorClient {
  /**
   * Issue a connector execute call via the control-plane.
   * Returns parsed JSON or null on error.
   */
  execute(connectorId: string, action: string, params: Record<string, string | number>): Promise<unknown>;
}

// Default ConnectorClient that uses bridge-core's authedFetch to the
// control-plane. Lazy-imports authedFetch to avoid circular module
// load.
export function defaultConnectorClient(logger: Logger): ConnectorClient {
  return {
    async execute(connectorId, action, params) {
      try {
        const { authedFetch } = await import("./auth.js");
        const qs = new URLSearchParams({ action, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
        const res = await authedFetch(`/v1/connectors/${connectorId}/execute?${qs.toString()}`, { method: "GET" });
        if (!res.ok) {
          logger.warn({ connectorId, action, status: res.status }, "connector exec non-200");
          return null;
        }
        return await res.json();
      } catch (err) {
        logger.warn({ err, connectorId, action }, "connector exec exception");
        return null;
      }
    },
  };
}

interface GmailMessage {
  from?: string;
  subject?: string;
  snippet?: string;
  date?: string;
  body?: string;
}
interface CalEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

// Personal-IDENTITY-document lookups ("when is my green card expiring") are
// answered from personal-docs, NOT the calendar. Without this guard the broad
// "when is my ..." pattern below pulls a full calendar dump into the prompt for
// a doc question — the exact context-bloat that blew the LLM token budget.
const DOC_QUERY_RE = /\b(green\s?card|greencard|passport|visa|ead|work\s+permit|driver'?s?\s+licen[sc]e|licen[sc]e|citizenship|naturali[sz]ation|ssn|social\s+security|insurance|policy|warranty|lease|i-?\d{3}\b|expir(?:e|es|ing|ation|y))\b/i;

// Detect appointment-style intent.
export function looksLikeAppointmentQuery(text: string): boolean {
  if (!text || text.length < 3) return false;
  // Identity-doc/expiry lookups are personal-docs queries — never calendar,
  // UNLESS they also name an explicit appointment noun (e.g. "when is my
  // visa interview appointment").
  if (DOC_QUERY_RE.test(text) && !APPOINTMENT_INTENT_RE.test(text)) return false;
  // Also catch "when is / when was / when's" + "my" pattern — broad
  // event time-bound questions even without the specific noun.
  if (/\bwhen\s+(?:is|was|will|s|'s)?\s*(?:my|the)\b/i.test(text)) return true;
  return APPOINTMENT_INTENT_RE.test(text);
}

// Extract search keywords from the query. Lowercases, strips
// question-style filler, expands medical/travel/work nouns to their
// known synonyms.
export function expandKeywords(query: string): string[] {
  const lower = query.toLowerCase();
  const expanded = new Set<string>();
  for (const [stem, synonyms] of Object.entries(KEYWORD_EXPANSIONS)) {
    if (lower.includes(stem)) {
      synonyms.forEach((s) => expanded.add(s));
    }
  }
  // Always include the raw "meaningful" token (the noun the user
  // typed). Heuristic: pick the longest non-stopword token in the
  // query.
  const stopwords = new Set(["when", "what", "where", "who", "how", "why", "the", "my", "your", "his", "her", "is", "was", "are", "were", "this", "that", "year", "month", "week", "day", "today", "tomorrow", "next", "last", "have", "had", "has", "do", "did", "does", "in", "on", "at", "for", "of", "and", "or", "but", "a", "an"]);
  const tokens = lower
    .replace(/[?.!,;:]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !stopwords.has(t));
  // The longest content word is usually the topic noun. Add it.
  tokens.sort((a, b) => b.length - a.length);
  if (tokens.length > 0) expanded.add(tokens[0]);
  // Fallback: if no expansion + no good token, just use the whole
  // trimmed phrase.
  if (expanded.size === 0) expanded.add(query.trim());
  return [...expanded];
}

// Run Gmail + Calendar searches in parallel and format into a
// context block the LLM can read directly.
export async function prefetchAppointmentContext(
  client: ConnectorClient,
  query: string,
  logger: Logger,
): Promise<string | null> {
  if (!looksLikeAppointmentQuery(query)) return null;
  const keywords = expandKeywords(query);
  const t0 = Date.now();

  // Compute time window: today minus 60 days through today plus 365.
  // Wide so we catch recent past events AND year-out bookings.
  const now = new Date();
  const past = new Date(now.getTime() - 60 * 86_400_000);
  const future = new Date(now.getTime() + 365 * 86_400_000);

  const [gmailResults, calResult] = await Promise.all([
    // Gmail: search for each expanded keyword, take top hits per keyword
    Promise.all(
      keywords.slice(0, 4).map((k) =>
        client.execute("gmail", "search", { query: k, maxResults: 5 }).then((r) => ({
          keyword: k,
          messages: extractGmailMessages(r),
        })),
      ),
    ),
    // Calendar: list events in window
    client.execute("google-calendar", "list_events", {
      timeMin: past.toISOString(),
      timeMax: future.toISOString(),
      maxResults: 100,
    }),
  ]);

  logger.info({ ms: Date.now() - t0, keywords, gmailKeywords: gmailResults.length }, "prefetch done");

  const sections: string[] = ["\n\n*Live data fetched for this query — synthesize the answer from below; don't say 'I can't access' if anything is here:*"];

  // Dedupe + filter Gmail by keyword relevance + recency
  const seenSubjects = new Set<string>();
  const flatGmail: GmailMessage[] = [];
  for (const { messages } of gmailResults) {
    for (const m of messages) {
      const k = `${m.subject || ""}|${m.from || ""}`;
      if (seenSubjects.has(k)) continue;
      seenSubjects.add(k);
      flatGmail.push(m);
    }
  }
  // Bias toward recent (last 6 months) + appointment-y content
  flatGmail.sort((a, b) => {
    const da = a.date ? Date.parse(a.date) : 0;
    const db = b.date ? Date.parse(b.date) : 0;
    return db - da;
  });
  const gmailTop = flatGmail.slice(0, 8);
  if (gmailTop.length > 0) {
    sections.push("\n**Gmail (top matches, most recent first):**");
    for (const m of gmailTop) {
      const datePart = m.date ? new Date(m.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "(undated)";
      sections.push(`  • [${datePart}] FROM: ${truncate(m.from, 60)} | SUBJ: ${truncate(m.subject, 80)}`);
      if (m.snippet) sections.push(`     ${truncate(m.snippet.replace(/\s+/g, " "), 300)}`);
    }
  } else {
    sections.push("\n**Gmail:** no matches for: " + keywords.join(", "));
  }

  const calEvents = extractCalEvents(calResult);
  if (calEvents.length > 0) {
    // Filter to relevant events: keyword match in summary OR within next 14 days
    const inNext14 = (d?: string) => {
      if (!d) return false;
      const t = Date.parse(d);
      return t > Date.now() && t < Date.now() + 14 * 86_400_000;
    };
    const relevant = calEvents.filter((e) => {
      const sum = (e.summary || "").toLowerCase();
      const matches = keywords.some((k) => sum.includes(k.toLowerCase()));
      return matches || inNext14(e.start?.dateTime || e.start?.date);
    }).slice(0, 10);
    if (relevant.length > 0) {
      sections.push("\n**Google Calendar (relevant events):**");
      for (const e of relevant) {
        const start = e.start?.dateTime || e.start?.date || "?";
        const when = start.length === 10
          ? new Date(start + "T09:00:00").toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
          : new Date(start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
        sections.push(`  • [${when}] ${truncate(e.summary, 80)}${e.location ? " @ " + truncate(e.location, 60) : ""}`);
      }
    } else {
      sections.push("\n**Google Calendar:** no relevant events in the next 14 days or matching keywords.");
    }
  } else {
    sections.push("\n**Google Calendar:** no events returned.");
  }

  return sections.join("\n");
}

function extractGmailMessages(raw: unknown): GmailMessage[] {
  const top = raw as { data?: { messages?: GmailMessage[] } };
  return top?.data?.messages || [];
}
function extractCalEvents(raw: unknown): CalEvent[] {
  const top = raw as { data?: { items?: CalEvent[] } };
  return top?.data?.items || [];
}
function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
