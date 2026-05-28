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

  const lines = raw.split(/\r?\n/);
  let inRelationships = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inRelationships = /relationship|contacts?|people/i.test(heading[1]);
      // Keep the heading in prose only if it's NOT the relationships
      // section (so the prose reads cleanly).
      if (!inRelationships) proseLines.push(line);
      continue;
    }
    if (inRelationships) {
      // "- Name: relationship" or "Name: relationship"
      const m = line.match(/^\s*[-*]?\s*(.+?)\s*:\s*(.+?)\s*$/);
      if (m) {
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (key && val) {
          relationships.set(key, val);
          // Also index the digit-only form of phone keys.
          const digits = key.replace(/[^\d]/g, "");
          if (digits.length >= 7) relationships.set(digits, val);
        }
      }
      continue;
    }
    proseLines.push(line);
  }

  return {
    prose: proseLines.join("\n").trim(),
    relationships,
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
