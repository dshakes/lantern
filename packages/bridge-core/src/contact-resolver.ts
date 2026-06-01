// Universal contact resolver — turn "Madhu" / "mom" / "yourself" /
// "+15125551234" / "1-512-555-1234" into a canonical E.164 phone
// number with optional display name + relationship.
//
// Resolution order:
//   1. Self-tokens ("me", "myself", "yourself", "I", "owner") →
//      LANTERN_OWNER_PHONE.
//   2. Already a phone number (any common format) → normalized E.164.
//   3. Bridge's in-memory contact-names cache (chat.db / WhatsApp
//      contact-discovery layer).
//   4. Owner profile Relationships map (typed names like "Madhu K
//      Mudarapu") → match if the cache has that handle.
//   5. macOS Contacts.app via AppleScript (catches everyone in
//      iCloud Contacts even if you've never messaged them).
//
// On miss, returns null + emits a helpful "did you mean…" suggestion
// list that the bridge surfaces in the self-chat reply so the owner
// can re-try with the right name.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileP = promisify(execFile);

export interface ResolvedContact {
  phone: string;
  name?: string;
  relationship?: string;
  source: "self-token" | "phone-input" | "bridge-cache" | "profile" | "macos-contacts";
}

export interface ResolveOptions {
  ownerPhone?: string;
  /** Bridge's name→handle cache. Values are handles (phones or jids). */
  bridgeContactCache?: Map<string, string>;
  /** Owner-profile relationships Map (name → relationship string). */
  profileRelationships?: Map<string, string>;
  logger?: Logger;
}

export interface ResolveResult {
  resolved: ResolvedContact | null;
  /** When resolved is null: nearby candidates the user might mean. */
  suggestions: Array<{ name: string; phone?: string; relationship?: string }>;
}

const SELF_TOKENS = new Set([
  "me", "myself", "yourself", "i", "i'?m", "owner", "self", "shekhar",
]);

/**
 * Resolve a free-text contact identifier. Always non-throwing —
 * returns { resolved: null, suggestions: […] } on miss.
 */
export async function resolveContact(
  input: string,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const raw = (input || "").trim();
  if (!raw) return { resolved: null, suggestions: [] };
  const lower = raw.toLowerCase().replace(/[?!.,]+$/, "");

  // 1. Self tokens.
  if (SELF_TOKENS.has(lower) || /^you$/i.test(lower)) {
    if (opts.ownerPhone) {
      return {
        resolved: { phone: opts.ownerPhone, name: "you", source: "self-token" },
        suggestions: [],
      };
    }
    return { resolved: null, suggestions: [] };
  }

  // 2. Phone-shaped input — normalize to E.164.
  const phone = tryParsePhone(raw);
  if (phone) {
    return { resolved: { phone, source: "phone-input" }, suggestions: [] };
  }

  // 3. Bridge cache — exact + substring match.
  const cacheHit = matchFromCache(lower, opts.bridgeContactCache);
  if (cacheHit.exact) {
    return {
      resolved: {
        phone: cacheHit.exact.handle,
        name: cacheHit.exact.name,
        relationship: opts.profileRelationships?.get(cacheHit.exact.name),
        source: "bridge-cache",
      },
      suggestions: [],
    };
  }

  // 4. Profile relationships — match name against profile entries.
  if (opts.profileRelationships) {
    const profMatch = matchFromProfile(lower, opts.profileRelationships, opts.bridgeContactCache);
    if (profMatch) {
      return {
        resolved: profMatch,
        suggestions: [],
      };
    }
  }

  // 5. macOS Contacts.app via AppleScript. Best-effort — fails
  // gracefully if Contacts permission isn't granted to the script
  // process or the user is on a non-Mac platform.
  const macHit = await searchMacosContacts(raw, opts.logger);
  if (macHit) {
    return {
      resolved: {
        phone: macHit.phone,
        name: macHit.name,
        relationship: opts.profileRelationships?.get(macHit.name),
        source: "macos-contacts",
      },
      suggestions: [],
    };
  }

  // Miss — build suggestion list.
  const suggestions = buildSuggestions(lower, opts);
  return { resolved: null, suggestions };
}

// ─────────────────────────────────────────────────────
function tryParsePhone(s: string): string | null {
  const digits = s.replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("+") && digits.length >= 11) return digits;
  if (/^\d{11}$/.test(digits) && digits.startsWith("1")) return "+" + digits;
  if (/^\d{10}$/.test(digits)) return "+1" + digits;
  return null;
}

function matchFromCache(
  lower: string,
  cache: Map<string, string> | undefined,
): { exact?: { handle: string; name: string }; candidates: Array<{ handle: string; name: string }> } {
  if (!cache) return { candidates: [] };
  // cache may be either name→handle OR handle→name depending on
  // bridge — we accept both and figure it out by inspecting values.
  // contactNames in both bridges is `Map<handle, name>` so we iterate
  // and match the NAME (value).
  let exact: { handle: string; name: string } | undefined;
  const candidates: Array<{ handle: string; name: string }> = [];
  for (const [handle, name] of cache) {
    if (!name) continue;
    const nameLower = name.toLowerCase();
    if (nameLower === lower) {
      exact = { handle, name };
      break;
    }
    if (nameLower.includes(lower) || lower.includes(nameLower.split(/\s+/)[0] || "")) {
      candidates.push({ handle, name });
    }
  }
  return { exact, candidates };
}

function matchFromProfile(
  lower: string,
  rels: Map<string, string>,
  cache: Map<string, string> | undefined,
): ResolvedContact | null {
  for (const [name, rel] of rels) {
    if (name.toLowerCase().includes(lower) || lower.includes(name.toLowerCase().split(/\s+/)[0])) {
      // Try to find a phone for this name via the cache.
      if (cache) {
        for (const [handle, cacheName] of cache) {
          if (!cacheName) continue;
          if (cacheName.toLowerCase().includes(name.toLowerCase().split(/\s+/)[0])) {
            const phone = handleToPhone(handle);
            if (phone) return { phone, name: cacheName, relationship: rel, source: "profile" };
          }
        }
      }
    }
  }
  return null;
}

function handleToPhone(handle: string): string | null {
  // iMessage handles can be email (skip) or phone.
  if (handle.includes("@")) {
    // WhatsApp jid: digits@s.whatsapp.net → digits.
    const m = handle.match(/^(\d+)@/);
    if (m) return "+" + m[1];
    return null;
  }
  if (handle.startsWith("+")) return handle;
  if (/^\d{10}$/.test(handle)) return "+1" + handle;
  if (/^\d{11}$/.test(handle)) return "+" + handle;
  return null;
}

async function searchMacosContacts(
  query: string,
  logger?: Logger,
): Promise<{ name: string; phone: string } | null> {
  if (process.platform !== "darwin") return null;
  // Escape the query for AppleScript embedding (single quotes
  // wrapping the script literal; query may contain none).
  const safeQuery = query.replace(/"/g, '\\"').slice(0, 60);
  const script = `
    on run
      tell application "Contacts"
        set hits to (every person whose name contains "${safeQuery}")
        if (count of hits) is 0 then return ""
        set thePerson to item 1 of hits
        set phoneList to (value of phones of thePerson)
        if (count of phoneList) is 0 then return ""
        return (name of thePerson) & "|" & (item 1 of phoneList)
      end tell
    end run
  `;
  try {
    const { stdout } = await execFileP("osascript", ["-e", script], { timeout: 3000 });
    const line = stdout.trim();
    if (!line || !line.includes("|")) return null;
    const [name, rawPhone] = line.split("|").map((s) => s.trim());
    const phone = tryParsePhone(rawPhone);
    if (!phone || !name) return null;
    return { name, phone };
  } catch (err) {
    logger?.debug({ err }, "macOS Contacts.app probe failed (permission may not be granted)");
    return null;
  }
}

function buildSuggestions(
  lower: string,
  opts: ResolveOptions,
): Array<{ name: string; phone?: string; relationship?: string }> {
  const out: Array<{ name: string; phone?: string; relationship?: string }> = [];
  const seen = new Set<string>();

  // From cache.
  if (opts.bridgeContactCache) {
    for (const [handle, name] of opts.bridgeContactCache) {
      if (!name || seen.has(name)) continue;
      const nameLower = name.toLowerCase();
      // Loose substring match — first 3 letters or shared token.
      if (
        nameLower.includes(lower) ||
        (lower.length >= 3 && nameLower.startsWith(lower.slice(0, 3))) ||
        lower.split(/\s+/).some((tok) => tok.length >= 3 && nameLower.includes(tok))
      ) {
        const phone = handleToPhone(handle) ?? undefined;
        out.push({ name, phone, relationship: opts.profileRelationships?.get(name) });
        seen.add(name);
        if (out.length >= 5) break;
      }
    }
  }

  // From profile if cache didn't yield enough.
  if (opts.profileRelationships && out.length < 3) {
    for (const [name, rel] of opts.profileRelationships) {
      if (seen.has(name)) continue;
      const nameLower = name.toLowerCase();
      if (nameLower.startsWith(lower.slice(0, 3)) || nameLower.includes(lower)) {
        out.push({ name, relationship: rel });
        seen.add(name);
        if (out.length >= 5) break;
      }
    }
  }

  return out;
}

/** Render suggestions for inclusion in a self-chat error reply. */
export function formatSuggestions(s: Array<{ name: string; phone?: string; relationship?: string }>): string {
  if (s.length === 0) return "";
  const lines = s.map((c) => {
    const rel = c.relationship ? ` (${c.relationship})` : "";
    return `  • ${c.name}${rel}`;
  });
  return `did you mean:\n${lines.join("\n")}`;
}
