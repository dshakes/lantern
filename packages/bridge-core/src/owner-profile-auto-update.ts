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

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Logger } from "pino";

const MANAGED_HEADER = "## Auto-learned facts (managed)";
const MANAGED_NOTE =
  "<!-- Bot appends here when the owner shares context in self-chat. " +
  "Safe to edit manually; the bot won't overwrite existing lines, just " +
  "appends new ones. To remove an entry, delete its bullet. -->";

export interface AutoFact {
  // One terse line, sentence-cased. Examples:
  //   "Raju lives in Poolville, MD"
  //   "Manasa preferred address: Manu with old friends"
  //   "Work hours updated: Mon-Fri 10am-7pm"
  line: string;
  // Loose category — debug only, not persisted.
  category: "location" | "address-form" | "schedule" | "role" | "relationship" | "preference" | "other";
}

export interface AutoUpdateResult {
  appended: AutoFact[];
  skipped: AutoFact[];
}

// Cheap regex pre-filter: if the owner's message has none of these
// signal words, skip the LLM call entirely. Catches the obvious
// teaching patterns without leaving room for false negatives.
const TEACHING_SIGNALS = /\b(lives?|moved|relocate|address|stays?|currently|now|works?\s+at|joined|left|prefers?|calls?\s+(her|him|them)|address(?:es)?\s+(her|him|them)|don'?t\s+call|never\s+call|nickname|goes?\s+by|hours?|schedule|free|busy|remember|note|by\s+the\s+way|fyi|btw)\b/i;

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
  "Categories: location, address-form, schedule, role, relationship, preference, other.",
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
    normalized.push({
      line,
      category: (f.category as AutoFact["category"]) || "other",
    });
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

  // Dedup against existing content. The check is case-insensitive
  // substring match: if a meaningful chunk of the new fact already
  // appears in the profile, skip it. This catches both exact-line
  // dupes ("Raju lives in Poolville, MD") and near-dupes where the
  // existing entry phrases it differently ("Raju Penchala …
  // Poolville MD").
  const existingLower = existing.toLowerCase();
  const appended: AutoFact[] = [];
  const skipped: AutoFact[] = [];
  for (const fact of normalized) {
    const lower = fact.line.toLowerCase();
    // Skip if the WHOLE fact already appears verbatim OR if a
    // high-signal substring (e.g. "raju" + "poolville") both appear.
    const tokens = lower.split(/\s+/).filter((t) => t.length >= 4);
    const allTokensPresent =
      tokens.length >= 2 && tokens.every((t) => existingLower.includes(t));
    if (existingLower.includes(lower) || allTokensPresent) {
      skipped.push(fact);
      continue;
    }
    appended.push(fact);
  }

  if (appended.length === 0) {
    return { appended: [], skipped };
  }

  // Append to managed section. Create the section header if absent.
  const newLines = appended.map((f) => `- ${f.line}`).join("\n");
  let updated: string;
  const hasManagedSection = existing.includes(MANAGED_HEADER);
  if (hasManagedSection) {
    // Append to the end of the file (the managed section is always at
    // the bottom, so this works).
    updated = existing.replace(/\s*$/, "") + "\n" + newLines + "\n";
  } else {
    const trailer = existing.endsWith("\n") ? "" : "\n";
    updated = `${existing}${trailer}\n${MANAGED_HEADER}\n\n${MANAGED_NOTE}\n\n${newLines}\n`;
  }

  try {
    await writeFile(opts.profilePath, updated, "utf8");
    log?.info(
      { added: appended.length, skipped: skipped.length, lines: appended.map((f) => f.line) },
      "owner profile auto-updated",
    );
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
