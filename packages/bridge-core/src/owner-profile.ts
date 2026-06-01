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

export interface OwnerProfile {
  /** The free-form first-person prose (everything except the parsed
   *  relationships block). Injected into the persona prompt. */
  prose: string;
  /** handle/name (lowercased) -> relationship label. Parsed from a
   *  "## Relationships" section if present. */
  relationships: Map<string, string>;
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
    const keys: string[] = [];
    if (handle) keys.push(handle.toLowerCase());
    if (displayName) keys.push(displayName.toLowerCase());
    // Also try the bare phone (strip +, spaces) for phone-handle matches.
    if (handle) keys.push(handle.replace(/[^\d]/g, ""));
    for (const k of keys) {
      const hit = prof.relationships.get(k);
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
export function parseProfile(raw: string): OwnerProfile {
  const relationships = new Map<string, string>();
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
      if (!inRelationships) proseLines.push(line);
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
    if (inRelationships) {
      const trimmed = line.trim();
      // Skip blank lines, the top "# Owner profile" title, and the
      // template's "# ..." comment lines — they're guidance, not data.
      if (!trimmed || trimmed.startsWith("#")) continue;

      // "- Name: relationship" / "* Name: relationship" / "Name: relationship".
      // Split on the FIRST colon so values like "brother-in-law, Raju's
      // spouse" survive intact.
      const m = trimmed.match(/^[-*]?\s*([^:]+?)\s*:\s*(.+?)\s*$/);
      if (!m) continue;
      const rawKey = m[1].trim();
      // Strip template angle brackets the user may have kept ("<friend>"
      // → "friend"). If the value is STILL an empty placeholder after
      // stripping, skip it (the contact isn't really tagged yet).
      const val = m[2].trim().replace(/^<\s*|\s*>$/g, "").trim();
      if (!rawKey || !val) continue;

      const indexKey = (k: string) => {
        const lc = k.trim().toLowerCase();
        if (lc) relationships.set(lc, val);
        const digits = lc.replace(/[^\d]/g, "");
        if (digits.length >= 7) relationships.set(digits, val);
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
      continue;
    }
    proseLines.push(line);
  }

  return {
    prose: proseLines.join("\n").trim(),
    relationships,
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

## Relationships
- Shiva: brother
- <Name or phone or email>: <relationship>
`;
