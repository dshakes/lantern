//! Owner profile — a first-person, owner-curated description of who the
//! owner is and how they communicate. This is the single biggest lever
//! for making the bot "sound like me".
//!
//! SECURITY MODEL — read before extending:
//!   - The profile is a LOCAL file the owner writes by hand. It never
//!     leaves the machine except as persona context in the LLM call
//!     (same trust boundary as the message itself).
//!   - It is meant for VOICE + IDENTITY + RELATIONSHIPS — "I'm a founder,
//!     I text in lowercase, my brother is Shiva". It is NOT a dumping
//!     ground for secrets. Anything in here can end up shaping a reply to
//!     a third party, so the owner curates it deliberately.
//!   - Raw Gmail / personal-docs content is DELIBERATELY NOT auto-loaded
//!     here. Those are private and would leak if surfaced in a reply to
//!     someone else. The owner can paste a hand-written summary ("I'm
//!     mid-launch on Lantern") but the system never scrapes mailboxes
//!     into outbound replies. Owner's OWN queries (self-chat) use the
//!     personal-docs pipeline, which is separately gated to the owner.
//!
//! File location: $LANTERN_OWNER_PROFILE, else ~/.lantern/owner-profile.md.
//! Hot-reloaded with a short TTL so edits take effect without a restart.

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { canonicalHandle } from "./canonical-handle.js";

/** Structured biographical facts about the owner. These are GROUND
 *  TRUTH — the bot must never deny or contradict them when a contact
 *  references one (marriage, family, key dates). Parsed from a
 *  "## Facts" section. All fields optional; absent when not declared. */
export interface OwnerFacts {
  maritalStatus?: "married" | "single" | "engaged" | "divorced" | "widowed";
  spouse?: string;
  kids?: string[];
  keyDates?: { label: string; date: string }[];
}

/** Per-contact addressing rules parsed from the extended Relationships
 *  grammar ("- Name: rel | address as: X | never: a, b"). Lets the bot
 *  use the right name for a contact and avoid kinship terms the owner
 *  doesn't actually use with them. */
export interface AddressRule {
  addressAs?: string;
  neverCall?: string[];
}

export interface OwnerProfile {
  /** The free-form first-person prose (everything except the parsed
   *  relationships block). Injected into the persona prompt. */
  prose: string;
  /** handle/name (lowercased) -> relationship label. Parsed from a
   *  "## Relationships" section if present. */
  relationships: Map<string, string>;
  /** handle/name (lowercased) -> per-contact address rule. Same keying
   *  as `relationships`. Only populated for contacts whose Relationships
   *  line carries "address as:" / "never:" suffixes. */
  addressRules: Map<string, AddressRule>;
  /** alias handle (canonicalized phone digits / lowercased email, keyed
   *  the same way as `relationships`) -> the PRIMARY contact's display
   *  name (as written in the profile). Populated from the "also: +N, +M"
   *  segment of a Relationships line. Lets a contact reaching the owner
   *  from a second/new number resolve to the same person + relationship,
   *  so history isn't cold. The alias numbers are ALSO mirrored into
   *  `relationships` + `addressRules` so relationshipFor / addressRuleFor
   *  match them transparently. */
  aliases: Map<string, string>;
  /** Structured biographical facts (marital status, spouse, kids, key
   *  dates). Parsed from a "## Facts" section. Undefined when absent. */
  facts?: OwnerFacts;
  /** One-line nativity/origin string from a "## Nativity" or
   *  "## Languages" section, used by the language-modality hint so the
   *  bot replies in the right regional dialect. Empty when not set. */
  nativity: string;
}

const RELOAD_TTL_MS = 30_000;

export class OwnerProfileStore {
  private logger: Logger;
  private path: string;
  private cache: OwnerProfile | null = null;
  private cachedAt = 0;
  private lastMtimeMs = 0;

  constructor(logger: Logger, path?: string) {
    this.logger = logger.child({ component: "owner-profile" });
    this.path =
      path ||
      process.env.LANTERN_OWNER_PROFILE ||
      join(homedir(), ".lantern", "owner-profile.md");
  }

  /** Absolute path on disk. Exposed so auto-updaters can write
   *  back to the same file the store reads from. */
  getPath(): string {
    return this.path;
  }

  /** Force an immediate reload on the next `get()`. Call this after
   *  externally mutating the profile file (e.g. auto-updater appended
   *  new facts) so the LLM sees fresh content without waiting for
   *  TTL expiry. */
  invalidate(): void {
    this.cache = null;
    this.cachedAt = 0;
    this.lastMtimeMs = 0;
  }

  /** Return the parsed profile, reloading if the file changed or the TTL
   *  expired. Returns null when no profile file exists (feature off). */
  get(): OwnerProfile | null {
    const now = Date.now();
    if (this.cache && now - this.cachedAt < RELOAD_TTL_MS) return this.cache;

    if (!existsSync(this.path)) {
      this.cache = null;
      this.cachedAt = now;
      return null;
    }
    try {
      const mtime = statSync(this.path).mtimeMs;
      // Cheap mtime check so we don't re-parse on every TTL tick when
      // the file is unchanged.
      if (this.cache && mtime === this.lastMtimeMs) {
        this.cachedAt = now;
        return this.cache;
      }
      const raw = readFileSync(this.path, "utf8");
      this.cache = parseProfile(raw);
      this.lastMtimeMs = mtime;
      this.cachedAt = now;
      this.logger.info(
        { path: this.path, relationships: this.cache.relationships.size },
        "loaded owner profile",
      );
      return this.cache;
    } catch (err) {
      this.logger.warn({ err, path: this.path }, "failed to read owner profile");
      this.cache = null;
      this.cachedAt = now;
      return null;
    }
  }

  /** Resolve the relationship label for a contact, matching by handle or
   *  display name (case-insensitive). Returns undefined when unknown. */
  relationshipFor(handle: string, displayName?: string): string | undefined {
    const prof = this.get();
    if (!prof) return undefined;
    const keys = lookupKeys(handle, displayName);
    for (const k of keys) {
      const hit = prof.relationships.get(k);
      if (hit) return hit;
    }
    return uniqueTokenMatch(prof.relationships, keys) ?? undefined;
  }

  /** Re-identification: given any handle (including an alias / second
   *  number declared via "also: …" in the Relationships section), return
   *  the PRIMARY contact's display name as written in the profile, or
   *  undefined when the handle isn't a known alias. Lets the bridge map a
   *  new number to a known person so their history + name aren't cold.
   *  Matches by canonicalized handle and bare digits. */
  canonicalNameFor(handle: string, displayName?: string): string | undefined {
    const prof = this.get();
    if (!prof || prof.aliases.size === 0) return undefined;
    const keys = lookupKeys(handle, displayName);
    for (const k of keys) {
      const hit = prof.aliases.get(k);
      if (hit) return hit;
    }
    return undefined;
  }

  /** The prose block for injection into the persona prompt. */
  prose(): string {
    return this.get()?.prose ?? "";
  }

  /** One-line nativity / origin string used to bias the LLM toward
   *  the owner's regional dialect when replying in a non-English
   *  language. Returns "" when the profile has no Nativity section. */
  nativity(): string {
    return this.get()?.nativity ?? "";
  }

  /** Formatted "Name → relationship" lines for prompt injection. Used
   *  by the agentic pipeline so the LLM can answer "who is my son?" /
   *  "what's my wife's name?" directly from profile knowledge, without
   *  a tool-loop timeout. Returns "" when no relationships are set. */
  relationshipsBlock(): string {
    const prof = this.get();
    if (!prof || prof.relationships.size === 0) return "";
    // Dedup by relationship-label so the same person doesn't appear
    // twice when they're keyed by both display-name and phone-number.
    const seenLabel = new Set<string>();
    const lines: string[] = [];
    for (const [name, rel] of prof.relationships) {
      // Skip the all-digits keys (phone-number fallbacks) — keep the
      // human-readable name key for the prompt.
      if (/^\d+$/.test(name)) continue;
      const key = `${name}|${rel}`;
      if (seenLabel.has(key)) continue;
      seenLabel.add(key);
      // Title-case the name for prompt readability.
      const titled = name
        .split(/\s+/)
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ");
      lines.push(`- ${titled}: ${rel}`);
    }
    if (lines.length === 0) return "";
    return ["The owner's people (use these names directly when asked about family/friends — do not call tools):", ...lines].join("\n");
  }

  /** Deterministic single-line summary of the owner's structured facts,
   *  framed as ground truth the bot must never deny. Returns "" when no
   *  facts are set. Example:
   *    "Owner facts (TRUE — never deny or contradict these): married to
   *     Manasa; kids: Aarav, Anaya; wedding anniversary June 3, 2017." */
  factsBlock(): string {
    const facts = this.get()?.facts;
    if (!facts) return "";
    const parts: string[] = [];
    if (facts.maritalStatus) {
      if (facts.maritalStatus === "married" && facts.spouse) {
        parts.push(`married to ${facts.spouse}`);
      } else if (facts.maritalStatus === "married") {
        parts.push("married");
      } else {
        parts.push(facts.maritalStatus);
      }
    } else if (facts.spouse) {
      // Spouse named without an explicit marital status — still implies married.
      parts.push(`married to ${facts.spouse}`);
    }
    if (facts.kids?.length) {
      parts.push(`kids: ${facts.kids.join(", ")}`);
    }
    if (facts.keyDates?.length) {
      for (const kd of facts.keyDates) {
        parts.push(`${kd.label} ${humanizeDate(kd.date)}`);
      }
    }
    if (parts.length === 0) return "";
    return `Owner facts (TRUE — never deny or contradict these): ${parts.join("; ")}.`;
  }

  /** Resolve the per-contact address rule (addressAs / neverCall) for a
   *  contact, matching by handle or display name the same way
   *  relationshipFor does. Returns null when the contact has no rule. */
  addressRuleFor(handleOrName: string, displayName?: string): AddressRule | null {
    const prof = this.get();
    if (!prof) return null;
    const keys = lookupKeys(handleOrName, displayName);
    for (const k of keys) {
      const hit = prof.addressRules.get(k);
      if (hit) return hit;
    }
    return uniqueTokenMatch(prof.addressRules, keys);
  }

  /** Lowercase FIRST names parsed from the Relationships section.
   *  Used by the cross-contact episode extractor so the bot can spot
   *  "Sujith reached home" in self-chat and tag the episode with
   *  ["sujith"] for later recall when Sujith messages. Always includes
   *  the owner's own first name too (when known) so phrases like "had
   *  lunch with Sujith" tag him correctly. */
  knownFirstNames(): string[] {
    const prof = this.get();
    const out = new Set<string>();
    if (prof) {
      for (const [name] of prof.relationships) {
        if (/^\d+$/.test(name)) continue;
        const first = name.split(/\s+/)[0]?.toLowerCase();
        if (first && first.length >= 2) out.add(first);
      }
    }
    const ownerName = (process.env.LANTERN_OWNER_NAME || "").trim().toLowerCase();
    if (ownerName) out.add(ownerName);
    return Array.from(out);
  }

  /** Reverse lookup: given a role label like "son" / "wife" / "elder
   *  brother", return the names that match. Used for instant deterministic
   *  answers like "who is my son?". Case-insensitive, substring match
   *  (so "brother" matches "elder brother" and "brother-in-law"). */
  findByRelationship(role: string): string[] {
    const prof = this.get();
    if (!prof) return [];
    const r = role.toLowerCase().trim();
    if (!r) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const [name, rel] of prof.relationships) {
      if (/^\d+$/.test(name)) continue;
      if (rel.toLowerCase().includes(r) && !seen.has(name)) {
        seen.add(name);
        const titled = name
          .split(/\s+/)
          .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
          .join(" ");
        out.push(titled);
      }
    }
    return out;
  }
}

/** Parse the markdown profile. The "## Relationships" section (if present)
 *  is pulled out as a name→relationship map; everything else is prose.
 *
 *  Relationships section format (one per line):
 *    - Shiva: brother
 *    - +15125551234: college roommate
 *    - alex@work.com: my manager
 */
/** Format an ISO-ish date ("2017-06-03") as a human-friendly string
 *  ("June 3, 2017"). Returns the input unchanged when it's not a
 *  recognizable YYYY-MM-DD date. */
export function humanizeDate(date: string): string {
  const m = date.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return date.trim();
  const [, y, mo, d] = m;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const monthName = months[parseInt(mo, 10) - 1];
  if (!monthName) return date.trim();
  return `${monthName} ${parseInt(d, 10)}, ${y}`;
}

// Build the ordered list of candidate lookup keys for a handle + optional
// display name, matching how relationships/addressRules/aliases are indexed:
//   - lowercased handle verbatim
//   - canonicalized handle (jid suffix stripped, US numbers +1-promoted,
//     emails lowercased) — so an alias declared as "+15551234567" matches
//     an inbound jid "15551234567@s.whatsapp.net"
//   - lowercased display name
//   - bare digits of the handle (phone fallback)
// De-duped, falsy dropped.
function lookupKeys(handle: string, displayName?: string): string[] {
  const out: string[] = [];
  const push = (k: string | undefined) => {
    if (k && !out.includes(k)) out.push(k);
  };
  if (handle) {
    push(handle.toLowerCase());
    push(canonicalHandle(handle).toLowerCase());
  }
  if (displayName) push(displayName.toLowerCase());
  if (handle) push(handle.replace(/[^\d]/g, ""));
  return out.filter(Boolean);
}

// Fallback matcher: when no exact key matches, try matching a single-token
// input (e.g. a first name "sujith") against profile keys that contain that
// token ("sujith penchala"). Returns the value ONLY when exactly one distinct
// key matches — never guesses on ambiguity (e.g. two "madhu ..." entries).
function uniqueTokenMatch<T>(map: Map<string, T>, inputs: string[]): T | null {
  const tokens = inputs
    .filter((s) => s && /^[a-z][a-z'.-]{2,}$/.test(s)) // single alpha token, len>=3
    .map((s) => s.trim());
  if (tokens.length === 0) return null;
  for (const tok of tokens) {
    const hits: T[] = [];
    const seenKeys = new Set<string>();
    for (const [k, v] of map) {
      if (k.split(/\s+/).includes(tok) && !seenKeys.has(k)) {
        seenKeys.add(k);
        hits.push(v);
      }
    }
    if (hits.length === 1) return hits[0];
  }
  return null;
}

export function parseProfile(raw: string): OwnerProfile {
  const relationships = new Map<string, string>();
  const addressRules = new Map<string, AddressRule>();
  const aliases = new Map<string, string>();
  const facts: OwnerFacts = {};
  const proseLines: string[] = [];
  const nativityLines: string[] = [];

  // Markdown section heading: "## Title". We only treat level-2+ ("##",
  // "###", ...) as section boundaries. A single "#" is reserved for the
  // top title AND for the comment lines the template leaves inside the
  // relationships block ("# Format: ...") — those must NOT end the
  // section, or none of the entries below them parse.
  const sectionHeading = (line: string): string | null => {
    const m = line.match(/^(#{2,6})\s+(.*)$/);
    return m ? m[2].trim() : null;
  };

  const lines = raw.split(/\r?\n/);
  let inRelationships = false;
  let inNativity = false;
  let inFacts = false;
  // Everything before the first "## " section (the "# Owner profile"
  // title + the "Do NOT put secrets here" instructional preamble) is
  // guidance for the human, NOT content about the owner. Skip it so it
  // never leaks into the persona prompt as if it described them.
  let seenFirstSection = false;
  for (const line of lines) {
    const section = sectionHeading(line);
    if (section !== null) {
      seenFirstSection = true;
      inRelationships = /relationship|contacts?|people/i.test(section);
      // "## Nativity", "## Languages", "## Origin", "## Background" all
      // map to the nativity slot. The line itself stays in prose so the
      // model still sees the header text.
      inNativity = /\b(nativity|language|languages|origin|mother\s*tongue|background\s+&\s+language)\b/i.test(section);
      // "## Facts" — structured biographical ground truth. Kept OUT of
      // prose (it's typed data injected via factsBlock(), not free-form
      // voice) the same way the Relationships section is.
      inFacts = /^facts\b/i.test(section) || /\bowner\s+facts\b/i.test(section);
      if (!inRelationships && !inFacts) proseLines.push(line);
      continue;
    }
    if (!seenFirstSection) continue; // pre-section preamble — drop
    if (inNativity) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        // Strip leading list marker for the dedicated nativity slot.
        nativityLines.push(trimmed.replace(/^[-*]\s*/, ""));
      }
      // Fall through to prose so it also lives in the free-form context.
      proseLines.push(line);
      continue;
    }
    if (inFacts) {
      const trimmed = line.trim();
      // Skip blank lines + comment lines (guidance, not data).
      if (!trimmed || trimmed.startsWith("#")) continue;
      // "- key: value" / "* key: value" / "key: value". Split on the
      // FIRST colon so date values ("2017-06-03") survive.
      const m = trimmed.match(/^[-*]?\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      const val = m[2].trim().replace(/^<\s*|\s*>$/g, "").trim();
      if (!key || !val) continue;
      const valLc = val.toLowerCase();
      if (key === "married") {
        // "- married: yes" → maritalStatus "married". "no" leaves it unset.
        if (/^(yes|true|y)$/i.test(val)) facts.maritalStatus = "married";
      } else if (key === "marital status" || key === "marital-status") {
        if (/^(married|single|engaged|divorced|widowed)$/i.test(valLc)) {
          facts.maritalStatus = valLc as OwnerFacts["maritalStatus"];
        }
      } else if (key === "spouse" || key === "wife" || key === "husband" || key === "partner") {
        facts.spouse = val;
      } else if (key === "kids" || key === "children") {
        const kids = val.split(",").map((k) => k.trim()).filter(Boolean);
        if (kids.length) facts.kids = kids;
      } else if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(val)) {
        // "- wedding anniversary: 2017-06-03" → a key date keyed by label.
        (facts.keyDates ??= []).push({ label: m[1].trim(), date: val });
      }
      continue;
    }
    if (inRelationships) {
      const trimmed = line.trim();
      // Skip blank lines, the top "# Owner profile" title, and the
      // template's "# ..." comment lines — they're guidance, not data.
      if (!trimmed || trimmed.startsWith("#")) continue;

      // Extended grammar: the relationship value may carry pipe-delimited
      // address directives:
      //   "- Name: relationship | address as: X | never: a, b"
      // Split the line into the "Name: relationship" head and any
      // "address as:" / "never:" clauses. Plain "Name: relationship"
      // (no pipes) is fully backward-compatible.
      const segments = trimmed.split("|").map((s) => s.trim());
      const head = segments[0];

      // "- Name: relationship" / "* Name: relationship" / "Name: relationship".
      // Split on the FIRST colon so values like "brother-in-law, Raju's
      // spouse" survive intact.
      const m = head.match(/^[-*]?\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const rawKey = m[1].trim();
      // Strip template angle brackets the user may have kept ("<friend>"
      // → "friend"). If the value is STILL an empty placeholder after
      // stripping, skip it (the contact isn't really tagged yet).
      const val = m[2].trim().replace(/^<\s*|\s*>$/g, "").trim();
      if (!rawKey || !val) continue;

      // Parse the extra address directives from the remaining segments.
      let addressAs: string | undefined;
      let neverCall: string[] | undefined;
      let aliasHandles: string[] = [];
      for (const seg of segments.slice(1)) {
        const am = seg.match(/^address\s+as\s*:\s*(.+)$/i);
        if (am) {
          addressAs = am[1].trim().replace(/^["']|["']$/g, "").trim() || undefined;
          continue;
        }
        const nm = seg.match(/^never\s*:\s*(.+)$/i);
        if (nm) {
          const terms = nm[1]
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, "").trim())
            .filter(Boolean);
          if (terms.length) neverCall = terms;
          continue;
        }
        // "also: +15551234567, +15559876543" — additional handles (a
        // second number, a work email) that belong to THIS same person.
        // Used for re-identification so a contact reaching the owner from
        // a new number still resolves to their name + relationship.
        const alm = seg.match(/^(?:also|alias|aliases|aka)\s*:\s*(.+)$/i);
        if (alm) {
          aliasHandles = alm[1]
            .split(",")
            .map((t) => t.trim().replace(/^["']|["']$/g, "").trim())
            .filter(Boolean);
        }
      }
      const rule: AddressRule | null =
        addressAs || neverCall ? { ...(addressAs ? { addressAs } : {}), ...(neverCall ? { neverCall } : {}) } : null;

      const indexKey = (k: string) => {
        const lc = k.trim().toLowerCase();
        if (lc) {
          relationships.set(lc, val);
          if (rule) addressRules.set(lc, rule);
        }
        const digits = lc.replace(/[^\d]/g, "");
        if (digits.length >= 7) {
          relationships.set(digits, val);
          if (rule) addressRules.set(digits, rule);
        }
      };

      // Index the full key plus any parenthetical alias, so both
      // "Manasa(Manu)" and the bare "Manasa" / "Manu" match a contact's
      // display name.
      indexKey(rawKey);
      const paren = rawKey.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      if (paren) {
        indexKey(paren[1]); // "Manasa"
        indexKey(paren[2]); // "Manu"
      }

      // Alias handles ("also: +1555..., work@x.com") — index each so the
      // SAME relationship + address rule resolves from a second number,
      // and record the alias→primary-name mapping for re-identification.
      // Phone/email aliases are canonicalized (digits-only / lowercased)
      // to match how the bridge keys inbound handles.
      const primaryName = (paren ? paren[1] : rawKey).trim();
      for (const alias of aliasHandles) {
        const canon = canonicalHandle(alias);
        if (!canon) continue;
        relationships.set(canon, val);
        if (rule) addressRules.set(canon, rule);
        aliases.set(canon, primaryName);
        // Also index a bare digits form for phone aliases the bridge may
        // look up without canonicalization (defense in depth — cheap).
        const digits = alias.replace(/[^\d]/g, "");
        if (digits.length >= 7 && digits !== canon) {
          relationships.set(digits, val);
          if (rule) addressRules.set(digits, rule);
          aliases.set(digits, primaryName);
        }
      }
      continue;
    }
    proseLines.push(line);
  }

  const hasFacts =
    facts.maritalStatus !== undefined ||
    facts.spouse !== undefined ||
    (facts.kids?.length ?? 0) > 0 ||
    (facts.keyDates?.length ?? 0) > 0;

  return {
    prose: proseLines.join("\n").trim(),
    relationships,
    addressRules,
    aliases,
    facts: hasFacts ? facts : undefined,
    nativity: nativityLines.join(" ").trim(),
  };
}

/** A starter template written to the profile path on first run if none
 *  exists and the owner runs `lantern profile init` (or the bridge logs
 *  the hint). Exported so the CLI / setup docs can reuse it. */
export const OWNER_PROFILE_TEMPLATE = `# Owner profile

Write this in first person. The bot reads it to sound like you — your
voice, your world, your people. Keep it tight; this is shaping every
reply. Do NOT put secrets here (passwords, card numbers) — it can
influence replies to other people.

## About me
I'm <name> — <role / what you do>. <one or two lines on current focus>.

## How I text
- <e.g. lowercase, short, dry humor, rarely use periods>
- <e.g. emojis sparingly, never formal>
- <e.g. I say "yeah"/"lol"/"for sure", never "certainly">

## My world
- <current projects, what's keeping you busy>
- <city / timezone>
- <anything a close friend would just know>

## Facts
- married: yes
- spouse: <name>
- kids: <child a>, <child b>
- wedding anniversary: <YYYY-MM-DD>

## Relationships
- Shiva: brother
- <Name>: <relationship> | address as: <what to call them> | never: <terms to avoid>
- <Name>: <relationship> | also: <+1555..., second@email> (extra numbers/emails for the SAME person)
- <Name or phone or email>: <relationship>
`;
