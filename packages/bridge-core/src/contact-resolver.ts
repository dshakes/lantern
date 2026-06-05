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
//      Sharma") → match if the cache has that handle.
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

  // 3. Bridge cache — exact + substring match. Only short-circuit if the
  // cached handle is a DIALABLE number; a name match whose handle is a
  // WhatsApp @lid / email must fall through to macOS Contacts (which has
  // the real phone), not return a bogus "phone".
  const cacheHit = matchFromCache(lower, opts.bridgeContactCache);
  if (cacheHit.exact) {
    const cachePhone = handleToPhone(cacheHit.exact.handle);
    if (cachePhone) {
      return {
        resolved: {
          phone: cachePhone,
          name: cacheHit.exact.name,
          relationship: opts.profileRelationships?.get(cacheHit.exact.name),
          source: "bridge-cache",
        },
        suggestions: [],
      };
    }
    // exact name, un-dialable handle → fall through to profile + Contacts.
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

  // 5. macOS Contacts. PRIMARY: read the AddressBook SQLite directly
  // in-process — the bridge already has Full Disk Access (for chat.db),
  // which covers the TCC-protected AddressBook DB. This works even when
  // AppleScript *Automation* permission for Contacts.app is NOT granted to
  // the bridge's node binary (a separate TCC grant it usually lacks under
  // launchd) — the exact reason name→phone resolution failed in prod.
  // FALLBACK: AppleScript, for environments where Automation IS granted
  // but Full Disk Access isn't.
  const dbHit = await searchAddressBookDb(raw, opts.logger);
  const macHit = dbHit || (await searchMacosContacts(raw, opts.logger));
  opts.logger?.info(
    { query: raw, dbHit: dbHit ? dbHit.phone : null, viaAppleScript: !dbHit && !!macHit },
    "contact resolve: macOS lookup result",
  );
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
  // Already E.164.
  if (digits.startsWith("+") && digits.length >= 11 && digits.length <= 16) return digits;
  // US 11-digit (1NXXNXXXXXX) / 10-digit.
  if (/^\d{11}$/.test(digits) && digits.startsWith("1")) return "+" + digits;
  if (/^\d{10}$/.test(digits)) return "+1" + digits;
  // International number stored WITHOUT a leading '+' (e.g. AddressBook
  // entries like "91 94936 78486" → "919493678486"). 11-15 digits that
  // don't fit the US shapes above are almost certainly already
  // country-coded — prefix '+' so Twilio can dial them.
  if (/^\d{11,15}$/.test(digits)) return "+" + digits;
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
    // WhatsApp @lid is a PRIVACY identifier (random long digit string),
    // NOT a phone — never dialable. @g.us is a group. Only real-number
    // jids (<phone>@s.whatsapp.net / @c.us) carry a dialable number.
    if (handle.endsWith("@lid") || handle.endsWith("@g.us")) return null;
    const m = handle.match(/^(\d+)@/);
    // Plausible E.164 length only (country + subscriber = 8..15 digits);
    // rejects lid-shaped garbage that slips past the suffix check.
    if (m && m[1].length >= 8 && m[1].length <= 15) return "+" + m[1];
    return null;
  }
  if (handle.startsWith("+")) return handle;
  if (/^\d{10}$/.test(handle)) return "+1" + handle;
  if (/^\d{11}$/.test(handle)) return "+" + handle;
  return null;
}

export interface ContactSearchHit {
  name: string;
  phones: string[];
  emails: string[];
}

// Search the macOS AddressBook for contacts matching a name/nickname/org,
// returning each match's full set of phones + emails. Reads the SQLite store
// in-process (FDA, launchd-safe — same path as searchAddressBookDb). Backs the
// `search_contacts` agentic tool. Best-effort: returns [] if unavailable.
export async function searchAddressBookContacts(
  query: string,
  opts: { limit?: number; logger?: Logger } = {},
): Promise<ContactSearchHit[]> {
  if (process.platform !== "darwin") return [];
  const q = (query || "").toLowerCase().trim();
  if (!q) return [];
  try {
    const sqliteSpecifier = "better-sqlite3";
    const [sqliteMod, os, fs, path] = await Promise.all([
      import(sqliteSpecifier) as Promise<any>,
      import("node:os"),
      import("node:fs"),
      import("node:path"),
    ]);
    const Database = sqliteMod.default as any;
    const base = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
    if (!fs.existsSync(base)) return [];
    const like = `%${q}%`;
    const limit = Math.max(1, Math.min(opts.limit ?? 8, 25));
    const byRecord = new Map<string, { name: string; phones: Set<string>; emails: Set<string> }>();
    for (const src of fs.readdirSync(base)) {
      const dbPath = path.join(base, src, "AddressBook-v22.abcddb");
      if (!fs.existsSync(dbPath)) continue;
      let conn: any;
      try {
        conn = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = conn
          .prepare(
            `SELECT r.Z_PK AS pk, r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o,
                    p.ZFULLNUMBER AS phone, e.ZADDRESS AS email
             FROM ZABCDRECORD r
             LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
             LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
             WHERE lower(coalesce(r.ZFIRSTNAME,'')||' '||coalesce(r.ZLASTNAME,'')) LIKE @q
                OR lower(coalesce(r.ZNICKNAME,'')) LIKE @q
                OR lower(coalesce(r.ZORGANIZATION,'')) LIKE @q`,
          )
          .all({ q: like }) as Array<{ pk: number; f?: string; l?: string; o?: string; phone?: string; email?: string }>;
        for (const r of rows) {
          const name = [r.f, r.l].filter(Boolean).join(" ").trim() || r.o || "(no name)";
          const key = `${src}:${r.pk}`;
          let entry = byRecord.get(key);
          if (!entry) { entry = { name, phones: new Set(), emails: new Set() }; byRecord.set(key, entry); }
          if (r.phone) entry.phones.add(String(r.phone).trim());
          if (r.email) entry.emails.add(String(r.email).trim());
        }
      } catch (err) {
        opts.logger?.debug({ err: (err as Error)?.message, dbPath }, "contacts search: db read failed");
      } finally {
        try { conn?.close(); } catch { /* ignore */ }
      }
    }
    return [...byRecord.values()]
      .slice(0, limit)
      .map((e) => ({ name: e.name, phones: [...e.phones], emails: [...e.emails] }));
  } catch (err) {
    opts.logger?.debug({ err: (err as Error)?.message || String(err) }, "contacts search unavailable");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reverse lookup: handle (phone / email) -> contact display name.
//
// THE fix for "the bot doesn't know who it's talking to": the bridges keep a
// `contactNames` cache that was never populated, so every reply had no name and
// the model hallucinated one. This builds a process-cached index of the whole
// AddressBook (phone-digits -> name, email -> name) via better-sqlite3 (works
// under launchd via Full Disk Access; AppleScript Contacts is TCC-blocked), so
// the bridges can resolve an inbound handle to the real saved name.
// ---------------------------------------------------------------------------

interface AddressBookIndex {
  byPhone: Map<string, string>; // last-10 digits -> name
  byPhoneFull: Map<string, string>; // full digits -> name
  byEmail: Map<string, string>; // lowercased email -> name
  builtAt: number;
}

let _abIndex: AddressBookIndex | null = null;
const AB_INDEX_TTL_MS = 60 * 60_000; // refresh hourly so new contacts appear

function phoneDigits(s: string): string {
  return (s || "").replace(/[^\d]/g, "");
}

/** Build (and cache) a reverse index of the macOS AddressBook. Best-effort. */
export async function loadAddressBookIndex(
  opts: { logger?: Logger; force?: boolean } = {},
): Promise<AddressBookIndex | null> {
  if (process.platform !== "darwin") return null;
  const now = Date.now();
  if (!opts.force && _abIndex && now - _abIndex.builtAt < AB_INDEX_TTL_MS) {
    return _abIndex;
  }
  try {
    const sqliteSpecifier = "better-sqlite3";
    const [sqliteMod, os, fs, path] = await Promise.all([
      import(sqliteSpecifier) as Promise<any>,
      import("node:os"),
      import("node:fs"),
      import("node:path"),
    ]);
    const Database = sqliteMod.default as any;
    const base = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
    if (!fs.existsSync(base)) return null;
    const byPhone = new Map<string, string>();
    const byPhoneFull = new Map<string, string>();
    const byEmail = new Map<string, string>();
    for (const src of fs.readdirSync(base)) {
      const dbPath = path.join(base, src, "AddressBook-v22.abcddb");
      if (!fs.existsSync(dbPath)) continue;
      let conn: any;
      try {
        conn = new Database(dbPath, { readonly: true, fileMustExist: true });
        const rows = conn
          .prepare(
            `SELECT r.ZFIRSTNAME AS f, r.ZLASTNAME AS l, r.ZORGANIZATION AS o, r.ZNICKNAME AS n,
                    p.ZFULLNUMBER AS phone, e.ZADDRESS AS email
             FROM ZABCDRECORD r
             LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
             LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK`,
          )
          .all() as Array<{ f?: string; l?: string; o?: string; n?: string; phone?: string; email?: string }>;
        for (const r of rows) {
          // Prefer the first name (how people are addressed); fall back to
          // full name, nickname, then org.
          const name =
            (r.f && r.f.trim()) ||
            [r.f, r.l].filter(Boolean).join(" ").trim() ||
            (r.n && r.n.trim()) ||
            (r.o && r.o.trim()) ||
            "";
          if (!name) continue;
          if (r.phone) {
            const digits = phoneDigits(r.phone);
            if (digits.length >= 7) {
              const last10 = digits.slice(-10);
              if (!byPhone.has(last10)) byPhone.set(last10, name);
              if (!byPhoneFull.has(digits)) byPhoneFull.set(digits, name);
            }
          }
          if (r.email) {
            const em = String(r.email).toLowerCase().trim();
            if (em && !byEmail.has(em)) byEmail.set(em, name);
          }
        }
      } catch (err) {
        opts.logger?.debug({ err: (err as Error)?.message, dbPath }, "AddressBook index: db read failed");
      } finally {
        try { conn?.close(); } catch { /* ignore */ }
      }
    }
    _abIndex = { byPhone, byPhoneFull, byEmail, builtAt: now };
    opts.logger?.info({ phones: byPhone.size, emails: byEmail.size }, "AddressBook index built");
    return _abIndex;
  } catch (err) {
    opts.logger?.debug({ err: (err as Error)?.message || String(err) }, "AddressBook index unavailable");
    return null;
  }
}

/**
 * Resolve a single inbound handle (phone like "+16148051205" or
 * "15125551234@s.whatsapp.net", or an email) to the saved contact name.
 * Returns null when not found / unavailable. `@lid` / group ids return null
 * (no phone to match). Best-effort, never throws.
 */
export async function nameForHandle(
  handle: string,
  opts: { logger?: Logger } = {},
): Promise<string | null> {
  if (!handle) return null;
  const h = handle.trim();
  // Group / privacy ids carry no resolvable phone.
  if (h.endsWith("@g.us") || h.endsWith("@lid") || h.endsWith("@broadcast")) return null;
  const idx = await loadAddressBookIndex(opts);
  if (!idx) return null;
  // Email handle (incl. iMessage email; exclude phone jids which contain '@' too).
  const local = h.split("@")[0];
  if (h.includes("@") && !h.includes("whatsapp") && !h.includes("c.us") && !/^\+?\d[\d\s().-]*$/.test(local)) {
    return idx.byEmail.get(h.toLowerCase()) ?? null;
  }
  const digits = phoneDigits(h);
  if (digits.length >= 7) {
    return idx.byPhoneFull.get(digits) ?? idx.byPhone.get(digits.slice(-10)) ?? null;
  }
  return null;
}

// Read the macOS AddressBook SQLite directly (in-process via better-sqlite3).
// Covered by Full Disk Access — the grant the bridge already holds for
// chat.db — so it works under launchd where AppleScript Automation for
// Contacts.app is blocked. Dynamic import + best-effort: returns null
// (degrading to the AppleScript path) if the driver or DBs are unavailable.
async function searchAddressBookDb(
  query: string,
  logger?: Logger,
): Promise<{ name: string; phone: string } | null> {
  if (process.platform !== "darwin") return null;
  try {
    // Indirection defeats TS literal module resolution — better-sqlite3 is
    // an optional native dep resolved at RUNTIME from the consuming bridge's
    // node_modules (both bridges have it), not from bridge-core's.
    const sqliteSpecifier = "better-sqlite3";
    const [sqliteMod, os, fs, path] = await Promise.all([
      import(sqliteSpecifier) as Promise<any>,
      import("node:os"),
      import("node:fs"),
      import("node:path"),
    ]);
    const Database = sqliteMod.default as any;
    const base = path.join(os.homedir(), "Library/Application Support/AddressBook/Sources");
    if (!fs.existsSync(base)) return null;
    const like = `%${query.toLowerCase().trim()}%`;
    for (const src of fs.readdirSync(base)) {
      const dbPath = path.join(base, src, "AddressBook-v22.abcddb");
      if (!fs.existsSync(dbPath)) continue;
      let conn: any;
      try {
        conn = new Database(dbPath, { readonly: true, fileMustExist: true });
        // Exact-ish first (first name or full name equals the query), then
        // substring — so "mae" prefers the contact named "Mae" over
        // "Anil Kakumanu". A contact can have multiple phones; take the first.
        const row = conn
          .prepare(
            `SELECT r.ZFIRSTNAME AS first, r.ZLASTNAME AS last, p.ZFULLNUMBER AS phone,
                    CASE
                      WHEN lower(coalesce(r.ZFIRSTNAME,'')) = ?1 THEN 0
                      WHEN lower(trim(coalesce(r.ZFIRSTNAME,'')||' '||coalesce(r.ZLASTNAME,''))) = ?1 THEN 1
                      WHEN lower(coalesce(r.ZNICKNAME,'')) = ?1 THEN 2
                      ELSE 3
                    END AS rank
             FROM ZABCDRECORD r
             JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
             WHERE p.ZFULLNUMBER IS NOT NULL AND (
                   lower(coalesce(r.ZFIRSTNAME,'')||' '||coalesce(r.ZLASTNAME,'')) LIKE ?2
                   OR lower(coalesce(r.ZNICKNAME,'')) LIKE ?2
                   OR lower(coalesce(r.ZORGANIZATION,'')) LIKE ?2)
             ORDER BY rank ASC, r.Z_PK ASC
             LIMIT 1`,
          )
          .get(query.toLowerCase().trim(), like) as
          | { first?: string; last?: string; phone?: string }
          | undefined;
        if (row?.phone) {
          const phone = tryParsePhone(row.phone);
          const name = [row.first, row.last].filter(Boolean).join(" ").trim() || query;
          if (phone) return { name, phone };
        }
      } catch (err) {
        logger?.debug({ err, dbPath }, "AddressBook DB read failed for source");
      } finally {
        try { conn?.close(); } catch { /* ignore */ }
      }
    }
    return null;
  } catch (err) {
    logger?.warn({ err: (err as Error)?.message || String(err) }, "AddressBook DB lookup unavailable — falling back to AppleScript");
    return null;
  }
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
