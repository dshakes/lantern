// Auto-updater for ~/.lantern/owner-profile.md.
//
// Triggered on owner self-chat messages that look like they're
// TEACHING the bot something contextual ("Raju moved to MD",
// "Manasa now goes by Manu with old friends", "work hours changed
// to 10-7"). Extracts a structured fact, dedupes against the
// existing profile, and appends to a managed "Auto-learned" section.
//
// Design notes:
//   - Owner-only. NEVER call this on a DM from another contact —
//     facts about THEM go through fact-extractor.ts to the
//     whatsapp_contact_facts table.
//   - LLM-extracted with a tight JSON schema. The bridge can't ship
//     wrong facts: we discard anything that doesn't parse or score
//     low confidence.
//   - Append-only. Never rewrite existing profile lines — that risks
//     destroying owner-authored content. The managed section is at
//     the end of the file under a stable header.
//   - Dedup is line-level + similarity. If "Raju lives in Poolville MD"
//     already appears anywhere in the profile, skip.
//   - Returns the list of newly-appended lines so the bridge can ack
//     the owner: "📝 noted: Raju in Poolville MD, Sujith in NJ".

import { readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Logger } from "pino";

const MANAGED_HEADER = "## Auto-learned facts (managed)";
const MANAGED_NOTE =
  "<!-- Bot appends here when the owner shares context in self-chat. " +
  "Safe to edit manually; the bot won't overwrite existing lines, just " +
  "appends new ones. To remove an entry, delete its bullet. -->";

// Managed "## Facts" section header. Owner facts the bot learns
// ("I'm married", "my anniversary is …") are typed into this section so
// the parser reads them as structured ground truth, not free-form prose.
const FACTS_HEADER = "## Facts";

// ── Section-mutation helpers ─────────────────────────────────────────
// These do in-place, append-only edits to a single markdown section so
// the bot can write typed facts (## Facts) and per-contact naming rules
// (## Relationships) without clobbering owner-authored content. All are
// pure string transforms; the caller owns the disk write.

/** Find the [start, end) line range of a "## Header" section's BODY
 *  (the lines after the header, up to the next "## " heading or EOF).
 *  Returns null when the header isn't present. */
function sectionBody(lines: string[], header: string): { headerIdx: number; end: number } | null {
  const hLc = header.trim().toLowerCase();
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().toLowerCase() === hLc) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return null;
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^#{2,6}\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { headerIdx, end };
}

/** Upsert a "- key: value" line into the ## Facts section, creating the
 *  section if absent. Replaces an existing line with the same key
 *  (case-insensitive) so re-teaching a fact updates rather than dupes.
 *  Returns the new file text, or null if nothing changed. */
function upsertFact(existing: string, key: string, value: string): string | null {
  const lines = existing.split(/\r?\n/);
  const newLine = `- ${key}: ${value}`;
  const keyLc = key.trim().toLowerCase();
  const body = sectionBody(lines, FACTS_HEADER);
  if (!body) {
    // Create the section at the end of the file.
    const trimmed = existing.replace(/\s*$/, "");
    return `${trimmed}\n\n${FACTS_HEADER}\n${newLine}\n`;
  }
  // Look for an existing "- key: ..." line in the section body.
  for (let i = body.headerIdx + 1; i < body.end; i++) {
    const m = lines[i].trim().match(/^[-*]?\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (m && m[1].trim().toLowerCase() === keyLc) {
      if (lines[i].trim() === newLine.trim()) return null; // no change
      lines[i] = newLine;
      return lines.join("\n");
    }
  }
  // Insert at the end of the section body (after the last non-blank line).
  let insertAt = body.end;
  while (insertAt > body.headerIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
  lines.splice(insertAt, 0, newLine);
  return lines.join("\n");
}

/** Merge a per-contact naming rule into that contact's ## Relationships
 *  line using the extended "| address as: X | never: a, b" grammar.
 *  Matches the contact by the head name (case-insensitive). Returns the
 *  new file text, or null when the contact line isn't found / no change. */
function mergeContactRule(
  existing: string,
  contact: string,
  rule: { addressAs?: string; never?: string[] },
): string | null {
  const lines = existing.split(/\r?\n/);
  const contactLc = contact.trim().toLowerCase();
  const body = sectionBody(lines, "## Relationships");
  if (!body) return null;
  for (let i = body.headerIdx + 1; i < body.end; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const segments = trimmed.split("|").map((s) => s.trim());
    const head = segments[0];
    const m = head.match(/^[-*]?\s*([^:]+?)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    // Match on the name OR a parenthetical alias.
    const nameRaw = m[1].trim();
    const names = [nameRaw.toLowerCase()];
    const paren = nameRaw.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      names.push(paren[1].trim().toLowerCase(), paren[2].trim().toLowerCase());
    }
    if (!names.includes(contactLc)) continue;

    // Parse existing directives, then merge the new ones in.
    let addressAs: string | undefined;
    const never = new Set<string>();
    for (const seg of segments.slice(1)) {
      const am = seg.match(/^address\s+as\s*:\s*(.+)$/i);
      if (am) addressAs = am[1].trim().replace(/^["']|["']$/g, "").trim() || undefined;
      const nm = seg.match(/^never\s*:\s*(.+)$/i);
      if (nm) for (const t of nm[1].split(",")) {
        const v = t.trim().replace(/^["']|["']$/g, "").trim();
        if (v) never.add(v.toLowerCase());
      }
    }
    if (rule.addressAs) addressAs = rule.addressAs.trim();
    if (rule.never) for (const t of rule.never) {
      const v = t.trim();
      if (v) never.add(v.toLowerCase());
    }

    // Rebuild the line: head + directives.
    const rebuilt = [`- ${nameRaw}: ${m[2].trim()}`];
    if (addressAs) rebuilt.push(`address as: ${addressAs}`);
    if (never.size) rebuilt.push(`never: ${Array.from(never).join(", ")}`);
    const newLine = rebuilt.join(" | ");
    if (newLine === lines[i].trim()) return null; // no change
    lines[i] = newLine;
    return lines.join("\n");
  }
  return null;
}

// Managed "## Style lessons" section. The dislike consolidator writes
// DISTILLED, non-PII style rules here (e.g. "Avoid exclamation marks").
// Owner-only; the raw 👎 history stays in the 0600 JSONL and never lands
// in the profile. Each lesson is tagged with a stable <!--id:...--> so
// re-running consolidation updates rather than duplicates a rule.
const STYLE_LESSONS_HEADER = "## Style lessons (managed)";
const STYLE_LESSONS_NOTE =
  "<!-- Bot writes distilled style rules here, learned from the owner's 👎 " +
  "history. Non-PII only. Safe to edit/delete a bullet; the bot dedups by id. -->";

export interface WriteStyleLessonsResult {
  added: string[];
  updated: string[];
  unchanged: number;
}

/**
 * Idempotently write distilled style lessons into the managed
 * "## Style lessons" section of the owner profile. Each lesson is keyed
 * by a stable id (rendered as a trailing HTML comment) so re-running the
 * consolidator updates the rule text in place rather than appending dupes.
 *
 * Owner-only by construction: the only caller is the owner-self-chat
 * consolidation path. Returns what changed; invalidates the profile cache
 * on a successful write.
 */
export async function writeStyleLessons(
  lessons: Array<{ id: string; text: string }>,
  opts: { profilePath: string; invalidate?: () => void; logger?: Logger },
): Promise<WriteStyleLessonsResult> {
  const log = opts.logger?.child({ component: "owner-profile-style-lessons" });
  const empty: WriteStyleLessonsResult = { added: [], updated: [], unchanged: 0 };
  const clean = lessons
    .map((l) => ({ id: String(l.id || "").trim(), text: String(l.text || "").trim() }))
    .filter((l) => l.id && l.text && l.text.length <= 200);
  if (clean.length === 0) return empty;

  let existing = "";
  if (existsSync(opts.profilePath)) {
    try {
      existing = await readFile(opts.profilePath, "utf8");
    } catch (err) {
      log?.warn({ err, path: opts.profilePath }, "couldn't read profile");
      return empty;
    }
  }

  const lines = existing.split(/\r?\n/);
  const result: WriteStyleLessonsResult = { added: [], updated: [], unchanged: 0 };
  const body = sectionBody(lines, STYLE_LESSONS_HEADER);

  // Index existing managed lesson lines by their embedded id.
  const idRe = /<!--\s*id:([a-z0-9-]+)\s*-->/i;
  const lineFor = (l: { id: string; text: string }) => `- ${l.text} <!-- id:${l.id} -->`;

  if (!body) {
    // Create the section fresh with all lessons.
    for (const l of clean) result.added.push(l.id);
    const newBlock = clean.map(lineFor).join("\n");
    const trailer = existing.endsWith("\n") || existing === "" ? "" : "\n";
    const updated =
      `${existing.replace(/\s*$/, "")}${existing.trim() ? "\n" : ""}\n${STYLE_LESSONS_HEADER}\n\n${STYLE_LESSONS_NOTE}\n\n${newBlock}\n`;
    return finalizeStyleWrite(opts, updated, existing, result, log, trailer);
  }

  // Section exists: upsert each lesson by id.
  const existingIdx = new Map<string, number>();
  for (let i = body.headerIdx + 1; i < body.end; i++) {
    const m = lines[i].match(idRe);
    if (m) existingIdx.set(m[1].toLowerCase(), i);
  }
  for (const l of clean) {
    const at = existingIdx.get(l.id.toLowerCase());
    const newLine = lineFor(l);
    if (at === undefined) {
      // Append before the section end (after last non-blank line).
      let insertAt = body.end;
      while (insertAt > body.headerIdx + 1 && lines[insertAt - 1].trim() === "") insertAt--;
      lines.splice(insertAt, 0, newLine);
      // Shift any cached indices past the insert point.
      for (const [k, v] of existingIdx) if (v >= insertAt) existingIdx.set(k, v + 1);
      result.added.push(l.id);
    } else if (lines[at].trim() !== newLine.trim()) {
      lines[at] = newLine;
      result.updated.push(l.id);
    } else {
      result.unchanged++;
    }
  }
  if (result.added.length === 0 && result.updated.length === 0) return result;
  return finalizeStyleWrite(opts, lines.join("\n"), existing, result, log, "");
}

async function finalizeStyleWrite(
  opts: { profilePath: string; invalidate?: () => void },
  updated: string,
  existing: string,
  result: WriteStyleLessonsResult,
  log: Logger | undefined,
  _trailer: string,
): Promise<WriteStyleLessonsResult> {
  if (updated === existing) return result;
  try {
    // Owner profile holds personal facts/names — owner-only at rest (0600).
    await writeFile(opts.profilePath, updated, { encoding: "utf8", mode: 0o600 });
    try { await chmod(opts.profilePath, 0o600); } catch { /* best-effort */ }
    log?.info({ added: result.added, updated: result.updated }, "style lessons written");
    opts.invalidate?.();
  } catch (err) {
    log?.warn({ err, path: opts.profilePath }, "couldn't write style lessons");
    return { added: [], updated: [], unchanged: result.unchanged };
  }
  return result;
}

export interface AutoFact {
  // One terse line, sentence-cased. Examples:
  //   "Raju lives in Poolville, MD"
  //   "Manasa preferred address: Manu with old friends"
  //   "Work hours updated: Mon-Fri 10am-7pm"
  line: string;
  // Loose category — debug only, not persisted EXCEPT for the typed
  // routes below ("owner-fact" → ## Facts, "address-form"/"relationship"
  // with a target contact → ## Relationships line).
  category: "location" | "address-form" | "schedule" | "role" | "relationship" | "preference" | "owner-fact" | "other";
  // For owner-fact: the typed Facts directive to write (e.g.
  //   { key: "married", value: "yes" }
  //   { key: "spouse", value: "Manasa" }
  //   { key: "wedding anniversary", value: "2017-06-03" }).
  // Absent for non-fact categories.
  fact?: { key: string; value: string };
  // For per-contact address rules: the contact to attach the rule to and
  // the directive(s). Routed into that contact's ## Relationships line.
  contactRule?: { contact: string; addressAs?: string; never?: string[] };
}

export interface AutoUpdateResult {
  appended: AutoFact[];
  skipped: AutoFact[];
}

// Cheap regex pre-filter: if the owner's message has none of these
// signal words, skip the LLM call entirely. Catches the obvious
// teaching patterns without leaving room for false negatives.
const TEACHING_SIGNALS = /\b(lives?|moved|relocate|address|stays?|currently|now|works?\s+at|joined|left|prefers?|calls?\s+(her|him|them)|address(?:es)?\s+(her|him|them)|don'?t\s+call|never\s+call|nickname|goes?\s+by|hours?|schedule|free|busy|remember|note|by\s+the\s+way|fyi|btw|married|spouse|wife|husband|anniversary|kids?|children|birthday)\b/i;

// EXPLICIT teach-prefix patterns. When the owner starts their message
// with one of these, we ALWAYS run the extractor — bypass the
// pre-filter entirely. Catches "remember X" / "fact: X" / "note: X"
// / "fyi X" / "context: X" — anything that's deliberately a memo.
const EXPLICIT_TEACH_PREFIX =
  /^(?:remember(?:\s+this)?|fact|note|context|profile|fyi|by\s+the\s+way|btw|note\s+to\s+self|reminder)\s*[:,\-]?\s+/i;

// LLM extraction prompt. The bridge supplies an LLM caller so this
// module stays transport-agnostic (could be the control-plane proxy,
// a local model, or a test mock).
const EXTRACT_PROMPT_PREAMBLE = [
  "You extract STRUCTURED FACTS about the owner's world from a single",
  "self-chat message they sent themselves. The owner is using the bot as",
  "a memory layer — they're sharing context so future replies are smarter.",
  "",
  "Return a JSON object: {\"facts\": [{\"category\": \"...\", \"line\": \"...\"}]}",
  "",
  "Categories: location, address-form, schedule, role, relationship,",
  "preference, owner-fact, other.",
  "",
  "TWO categories carry EXTRA typed fields:",
  "",
  "A) owner-fact — a SELF/biographical fact about the owner themselves",
  "   (their marriage, spouse, kids, a personal key date like an",
  "   anniversary/birthday). Add a `fact` object: {\"key\":..., \"value\":...}.",
  "   - \"I'm married\" → {\"category\":\"owner-fact\",\"line\":\"married\",\"fact\":{\"key\":\"married\",\"value\":\"yes\"}}",
  "   - \"my wife is Manasa\" → {\"category\":\"owner-fact\",\"line\":\"spouse: Manasa\",\"fact\":{\"key\":\"spouse\",\"value\":\"Manasa\"}}",
  "   - \"my anniversary is June 3 2017\" → {\"category\":\"owner-fact\",\"line\":\"wedding anniversary 2017-06-03\",\"fact\":{\"key\":\"wedding anniversary\",\"value\":\"2017-06-03\"}}",
  "   Dates in `fact.value` MUST be YYYY-MM-DD. key for marital state is",
  "   exactly \"married\" with value \"yes\"; spouse key is \"spouse\";",
  "   kids key is \"kids\" with comma-separated value.",
  "",
  "B) address-form / relationship that is a PER-CONTACT NAMING RULE",
  "   (\"don't call Sujith bava\", \"address Sujith by his name\"). Add a",
  "   `contactRule` object: {\"contact\":..., \"addressAs\":?, \"never\":[...]}.",
  "   - \"don't call Sujith bava\" → {\"category\":\"address-form\",\"line\":\"never call Sujith bava\",\"contactRule\":{\"contact\":\"Sujith\",\"never\":[\"bava\"]}}",
  "   - \"address Sujith by his name\" → {\"category\":\"address-form\",\"line\":\"address Sujith by name\",\"contactRule\":{\"contact\":\"Sujith\",\"addressAs\":\"Sujith\"}}",
  "",
  "RULES:",
  "1. Each `line` is ONE terse fact, max 80 chars, factual sentence form.",
  '   GOOD: "Raju lives in Poolville, MD" / "Sirisha lives in Spokane, WA"',
  '   BAD:  "I just wanted to mention that Raju is currently residing in..."',
  "2. ONLY return facts the owner is volunteering as durable context.",
  "   Not: passing comments, jokes, questions, queries, what-ifs.",
  "3. If you're not 90% sure it's a real persistent fact, OMIT IT.",
  '4. Return {"facts": []} for non-teaching messages (queries, commands,',
  "   conversational chatter).",
  '5. Strip filler: "Also note that Raju..." → "Raju lives in Poolville, MD".',
  "6. Resolve obvious pronouns ('she lives in Atlanta' → use the most",
  "   recently mentioned person if obvious, else omit).",
  "7. Combine related multi-fact messages — one line per distinct fact.",
  "",
  "Owner message:",
].join("\n");

export interface AutoUpdateOptions {
  // Path to the owner-profile.md file. Defaults to ~/.lantern/owner-profile.md.
  profilePath: string;
  // LLM caller — returns the raw JSON string. The bridge wires this
  // to its existing completions client.
  llmCall: (prompt: string) => Promise<string>;
  // Optional: the OwnerProfileStore's invalidate() so the freshly-written
  // facts / contact rules go live without waiting for the reload TTL.
  // Called once after a successful write.
  invalidate?: () => void;
  logger?: Logger;
}

/**
 * Inspect a single owner self-chat message; if it contains durable
 * facts, append them to the profile. Returns what was added.
 *
 * Safe to call on every self-chat message: the regex pre-filter
 * short-circuits when there's no teaching signal, so the LLM cost is
 * limited to messages that actually need extraction.
 */
export async function maybeAutoUpdateOwnerProfile(
  ownerMessage: string,
  opts: AutoUpdateOptions,
): Promise<AutoUpdateResult> {
  const log = opts.logger?.child({ component: "owner-profile-auto-update" });
  const msg = (ownerMessage || "").trim();
  if (msg.length < 8 || msg.length > 2000) {
    return { appended: [], skipped: [] };
  }

  // Two acceptance paths:
  //   (a) explicit teach prefix ("remember X" / "fact: X" / "fyi …")
  //       → ALWAYS run the extractor, even if the loose teaching
  //       regex wouldn't have matched. This lets the owner force a
  //       save from their phone with a deliberate trigger word.
  //   (b) implicit signals (lives/moved/works/etc.) → run extractor.
  const isExplicit = EXPLICIT_TEACH_PREFIX.test(msg);
  if (!isExplicit && !TEACHING_SIGNALS.test(msg)) {
    return { appended: [], skipped: [] };
  }
  // When the explicit prefix matched, strip it from the message that
  // gets shipped to the extractor — the LLM doesn't need to see the
  // wrapping verb, just the fact.
  const messageForLLM = isExplicit ? msg.replace(EXPLICIT_TEACH_PREFIX, "").trim() : msg;

  // LLM extraction.
  let raw: string;
  try {
    raw = await opts.llmCall(`${EXTRACT_PROMPT_PREAMBLE}\n${messageForLLM}\n\nJSON:`);
  } catch (err) {
    log?.warn({ err }, "extraction LLM call failed");
    return { appended: [], skipped: [] };
  }

  let parsed: { facts?: AutoFact[] };
  try {
    // Some LLMs wrap JSON in code fences — strip them.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    parsed = JSON.parse(cleaned);
  } catch (err) {
    log?.warn({ err, raw: raw.slice(0, 200) }, "extraction returned non-JSON");
    return { appended: [], skipped: [] };
  }

  const candidates = Array.isArray(parsed.facts) ? parsed.facts : [];
  if (candidates.length === 0) {
    return { appended: [], skipped: [] };
  }

  // Normalize + validate each fact.
  const normalized: AutoFact[] = [];
  const seen = new Set<string>();
  for (const f of candidates) {
    if (!f || typeof f.line !== "string") continue;
    const line = f.line.trim().replace(/^[-•*]\s*/, "");
    if (line.length === 0 || line.length > 120) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: AutoFact = {
      line,
      category: (f.category as AutoFact["category"]) || "other",
    };
    // Preserve the typed routing fields when the LLM supplied them.
    if (f.fact && typeof f.fact.key === "string" && typeof f.fact.value === "string") {
      const key = f.fact.key.trim().toLowerCase();
      const value = f.fact.value.trim();
      if (key && value) entry.fact = { key, value };
    }
    if (f.contactRule && typeof f.contactRule.contact === "string") {
      const contact = f.contactRule.contact.trim();
      if (contact) {
        const addressAs =
          typeof f.contactRule.addressAs === "string" ? f.contactRule.addressAs.trim() : undefined;
        const never = Array.isArray(f.contactRule.never)
          ? f.contactRule.never.map((t) => String(t).trim()).filter(Boolean)
          : undefined;
        if (addressAs || (never && never.length)) {
          entry.contactRule = {
            contact,
            ...(addressAs ? { addressAs } : {}),
            ...(never && never.length ? { never } : {}),
          };
        }
      }
    }
    normalized.push(entry);
  }
  if (normalized.length === 0) {
    return { appended: [], skipped: [] };
  }

  // Read existing profile so we can dedup against it.
  let existing = "";
  if (existsSync(opts.profilePath)) {
    try {
      existing = await readFile(opts.profilePath, "utf8");
    } catch (err) {
      log?.warn({ err, path: opts.profilePath }, "couldn't read profile");
      return { appended: [], skipped: [] };
    }
  }

  // Split the candidates into TYPED routes (owner-facts → ## Facts,
  // per-contact rules → ## Relationships) and GENERIC auto-learn. Typed
  // entries are written into their structured home so the parser reads
  // them as ground truth, not as a flat blob — and so the bot stops
  // denying the owner's marriage / mis-addressing a contact.
  const typed: AutoFact[] = [];
  const generic: AutoFact[] = [];
  for (const fact of normalized) {
    if (fact.fact || fact.contactRule) typed.push(fact);
    else generic.push(fact);
  }

  // `updated` threads through every mutation so multiple facts/rules in
  // one message all land. Start from disk content.
  let updated = existing;
  const appended: AutoFact[] = [];
  const skipped: AutoFact[] = [];

  // ── Typed routes ──
  for (const fact of typed) {
    let next: string | null = null;
    if (fact.fact) {
      next = upsertFact(updated, fact.fact.key, fact.fact.value);
    } else if (fact.contactRule) {
      next = mergeContactRule(updated, fact.contactRule.contact, {
        addressAs: fact.contactRule.addressAs,
        never: fact.contactRule.never,
      });
    }
    if (next === null) {
      // No change (already present, or contact line not found).
      skipped.push(fact);
      continue;
    }
    updated = next;
    appended.push(fact);
  }

  // ── Generic auto-learn (unchanged dedup + managed-section append) ──
  // Dedup against current content. The check is case-insensitive
  // substring match: if a meaningful chunk of the new fact already
  // appears in the profile, skip it.
  const genericToAppend: AutoFact[] = [];
  {
    const lower0 = updated.toLowerCase();
    for (const fact of generic) {
      const lower = fact.line.toLowerCase();
      const tokens = lower.split(/\s+/).filter((t) => t.length >= 4);
      const allTokensPresent =
        tokens.length >= 2 && tokens.every((t) => lower0.includes(t));
      if (lower0.includes(lower) || allTokensPresent) {
        skipped.push(fact);
        continue;
      }
      genericToAppend.push(fact);
    }
  }
  if (genericToAppend.length > 0) {
    const newLines = genericToAppend.map((f) => `- ${f.line}`).join("\n");
    const hasManagedSection = updated.includes(MANAGED_HEADER);
    if (hasManagedSection) {
      updated = updated.replace(/\s*$/, "") + "\n" + newLines + "\n";
    } else {
      const trailer = updated.endsWith("\n") ? "" : "\n";
      updated = `${updated}${trailer}\n${MANAGED_HEADER}\n\n${MANAGED_NOTE}\n\n${newLines}\n`;
    }
    appended.push(...genericToAppend);
  }

  if (appended.length === 0 || updated === existing) {
    return { appended: [], skipped };
  }

  try {
    // Owner profile holds personal facts/names — owner-only at rest (0600).
    await writeFile(opts.profilePath, updated, { encoding: "utf8", mode: 0o600 });
    try { await chmod(opts.profilePath, 0o600); } catch { /* best-effort */ }
    log?.info(
      { added: appended.length, skipped: skipped.length },
      "owner profile auto-updated",
    );
    // Push the freshly-written content live so the next reply sees it.
    opts.invalidate?.();
  } catch (err) {
    log?.warn({ err, path: opts.profilePath }, "couldn't write profile");
    return { appended: [], skipped };
  }

  return { appended, skipped };
}

/**
 * Build a one-line ack the bridge sends back to the owner's self-chat
 * so they SEE what the bot learned. Format chosen to be terse + easy
 * to spot in a chat: "📝 noted — Raju in Poolville, MD".
 */
export function formatAck(appended: AutoFact[]): string {
  if (appended.length === 0) return "";
  if (appended.length === 1) return `📝 noted — ${appended[0].line.toLowerCase()}`;
  return `📝 noted:\n${appended.map((f) => `• ${f.line.toLowerCase()}`).join("\n")}`;
}
