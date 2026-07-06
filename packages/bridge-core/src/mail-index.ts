// Pure query-building + formatting for the local Apple Mail "Envelope
// Index" — the SQLite index Mail.app maintains for every synced account
// (Gmail included). Gives the owner's assistant OAuth-free access to the
// full historical mailbox (sender / subject / date for ~100k messages),
// complementing the live `gmail_search` connector tool whose token can
// expire. The I/O side (opening the live index read-only) lives in the
// bridge's mail-reader; this module stays dependency-free and unit-tested.
//
// ponytail: subjects + senders only — message BODIES stay in per-message
// .emlx files; add a read_email tool wired to those if subject-level
// answers prove insufficient.

export interface MailSearchParams {
  query: string;
  from?: string;
  since?: string; // ISO date (YYYY-MM-DD) inclusive
  until?: string; // ISO date (YYYY-MM-DD) inclusive
  limit?: number;
}

export interface MailHit {
  date: string; // YYYY-MM-DD
  from: string;
  subject: string;
}

export const MAIL_SEARCH_DEFAULT_LIMIT = 25;
export const MAIL_SEARCH_MAX_LIMIT = 100;

// Every whitespace-separated word must match the subject OR the sender
// (address or display name). AND across words so "united receipt" means
// united AND receipt, not a flood of either.
export function buildMailQuery(p: MailSearchParams): { sql: string; args: (string | number)[] } {
  const words = p.query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (words.length === 0) throw new Error("empty query");
  const clauses: string[] = ["m.deleted = 0"];
  const args: (string | number)[] = [];
  for (const w of words) {
    clauses.push("(s.subject LIKE ? OR a.address LIKE ? OR a.comment LIKE ?)");
    const like = `%${w}%`;
    args.push(like, like, like);
  }
  if (p.from?.trim()) {
    clauses.push("(a.address LIKE ? OR a.comment LIKE ?)");
    const like = `%${p.from.trim()}%`;
    args.push(like, like);
  }
  if (p.since) {
    const t = Date.parse(p.since);
    if (!Number.isNaN(t)) { clauses.push("m.date_received >= ?"); args.push(Math.floor(t / 1000)); }
  }
  if (p.until) {
    const t = Date.parse(p.until);
    // Inclusive end-of-day.
    if (!Number.isNaN(t)) { clauses.push("m.date_received < ?"); args.push(Math.floor(t / 1000) + 86400); }
  }
  const limit = Math.min(Math.max(1, Math.floor(p.limit || MAIL_SEARCH_DEFAULT_LIMIT)), MAIL_SEARCH_MAX_LIMIT);
  args.push(limit);
  const sql =
    "SELECT m.date_received AS ts, COALESCE(a.comment, '') AS comment, COALESCE(a.address, '') AS address, COALESCE(s.subject, '') AS subject " +
    "FROM messages m " +
    "JOIN subjects s ON m.subject = s.ROWID " +
    "LEFT JOIN addresses a ON m.sender = a.ROWID " +
    "WHERE " + clauses.join(" AND ") + " " +
    "ORDER BY m.date_received DESC LIMIT ?";
  return { sql, args };
}

export function rowToHit(row: { ts: number; comment: string; address: string; subject: string }): MailHit {
  const d = new Date(row.ts * 1000);
  const date = Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
  const from = row.comment && row.comment !== row.address ? `${row.comment} <${row.address}>` : row.address;
  return { date, from, subject: row.subject };
}

// Compact block the LLM reads as tool output.
export function formatMailHits(hits: MailHit[]): string {
  if (hits.length === 0) return "No matching emails in the local mail index.";
  return hits.map((h) => `${h.date} · ${h.from} · ${h.subject}`).join("\n");
}
