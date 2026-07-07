// Pure query-building + formatting for the local Apple Mail "Envelope
// Index" — the SQLite index Mail.app maintains for every synced account
// (Gmail included). Gives the owner's assistant OAuth-free access to the
// full historical mailbox (sender / subject / date for ~100k messages),
// complementing the live `gmail_search` connector tool whose token can
// expire. The I/O side (opening the live index read-only) lives in the
// bridge's mail-reader; this module stays dependency-free and unit-tested.
//
// Each hit carries its `rowid` (messages.ROWID) so the model can chain
// search → read_email: the ROWID is the .emlx filename the body reader loads.

export interface MailSearchParams {
  query: string;
  from?: string;
  since?: string; // ISO date (YYYY-MM-DD) inclusive
  until?: string; // ISO date (YYYY-MM-DD) inclusive
  limit?: number;
}

export interface MailHit {
  rowid: number; // messages.ROWID — the .emlx filename; feeds read_email
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
    "SELECT m.ROWID AS rowid, m.date_received AS ts, COALESCE(a.comment, '') AS comment, COALESCE(a.address, '') AS address, COALESCE(s.subject, '') AS subject " +
    "FROM messages m " +
    "JOIN subjects s ON m.subject = s.ROWID " +
    "LEFT JOIN addresses a ON m.sender = a.ROWID " +
    "WHERE " + clauses.join(" AND ") + " " +
    "ORDER BY m.date_received DESC LIMIT ?";
  return { sql, args };
}

export function rowToHit(row: { rowid: number; ts: number; comment: string; address: string; subject: string }): MailHit {
  const d = new Date(row.ts * 1000);
  const date = Number.isNaN(d.getTime()) ? "unknown" : d.toISOString().slice(0, 10);
  const from = row.comment && row.comment !== row.address ? `${row.comment} <${row.address}>` : row.address;
  return { rowid: row.rowid, date, from, subject: row.subject };
}

// Compact block the LLM reads as tool output.
export function formatMailHits(hits: MailHit[]): string {
  if (hits.length === 0) return "No matching emails in the local mail index.";
  return hits.map((h) => `[#${h.rowid}] ${h.date} · ${h.from} · ${h.subject}`).join("\n");
}

// ---- Message BODY parsing (read_email) --------------------------------
// Pure, best-effort parse of an Apple Mail `.emlx` payload into a bounded
// plain-text body + From/Subject. The I/O side (locating + reading the file
// under ~/Library/Mail) lives in the bridge's mail-reader. Any malformed
// input throws or returns empty text → callers treat that as fail-closed.

export interface ParsedEmail {
  text: string;
  from?: string;
  subject?: string;
}

const EMAIL_BODY_CAP = 6000;

// Drop the .emlx framing (leading byte-count line + trailing Apple plist),
// then parse the RFC822 message it wraps.
export function parseEmlx(raw: string): ParsedEmail {
  const firstNL = raw.indexOf("\n");
  let rfc = firstNL >= 0 && /^\s*\d+\s*$/.test(raw.slice(0, firstNL)) ? raw.slice(firstNL + 1) : raw;
  const plistAt = rfc.indexOf("\n<?xml");
  if (plistAt >= 0) rfc = rfc.slice(0, plistAt);
  const { headers, body } = splitHeadersBody(rfc);
  const from = decodeMimeWords(headerValue(headers, "From")) || undefined;
  const subject = decodeMimeWords(headerValue(headers, "Subject")) || undefined;
  const text = extractText(headerValue(headers, "Content-Type"), headerValue(headers, "Content-Transfer-Encoding"), body);
  return { text: clampBody(text), from, subject };
}

function splitHeadersBody(msg: string): { headers: string; body: string } {
  const m = msg.match(/\r?\n\r?\n/);
  if (!m || m.index === undefined) return { headers: msg, body: "" };
  return { headers: msg.slice(0, m.index), body: msg.slice(m.index + m[0].length) };
}

function headerValue(headers: string, name: string): string {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return m ? m[1].trim() : "";
}

// Pick the readable text out of a (possibly multipart) body: prefer
// text/plain, fall back to text/html (tags stripped).
function extractText(ctype: string, cte: string, body: string): string {
  const boundary = ctype.match(/boundary="?([^";]+)"?/i);
  if (/multipart\//i.test(ctype) && boundary) {
    const parts = splitMultipart(body, boundary[1]);
    const plain = parts.find((p) => /text\/plain/i.test(p.ctype));
    // decodeEntities on the plain path too: some senders put HTML entities
    // (incl. numeric like &#58; for ":") in their text/plain part.
    if (plain) return decodeEntities(decodeBody(plain.cte, plain.body));
    const html = parts.find((p) => /text\/html/i.test(p.ctype));
    if (html) return stripHtml(decodeBody(html.cte, html.body));
    const nested = parts.find((p) => /multipart\//i.test(p.ctype));
    if (nested) return extractText(nested.ctype, "", nested.body);
    return "";
  }
  const decoded = decodeBody(cte, body);
  return /text\/html/i.test(ctype) ? stripHtml(decoded) : decodeEntities(decoded);
}

function splitMultipart(body: string, boundary: string): { ctype: string; cte: string; body: string }[] {
  const out: { ctype: string; cte: string; body: string }[] = [];
  for (const seg of body.split(`--${boundary}`)) {
    const trimmed = seg.replace(/^\r?\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue; // preamble / closing delimiter
    const { headers, body: pbody } = splitHeadersBody(trimmed);
    out.push({ ctype: headerValue(headers, "Content-Type"), cte: headerValue(headers, "Content-Transfer-Encoding"), body: pbody });
  }
  return out;
}

function decodeBody(cte: string, body: string): string {
  const enc = cte.toLowerCase();
  if (enc.includes("base64")) {
    try { return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8"); } catch { return body; }
  }
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body);
  return body;
}

function decodeQuotedPrintable(s: string): string {
  const noSoft = s.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    if (noSoft[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      bytes.push(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(noSoft.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// RFC 2047 encoded-word decoding for From/Subject headers.
function decodeMimeWords(s: string): string {
  if (!s) return s;
  return s.replace(/=\?[^?]+\?([BbQq])\?([^?]*)\?=/g, (_, enc: string, text: string) => {
    try {
      if (enc.toUpperCase() === "B") return Buffer.from(text, "base64").toString("utf8");
      return decodeQuotedPrintable(text.replace(/_/g, " "));
    } catch { return text; }
  });
}

function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

/** Decode the HTML entities common in email bodies — including NUMERIC ones
 *  (`&#58;` → ":", `&#x27;` → "'"). Without the numeric pass a time could
 *  arrive as "8&#58;30" and the model would misread it. Best-effort; unknown
 *  entities are left as-is. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&(?:#39|apos|lsquo|rsquo);/gi, "'")
    .replace(/&(?:quot|ldquo|rdquo);/gi, '"')
    .replace(/&(?:mdash|ndash);/gi, "-");
}

function safeCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return "";
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "";
  }
}

function clampBody(text: string): string {
  const collapsed = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return collapsed.length > EMAIL_BODY_CAP ? collapsed.slice(0, EMAIL_BODY_CAP) + "…" : collapsed;
}
