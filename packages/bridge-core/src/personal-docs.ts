// Personal-docs agent — secure, owner-only Q&A over the user's local
// files. Runs entirely on the user's Mac (file content never leaves
// the bridge except as relevant snippets in the LLM prompt).
//
// Security model:
//   1. ONLY fires for owner-sent messages (bridges gate on isFromMe).
//   2. Paths restricted to LANTERN_PERSONAL_DOCS_ROOTS (default:
//      ~/Documents, ~/Desktop, ~/Library/Mobile Documents/com~apple~CloudDocs).
//   3. Path-traversal blocked — every read normalizes + checks the
//      resolved path is within an allowed root.
//   4. Audit log: every search + read + send appended to
//      bridge_state/<tenant>/personal-docs.log with timestamp + query.
//   5. Owner-only attachment delivery: send_my_file ALWAYS targets the
//      owner's own self-chat, never accepts a contact JID.
//
// Search uses macOS Spotlight (`mdfind`) — instant, no indexing
// overhead, respects the user's existing Spotlight privacy settings.
// Reading supports PDF / DOCX / TXT / MD / JSON / HTML out of the
// box; other types return a "binary — won't preview" placeholder.

import { spawn } from "child_process";
import { existsSync, readFileSync, statSync, appendFileSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { resolve, dirname, basename, extname, join, sep } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import type { Logger } from "pino";

// ---- types ----------------------------------------------------------------

export interface DocSearchResult {
  path: string;          // absolute, normalized
  displayPath: string;   // user-friendly (~/Documents/...)
  name: string;          // basename
  ext: string;           // .pdf / .docx etc.
  modifiedAt: number;    // epoch ms
  bytes: number;
  // First ~300 chars from the file (when readable), used by the LLM
  // to decide which file is the right one without doing a full read.
  snippet?: string;
}

export interface DocReadResult {
  ok: boolean;
  path: string;
  displayPath: string;
  content: string;       // first N chars; large files truncated
  truncated: boolean;
  bytes: number;
  ext: string;
  reason?: string;       // populated when ok=false (binary, too large, denied)
}

export interface PersonalDocsConfig {
  // Absolute paths the agent is allowed to search/read in.
  // Defaults to ~/Documents, ~/Desktop, and iCloud Drive root.
  // Override via LANTERN_PERSONAL_DOCS_ROOTS=path1:path2:path3
  roots: string[];
  // Per-search cap (we cap aggressively; LLM context is precious).
  maxResults: number;
  // Per-read cap in characters (truncate huge PDFs).
  maxReadChars: number;
  // Path to audit log file.
  auditLogPath: string;
}

// ---- defaults / config helpers ------------------------------------------

export function defaultPersonalDocsConfig(stateDir: string): PersonalDocsConfig {
  const home = homedir();
  const envRoots = (process.env.LANTERN_PERSONAL_DOCS_ROOTS || "")
    .split(":")
    .map((r) => r.trim().replace(/^~/, home))
    .filter(Boolean);
  const roots = envRoots.length > 0
    ? envRoots
    : [
        join(home, "Documents"),
        join(home, "Desktop"),
        join(home, "Library/Mobile Documents/com~apple~CloudDocs"),
      ];
  mkdirSync(stateDir, { recursive: true });
  return {
    roots,
    maxResults: parseInt(process.env.LANTERN_PERSONAL_DOCS_MAX_RESULTS || "8", 10),
    maxReadChars: parseInt(process.env.LANTERN_PERSONAL_DOCS_MAX_CHARS || "12000", 10),
    auditLogPath: join(stateDir, "personal-docs.log"),
  };
}

// Trivial-chatter detector — the ONE pre-decider we keep. Used by the
// bridges' owner-self-chat router to skip the heavy agentic pipeline on
// acks/greetings/rejections/confirmations ("ok", "thanks", "no thanks",
// "sounds good", "👍"). Every other substantive owner message goes
// straight to the LLM with tools (search_personal_files /
// read_personal_file / Gmail / Calendar) and the model decides what to
// do.
//
// We deliberately do NOT try to classify "is this a doc query?" anymore.
// That was the broken design — false-negatives produced "I can't access
// your files" replies and false-positives wasted Spotlight calls. The
// LLM is now responsible for picking the right tool.
//
// Conservative: catches single-clause acknowledgments/rejections up to
// 30 chars. Anything substantive (a question, multi-sentence, contains
// proper nouns/verbs beyond ack vocabulary) falls through to the
// pipeline.
const CHATTER_WORD =
  "(?:k|kk|ok(?:ay)?|cool|nice|great|perfect|awesome|fine|lol|lmao|(?:ha){2,}|" +
  "thx|thanks|thank\\s+you|thank\\s+u|ty|tysm|much\\s+appreciated|appreciated|appreciate\\s+it|" +
  "yes|yep|yeah|yup|sure|sure\\s+thing|will\\s+do|got\\s+it|gotcha|sounds\\s+good|please|" +
  "no|nope|nah|no\\s+thanks|no\\s+thx|no\\s+thank\\s+you|not\\s+now|not\\s+really|" +
  "maybe\\s+later|later|skip|cancel|never\\s+mind|nvm|np|" +
  "all\\s+good|all\\s+set|good\\s+to\\s+know|roger|roger\\s+that|" +
  "hi|hey|hello|yo|sup|gm|gn|good\\s*(?:morning|night|evening|afternoon))";
const TRIVIAL_CHATTER_RE = new RegExp(
  `^(?:${CHATTER_WORD})(?:[,\\s]+(?:${CHATTER_WORD}))?[\\s!.?]*$`,
  "i",
);

export function isTrivialChatter(text: string): boolean {
  const t = (text || "").trim();
  if (t.length === 0) return true;
  // Pure emoji / very-short utterances.
  if (t.length <= 3 && !/[a-z0-9]/i.test(t)) return true;
  // Cap on length — anything longer than 30 chars is unlikely to be
  // a pure ack/rejection.
  if (t.length > 30) return false;
  return TRIVIAL_CHATTER_RE.test(t);
}

// Greetings + pure small-talk ("hi", "hi how are you", "good morning",
// "what's up"). Distinct from isTrivialChatter (which is acks/rejections):
// these are openers that warrant a warm reply but NEVER need the agentic
// tool pipeline. Routing them to natural chat saves the ~1.2s tool spin-up.
// Deliberately tight — any actionable tail ("hi, when does my passport
// expire") fails to match and falls through to the pipeline.
const GREETING_WORD =
  "(?:hi+|hey+|hello+|heya|hiya|yo+|sup|wassup|wazzup|gm|gn|" +
  "good\\s*(?:morning|night|evening|afternoon)|namaste|hola)";
const SMALLTALK_PHRASE =
  "(?:how\\s*(?:are|r)\\s*(?:you|u|ya)(?:\\s*doing)?|how\\s*(?:are|r)\\s*(?:you|u)\\s*doing|" +
  "how(?:'s|\\s+is)\\s+it\\s+going|how(?:'s|\\s+are)\\s+things|how\\s+have\\s+you\\s+been|" +
  "what(?:'s|s)?\\s*up|whats\\s+up|" +
  "hope\\s+(?:you(?:'re|\\s+are)?|u\\s+are)\\s+(?:well|good|doing\\s+well|great))";
const GREETING_SMALLTALK_RE = new RegExp(
  `^(?:${GREETING_WORD}|${SMALLTALK_PHRASE})(?:[\\s,.!?]+(?:${GREETING_WORD}|${SMALLTALK_PHRASE}))*[\\s!.?]*$`,
  "i",
);

export function isGreetingSmallTalk(text: string): boolean {
  const t = (text || "").trim();
  if (!t || t.length > 40) return false;
  return GREETING_SMALLTALK_RE.test(t);
}

// Celebratory-wish detector — birthdays, anniversaries, congrats, festival
// greetings, in English + Telugu (native + Romanized) + the common wish
// emoji. Used by the group gate: a wish that NAMES the owner gets one casual
// thanks IN the group even when the chat isn't on the monitor list — silence
// on a wedding-anniversary wish addressed to the owner reads as rude. General
// group chatter still requires an explicitly-monitored chat (this predicate
// is intentionally narrow so it doesn't widen the group-reply surface).
//
// Matches on substring (a wish often rides along with a name + extra words:
// "Happy Wedding Anniversary Shekhar & Maya 🎉"), unlike isGreetingSmallTalk
// which anchors the whole utterance.
const CELEBRATORY_RE =
  /\b(?:(?:belated\s+|happy\s+|wedding\s+)*(?:anniversary|annivarsary|anniv|birthday|bday|b'day))\b|\b(?:many\s+(?:more\s+)?happy\s+returns|happy\s+returns\s+of\s+the\s+day)\b/i;
const CONGRATS_RE = /\b(?:congrat(?:s|ulations)?|congra+ts|kudos|well\s+done|best\s+wishes|all\s+the\s+best)\b/i;
// Festival / occasion wishes (English).
const FESTIVAL_RE =
  /\bhappy\s+(?:new\s+year|diwali|deepavali|sankranti|pongal|ugadi|holi|dussehra|dasara|christmas|easter|eid|onam|rakhi|raksha\s+bandhan|valentine'?s?)\b/i;
// Telugu Romanized wish vocabulary — "subhakankshalu" (best wishes/congrats),
// "puttinaroju" (birthday), "pelliroju" (wedding anniversary), "shubhodayam",
// plus common spelling variants.
const TELUGU_ROMANIZED_WISH_RE =
  /\b(?:subha?kanksha?lu?|shubha?kanksha?lu?|subha?kankshalu|puttina\s*roju|puttinaroju|puttinarోju|pelli\s*roju|pelliroju|janmadina\s*subha?kanksha?lu?|sankranti\s*subha?kanksha?lu?)\b/i;
// Telugu native-script wish vocabulary: శుభాకాంక్షలు (best wishes / congrats),
// పుట్టినరోజు (birthday), పెళ్లిరోజు (wedding day).
const TELUGU_NATIVE_WISH_RE = /శుభాకాంక్షలు|పుట్టినరోజు|పెళ్లిరోజు|పెళ్ళిరోజు|జన్మదిన/;
// Wish emoji — party, cake, bouquet, balloon, confetti, sparkles+gift combos.
const WISH_EMOJI_RE = /[🎉🎂🎈💐🥳🎊🎁]/u;

export function isCelebratoryWish(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return false;
  return (
    CELEBRATORY_RE.test(t) ||
    CONGRATS_RE.test(t) ||
    FESTIVAL_RE.test(t) ||
    TELUGU_ROMANIZED_WISH_RE.test(t) ||
    TELUGU_NATIVE_WISH_RE.test(t) ||
    WISH_EMOJI_RE.test(t)
  );
}

// ---- the class ------------------------------------------------------------

export class PersonalDocs {
  private cfg: PersonalDocsConfig;
  private logger: Logger;

  constructor(cfg: PersonalDocsConfig, logger: Logger) {
    this.cfg = cfg;
    this.logger = logger.child({ component: "personal-docs" });
  }

  // Returns true if `path` resolves inside one of the configured roots.
  // Blocks path traversal (../, symlinks pointing outside, etc.).
  isAllowedPath(path: string): boolean {
    try {
      const resolved = resolve(path.replace(/^~/, homedir()));
      for (const root of this.cfg.roots) {
        const rootResolved = resolve(root);
        // Append separator so /tmp/foo doesn't match /tmp/foobar.
        if (resolved === rootResolved || resolved.startsWith(rootResolved + sep)) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  // Resolve a path the LLM put in an [ATTACH:...] marker to a real
  // file on disk. The LLM sometimes hallucinates parent directories
  // — it sees "Shekhar-current-passport-full.pdf" in the context
  // block and emits "/Users/shakes/Documents/Passport/..." instead
  // of the real iCloud path. We rescue these cases:
  //   1. If the literal path exists + is allowed → return it.
  //   2. Otherwise, search by basename inside the allowed roots and
  //      return the first match that's also allowed.
  //   3. Failing that, return null and let the caller report the
  //      attach error.
  // This is purely a usability rescue — the security gate
  // (isAllowedPath) still has the final say on what we attach.
  async resolveAttachPath(claimedPath: string): Promise<{ ok: true; path: string; rescued?: boolean } | { ok: false; reason: string }> {
    const expanded = resolve(claimedPath.replace(/^~/, homedir()));
    if (existsSync(expanded) && this.isAllowedPath(expanded)) {
      return { ok: true, path: expanded };
    }
    // Try basename search via the existing search() pipeline (mdfind
    // + find fallback). This will scope to the allowed roots.
    const base = basename(expanded);
    if (!base) return { ok: false, reason: `path "${claimedPath}" not found and no basename to rescue` };
    try {
      const hits = await this.search(base);
      for (const h of hits) {
        if (basename(h.path) === base && this.isAllowedPath(h.path) && existsSync(h.path)) {
          this.logger.info({ claimed: claimedPath, rescued: h.path }, "ATTACH path rescued by basename search");
          return { ok: true, path: h.path, rescued: true };
        }
      }
    } catch (err) {
      this.logger.debug({ err }, "resolveAttachPath: basename search errored");
    }
    return { ok: false, reason: `file "${base}" not found in any allowed root` };
  }

  // Spotlight-backed search. Returns the top N most relevant files
  // across the configured roots. Falls back to plain `find` when
  // mdfind is unavailable (rare on macOS).
  async search(query: string): Promise<DocSearchResult[]> {
    // Query comes from an LLM tool call (search_personal_files) — the
    // model has already picked good keywords ("I-485 approval", not
    // "find my green card stuff"). We pass them through directly and
    // also try each individual token as a fallback for narrow phrases
    // like "license number" where the noun matters more than the
    // modifier.
    const trimmed = query.trim().replace(/[?.!,;:]+$/g, "");
    if (!trimmed) return [];
    this.audit("search", { rawQuery: query, terms: trimmed });

    const phrases = [trimmed];
    const tokens = trimmed.split(/\s+/).filter((t) => t.length >= 3);
    if (tokens.length > 1) {
      // Prefer tokens with digits/dashes (I-485, W-2) — they uniquely
      // identify documents.
      const ranked = [...tokens].sort((a, b) => {
        const aHas = /\d|-/.test(a) ? 1 : 0;
        const bHas = /\d|-/.test(b) ? 1 : 0;
        return bHas - aHas;
      });
      for (const t of ranked) {
        if (!phrases.includes(t)) phrases.push(t);
      }
    }
    this.logger.debug({ phrases }, "doc search phrases");

    const results: DocSearchResult[] = [];
    // Pool cap is large — ranker takes over below. The previous
    // tight cap (maxResults) caused find's length-sorted output to
    // be truncated to folders + short filenames, hiding the actual
    // owner's passport (which has a long filename).
    const POOL_CAP = Math.max(60, this.cfg.maxResults * 6);
    // Per-phrase per-root: pull a lot so the ranker has a fair pool.
    const perPhrasePerRoot = 80;

    const seenPaths = new Set<string>();
    const ingest = (paths: string[], includeFolders: boolean) => {
      for (const p of paths) {
        if (seenPaths.has(p)) continue;
        if (!this.isAllowedPath(p)) continue;
        if (!existsSync(p)) continue;
        try {
          const st = statSync(p);
          if (st.isDirectory() && !includeFolders) continue;
          seenPaths.add(p);
          const ext = st.isDirectory() ? "" : extname(p).toLowerCase();
          results.push({
            path: p,
            displayPath: this.prettyPath(p) + (st.isDirectory() ? "/" : ""),
            name: basename(p) + (st.isDirectory() ? " (folder)" : ""),
            ext,
            modifiedAt: st.mtimeMs,
            bytes: st.isDirectory() ? 0 : st.size,
          });
          if (results.length >= POOL_CAP) return true;
        } catch {}
      }
      return false;
    };

    // Run BOTH mdfind and find on every root for every phrase, then
    // dedupe + rank. Why both? Spotlight on iCloud Drive is often
    // broken ("unknown indexing state") so mdfind silently misses
    // files. find catches those by walking the tree directly. The
    // extra cost is a sub-second wait per root (find is fast on
    // typical doc trees).
    for (const root of this.cfg.roots) {
      if (!existsSync(root)) continue;
      for (const phrase of phrases) {
        // We deliberately overshoot here — ingest dedupes by path —
        // because the final ranker re-sorts the union by relevance
        // score, not by per-source order.
        try {
          const paths = await this.mdfind(phrase, root, perPhrasePerRoot);
          ingest(paths, true);
        } catch (err) {
          this.logger.warn({ err, root, phrase }, "mdfind failed");
        }
        try {
          const paths = await this.findByName(phrase, root, perPhrasePerRoot);
          ingest(paths, true);
        } catch (err) {
          this.logger.warn({ err, root, phrase }, "find failed");
        }
        if (results.length >= POOL_CAP) break;
      }
    }

    // Rank by relevance. The mtime-only sort produced wrong results
    // (newest family-member passport ranked above the owner's older
    // current passport). Score components:
    //   - basename matches phrase (any): +30
    //   - path includes owner's first name when query had "my": +20
    //   - is file (not folder): +10
    //   - extension is doc-like: +5
    //   - recency: ((mtime - oldest) / span) * 5  — gentle tie-break
    // Folder hits stay in the pool (they're useful as breadcrumbs)
    // but don't beat real files.
    const ownerFirst = (process.env.LANTERN_OWNER_NAME || "").trim().split(/\s+/)[0]?.toLowerCase() || "";
    const wantsMine = /\bmy\b|\bmine\b|\bi\b/i.test(query);
    // Detect a third-party possessive ("Maya's drivers license",
    // "Arin's passport") and rank files containing that name higher
    // than the owner's. The first capture group is the bare name.
    const possessiveMatch = query.match(/\b([A-Za-z]{3,})['’]s\b/);
    const targetName = possessiveMatch ? possessiveMatch[1].toLowerCase() : (wantsMine ? ownerFirst : "");
    const docExts = new Set([".pdf", ".docx", ".doc", ".txt", ".md", ".rtf", ".html", ".csv", ".png", ".jpg", ".jpeg", ".heic"]);
    const oldest = Math.min(...results.map((r) => r.modifiedAt), Date.now());
    const newest = Math.max(...results.map((r) => r.modifiedAt), oldest + 1);
    const span = Math.max(1, newest - oldest);
    const scoreFor = (r: DocSearchResult): number => {
      let s = 0;
      const baseLower = r.name.toLowerCase();
      const pathLower = r.path.toLowerCase();
      for (const phrase of phrases) {
        if (baseLower.includes(phrase.toLowerCase())) { s += 30; break; }
      }
      // Person-targeting boost. If the query said "Maya's …" we
      // want Maya's files even though the user (Shekhar) typed.
      // Penalize the OTHER name to keep cross-talk down (Shekhar's
      // license file shouldn't beat Maya's when asked about
      // Maya's).
      if (targetName && pathLower.includes(targetName)) s += 25;
      if (possessiveMatch && ownerFirst && targetName !== ownerFirst && pathLower.includes(ownerFirst)) s -= 15;
      if (r.ext && r.ext !== "") s += 10;          // not a folder
      if (r.ext && docExts.has(r.ext)) s += 5;     // readable type
      s += ((r.modifiedAt - oldest) / span) * 5;   // recency tie-break
      return s;
    };
    results.sort((a, b) => scoreFor(b) - scoreFor(a) || b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
    const top = results.slice(0, this.cfg.maxResults);

    // Attach snippets for readable files (best-effort; failures silent).
    for (const r of top) {
      try {
        const head = await this.readHead(r.path, 300);
        if (head) r.snippet = head;
      } catch {}
    }
    return top;
  }

  // Read a single file's content. Truncates at maxReadChars. Refuses
  // anything outside the allowed roots.
  async read(path: string): Promise<DocReadResult> {
    const resolved = resolve(path.replace(/^~/, homedir()));
    const display = this.prettyPath(resolved);
    if (!this.isAllowedPath(resolved)) {
      this.audit("read-denied", { path: resolved });
      return { ok: false, path: resolved, displayPath: display, content: "", truncated: false, bytes: 0, ext: extname(resolved), reason: "path not in allowed roots" };
    }
    if (!existsSync(resolved)) {
      return { ok: false, path: resolved, displayPath: display, content: "", truncated: false, bytes: 0, ext: extname(resolved), reason: "file not found" };
    }
    try {
      const st = statSync(resolved);
      if (st.isDirectory()) {
        return { ok: false, path: resolved, displayPath: display, content: "", truncated: false, bytes: 0, ext: "", reason: "is a directory" };
      }
      const ext = extname(resolved).toLowerCase();
      this.audit("read", { path: resolved, bytes: st.size });
      const text = await this.extractText(resolved, ext, st.size);
      if (text.text === null) {
        return { ok: false, path: resolved, displayPath: display, content: "", truncated: false, bytes: st.size, ext, reason: text.reason || "could not extract text" };
      }
      const truncated = text.text.length > this.cfg.maxReadChars;
      const content = truncated ? text.text.slice(0, this.cfg.maxReadChars) : text.text;
      return { ok: true, path: resolved, displayPath: display, content, truncated, bytes: st.size, ext };
    } catch (err) {
      return { ok: false, path: resolved, displayPath: display, content: "", truncated: false, bytes: 0, ext: extname(resolved), reason: (err as Error).message };
    }
  }

  // Build a markdown context block for prompt injection. The bridge
  // calls this with search results + optionally a few file bodies,
  // then prepends to the LLM system prompt.
  async buildContextBlock(query: string, opts: { includeBodies?: boolean } = {}): Promise<string> {
    const results = await this.search(query);
    if (results.length === 0) {
      return `\n\n*Personal docs:* searched for "${query}" — no matching files found in:\n${this.cfg.roots.map((r) => `- ${this.prettyPath(r)}`).join("\n")}`;
    }
    const lines: string[] = [];
    lines.push(`\n\n*Personal docs:* top ${results.length} files matching "${query}":`);
    for (const r of results) {
      const ago = humanAgo(Date.now() - r.modifiedAt);
      const size = humanBytes(r.bytes);
      lines.push(`- **${r.name}** (${r.ext.replace(".", "") || "file"}, ${size}, modified ${ago})`);
      lines.push(`  \`${r.displayPath}\``);
      if (r.snippet) lines.push(`  > ${r.snippet.replace(/\n/g, " ").slice(0, 220)}…`);
    }

    // Try reading multiple candidate files until we have enough
    // content for the LLM to answer. Scanned PDFs / image-only
    // docs return empty — we skip those and try the next match.
    // Stop after 3 successful reads or 8000 chars total to stay
    // within prompt budget.
    if (opts.includeBodies) {
      const candidates = results.filter((r) => r.ext && r.ext !== "");
      // Read top candidates IN PARALLEL. The ranker already put the
      // most relevant file at index 0; we read the top 3 concurrently
      // and keep up to MAX_FILES that produced usable text. Parallel
      // reads turn (3 × ~10s OCR) into (1 × ~10s) wall time, with
      // the OCR cache making subsequent queries essentially free.
      const MAX_FILES = 3;
      const PARALLEL_PROBE = 3;
      const CHAR_BUDGET = 12000;
      const PER_FILE_LIMIT = 5000;
      const probeCount = Math.min(candidates.length, PARALLEL_PROBE);
      const bodies = await Promise.all(
        candidates.slice(0, probeCount).map((c) => this.read(c.path).catch(() => null)),
      );
      const included: Array<{ display: string; content: string; truncated: boolean }> = [];
      let totalChars = 0;
      for (const body of bodies) {
        if (included.length >= MAX_FILES) break;
        if (totalChars >= CHAR_BUDGET) break;
        if (!body || !body.ok) continue;
        if (body.content.trim().length < 20) continue; // skip empty/garbage
        const room = CHAR_BUDGET - totalChars;
        const chunk = body.content.slice(0, Math.min(room, PER_FILE_LIMIT));
        included.push({ display: body.displayPath, content: chunk, truncated: body.truncated || chunk.length < body.content.length });
        totalChars += chunk.length;
      }
      if (included.length > 0) {
        lines.push("");
        lines.push(`*Content from ${included.length} readable file${included.length === 1 ? "" : "s"} (search the answer here first):*`);
        for (const inc of included) {
          lines.push("");
          lines.push(`--- ${inc.display}${inc.truncated ? " (truncated)" : ""} ---`);
          lines.push("```");
          lines.push(inc.content);
          lines.push("```");
        }
      } else if (candidates.length > 0) {
        lines.push("");
        lines.push(`*(tried ${candidates.length} file${candidates.length === 1 ? "" : "s"} — none had extractable text. May be scanned/image-only PDFs. Offer to attach the file itself.)*`);
      }
    }

    // Tell the LLM how to request a file attachment.
    lines.push("");
    lines.push(`*If the user wants the file ITSELF, include* \`[ATTACH:<absolute-path>]\` *on its own line in your reply. The bridge will strip the marker and send the file as an attachment.*`);
    return lines.join("\n");
  }

  // ---- internals ----------------------------------------------------------

  // Fallback when Spotlight isn't indexing the folder. Walks the
  // filesystem, returning files+folders whose name matches the query
  // case-insensitively. Pruned to skip hidden/cache dirs that would
  // make this insanely slow (node_modules, .git, Library/Caches, etc.).
  private findByName(query: string, root: string, limit: number): Promise<string[]> {
    return new Promise((resolve) => {
      // `find` with -iname "*query*" matches anywhere in the name.
      // Skip slow/noisy paths to keep traversal under a few hundred ms.
      const prunePatterns = [
        "node_modules", ".git", ".next", "dist", "build", ".cache",
        "Caches", ".Trash", ".DS_Store",
      ];
      const pruneArgs: string[] = [];
      for (const p of prunePatterns) {
        if (pruneArgs.length) pruneArgs.push("-o");
        pruneArgs.push("-name", p);
      }
      // ( -name X -o -name Y ... ) -prune -o -iname "*query*" -print
      const escaped = query.replace(/["'`$]/g, "");
      const args = [
        root,
        "(",
        ...pruneArgs,
        ")",
        "-prune",
        "-o",
        "-iname",
        `*${escaped}*`,
        "-print",
      ];
      const proc = spawn("find", args);
      let stdout = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve([]); }, 8000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", () => {}); // swallow "permission denied" noise
      proc.on("close", () => {
        clearTimeout(timer);
        const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l && l !== root);
        // No path-length sort here — the caller's relevance ranker
        // (search()) does the final ordering. Length-sorting would
        // prefer short folder paths over deeply nested files even
        // when the file is the better answer.
        resolve(lines.slice(0, limit));
      });
      proc.on("error", () => { clearTimeout(timer); resolve([]); });
    });
  }

  private mdfind(query: string, root: string, limit: number): Promise<string[]> {
    return new Promise((resolve) => {
      // -onlyin scopes the search to one root; we union across roots
      // in `search()`. -name first to also match filename hits, then
      // fall back to content search via the bare query.
      const proc = spawn("mdfind", ["-onlyin", root, query]);
      let stdout = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve([]); }, 4000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.on("close", () => {
        clearTimeout(timer);
        const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        resolve(lines.slice(0, limit));
      });
      proc.on("error", () => { clearTimeout(timer); resolve([]); });
    });
  }

  // Best-effort text extraction. PDFs use `mdls` for metadata + `mdimport`-
  // indexed text via Spotlight's preview. DOCX falls back to `textutil`
  // (built-in on macOS). TXT/MD/JSON read directly.
  private async extractText(path: string, ext: string, size: number): Promise<{ text: string | null; reason?: string }> {
    // Hard cap on size for INLINE-READ paths (txt/json/csv/docx). PDFs
    // get a higher ceiling because OCR doesn't load the whole file
    // into memory — it just renders the first N pages (max 1-2MB each
    // as PNG). A 50MB passport scan or 100MB report is normal and
    // should still be OCR-able.
    const inlineLimit = 25 * 1024 * 1024;   // 25MB for text-extracted formats
    const pdfLimit = 200 * 1024 * 1024;     // 200MB for PDFs (page-by-page render)
    const limit = ext === ".pdf" ? pdfLimit : inlineLimit;
    if (size > limit) {
      return { text: null, reason: `file is ${humanBytes(size)} — too large` };
    }
    const plainExts = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".log", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".rtf"]);
    if (plainExts.has(ext)) {
      try {
        const buf = readFileSync(path, "utf-8");
        // RTF: strip the rich-text markup for a cleaner read.
        if (ext === ".rtf") return { text: stripRTF(buf) };
        return { text: buf };
      } catch (err) {
        return { text: null, reason: (err as Error).message };
      }
    }
    // macOS-bundled textutil handles .doc, .docx, .rtf, .html, .webarchive.
    if ([".doc", ".docx", ".rtf", ".html", ".htm", ".webarchive", ".odt"].includes(ext)) {
      return { text: await this.textutil(path) };
    }
    // PDFs: try four extractors in order of quality:
    //   1. pdftotext (poppler) — best layout preservation when installed
    //   2. pdf-parse (pure-Node, bundled) — works for text PDFs
    //   3. OCR via macOS qlmanage + OpenAI Vision — handles scanned/
    //      image-only PDFs (passport scans, screenshots, etc.) which
    //      have NO embedded text. Skipped when OPENAI_API_KEY isn't
    //      set. ~3-5s for typical first-page OCR.
    //   4. Spotlight mdls preview — last-resort fallback
    if (ext === ".pdf") {
      // For LARGE PDFs (>25MB) skip the in-memory parsers — pdf-parse
      // and pdftotext both load the whole file and can OOM on a 50MB
      // scanned passport. Go straight to OCR (renders one page at a
      // time, peak memory ~ 1-2MB per page PNG).
      const isLarge = size > 25 * 1024 * 1024;
      if (!isLarge) {
        const viaPoppler = await this.pdftotext(path);
        if (viaPoppler !== null && viaPoppler.trim().length > 50) return { text: viaPoppler };
        const viaPdfParse = await this.pdfParseNode(path);
        if (viaPdfParse !== null && viaPdfParse.trim().length > 50) return { text: viaPdfParse };
      }
      // Image-only PDF (or large) — OCR via macOS PDFKit + Vision.
      const viaOcr = await this.ocrViaVision(path);
      if (viaOcr !== null && viaOcr.trim().length > 0) return { text: `[OCR via Vision LLM]\n${viaOcr}` };
      const viaSpotlight = await this.spotlightContent(path);
      if (viaSpotlight !== null) return { text: viaSpotlight };
      return { text: null, reason: "PDF text extraction failed (OCR also failed — check that an LLM provider is configured in dashboard /settings)" };
    }
    // Images: directly OCR via Vision LLM
    if ([".png", ".jpg", ".jpeg", ".heic", ".gif", ".tiff", ".tif", ".webp"].includes(ext)) {
      const viaOcr = await this.ocrViaVision(path);
      if (viaOcr) return { text: `[OCR via Vision LLM]\n${viaOcr}` };
      return { text: null, reason: "image OCR failed (check that an LLM provider is configured in dashboard /settings)" };
    }
    return { text: null, reason: `unsupported file type: ${ext || "unknown"}` };
  }

  private async readHead(path: string, chars: number): Promise<string> {
    const ext = extname(path).toLowerCase();
    if (![".txt", ".md", ".markdown", ".json", ".csv", ".log"].includes(ext)) return "";
    try {
      const buf = readFileSync(path, "utf-8");
      return buf.slice(0, chars).replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }

  private textutil(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      // textutil -convert txt -stdout reads any supported doc and
      // writes plain text. No temp file needed.
      const proc = spawn("textutil", ["-convert", "txt", "-stdout", path]);
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(null); }, 8000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.length > 0) resolve(stdout);
        else { this.logger.debug({ stderr }, "textutil failed"); resolve(null); }
      });
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  }

  // OCR fallback using macOS's built-in PDFKit (via JXA) + OpenAI
  // Vision. Renders up to PERSONAL_DOCS_OCR_MAX_PAGES pages of a PDF
  // as high-resolution PNGs, OCRs each, concatenates the results.
  // Critical for scanned/image-only PDFs (passports, receipts) where
  // the answer often lives on page 2+ (the photo-data page of a
  // passport, the totals page of a receipt, etc.).
  //
  // Why JXA + PDFKit instead of qlmanage? qlmanage -t only renders
  // the first page. PDFKit (Apple's framework, bundled with macOS)
  // exposes every page; the JXA bridge lets us drive it without
  // adding a Python / brew dependency. Zero install.
  //
  // Calls go through the bridge's /v1/vision/ocr endpoint which uses
  // the tenant's configured OpenAI key + gpt-4o-mini vision.
  // OCR cache directory. Keyed by sha1(path + size + mtime) so a
  // file that hasn't changed since last OCR returns instantly. First
  // query: ~5-10s. Cached: <50ms. Lives at ~/.lantern/ocr-cache.
  private get ocrCacheDir(): string {
    return join(homedir(), ".lantern", "ocr-cache");
  }
  private ocrCacheKey(filePath: string): string | null {
    try {
      const st = statSync(filePath);
      return createHash("sha1").update(`${filePath}|${st.size}|${st.mtimeMs}`).digest("hex");
    } catch { return null; }
  }
  private readOcrCache(filePath: string): string | null {
    const key = this.ocrCacheKey(filePath);
    if (!key) return null;
    const file = join(this.ocrCacheDir, `${key}.txt`);
    try {
      if (existsSync(file)) return readFileSync(file, "utf-8");
    } catch {}
    return null;
  }
  private writeOcrCache(filePath: string, text: string): void {
    const key = this.ocrCacheKey(filePath);
    if (!key) return;
    try {
      // mode 0o700 on dir, 0o600 on file — OCR'd text can include
      // passport/license numbers and other PII. Restrict to owner only.
      mkdirSync(this.ocrCacheDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(this.ocrCacheDir, `${key}.txt`), text, { mode: 0o600 });
    } catch (err) {
      this.logger.debug({ err }, "OCR cache write failed");
    }
  }

  private async ocrViaVision(filePath: string): Promise<string | null> {
    // Cache hit short-circuit — biggest win for repeat queries.
    const cached = this.readOcrCache(filePath);
    if (cached) {
      this.logger.info({ filePath: basename(filePath) }, "OCR cache hit");
      return cached;
    }
    const ext = extname(filePath).toLowerCase();
    const tmpDir = `/tmp/lantern-ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let needsCleanup = false;
    try {
      let pngs: string[] = [];
      if (ext === ".pdf") {
        const maxPages = Number(process.env.LANTERN_PERSONAL_DOCS_OCR_MAX_PAGES || "3");
        pngs = await this.renderPdfPages(filePath, tmpDir, Math.max(1, maxPages));
        // Even if renderPdfPages returned 0, the JXA helper may have
        // created the directory — mark for cleanup either way.
        needsCleanup = true;
        if (pngs.length === 0) {
          const ok = await this.renderPdfPage(filePath, tmpDir);
          if (!ok) return null;
          const fs = await import("fs");
          const entries = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".png"));
          if (entries.length === 0) return null;
          pngs = [`${tmpDir}/${entries[0]}`];
        }
      } else {
        pngs = [filePath];
      }

      const { authedFetch } = await import("./auth.js");
      // Parallel page OCR — vision API calls are 2-5s each, summed
      // sequentially that's 6-15s for a 3-page PDF. Parallel keeps
      // total wall-time at ~max(page durations) = 3-5s.
      const ocrPage = async (pngPath: string, idx: number): Promise<string | null> => {
        try {
          const buf = readFileSync(pngPath);
          const b64 = buf.toString("base64");
          const mime = pngPath.endsWith(".png") ? "image/png" : "image/jpeg";
          const res = await authedFetch("/v1/vision/ocr", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageDataUrl: `data:${mime};base64,${b64}`,
              prompt: "OCR this page. Label every key field: dates (incl. expiration / expiry / valid until), names, numbers, ID/passport/license numbers, addresses, signatures. Be exhaustive.",
            }),
          });
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            this.logger.warn({ status: res.status, body: body.slice(0, 200), page: idx + 1 }, "Vision OCR page failed");
            return null;
          }
          const data = (await res.json()) as { text?: string };
          return data.text?.trim() || null;
        } catch (err) {
          this.logger.warn({ err, page: idx + 1 }, "OCR page exception");
          return null;
        }
      };
      const pageResults = await Promise.all(pngs.map((p, i) => ocrPage(p, i)));
      const pageTexts: string[] = [];
      pageResults.forEach((t, i) => {
        if (t) pageTexts.push(pngs.length > 1 ? `--- page ${i + 1} ---\n${t}` : t);
      });
      const combined = pageTexts.length > 0 ? pageTexts.join("\n\n") : null;
      if (combined) this.writeOcrCache(filePath, combined);
      return combined;
    } catch (err) {
      this.logger.warn({ err }, "OCR exception");
      return null;
    } finally {
      // Always clean up — even on exception mid-OCR or early-return.
      // Without this, /tmp accumulates a tmpdir per OCR call forever.
      if (needsCleanup) {
        try {
          const fs = await import("fs");
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  // Multi-page PDF → PNG renderer using macOS PDFKit via JXA.
  // Returns an array of PNG paths (page-001.png, page-002.png, ...)
  // in the output directory, capped at `maxPages`. Renders at 2x
  // scale of the PDF's MediaBox for crisp OCR. Zero install — uses
  // /usr/bin/osascript and the system PDFKit framework.
  private renderPdfPages(pdfPath: string, outDir: string, maxPages: number): Promise<string[]> {
    return new Promise((resolve) => {
      // 0700: rendered PDF pages are document scans (passport/license/etc.)
      // — owner-only, matching the OCR-cache standard.
      try { mkdirSync(outDir, { recursive: true, mode: 0o700 }); } catch {}
      const script = `
ObjC.import('PDFKit');
ObjC.import('AppKit');
function run(argv) {
  const inputPath = argv[0];
  const outDir = argv[1];
  const maxPages = parseInt(argv[2] || '5', 10);
  const scale = parseFloat(argv[3] || '2.0');
  const url = $.NSURL.fileURLWithPath(inputPath);
  const pdfDoc = $.PDFDocument.alloc.initWithURL(url);
  if (!pdfDoc || pdfDoc.isNil()) { return ''; }
  const n = Math.min(pdfDoc.pageCount, maxPages);
  const paths = [];
  for (let i = 0; i < n; i++) {
    const page = pdfDoc.pageAtIndex(i);
    const bounds = page.boundsForBox($.kPDFDisplayBoxMediaBox);
    const w = Math.max(1, Math.floor(bounds.size.width * scale));
    const h = Math.max(1, Math.floor(bounds.size.height * scale));
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      $(), w, h, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0,
    );
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.setCurrentContext(ctx);
    const cg = ctx.CGContext;
    $.CGContextSaveGState(cg);
    $.CGContextScaleCTM(cg, scale, scale);
    page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, cg);
    $.CGContextRestoreGState(cg);
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $());
    const outPath = outDir + '/page-' + String(i+1).padStart(3,'0') + '.png';
    png.writeToFileAtomically(outPath, true);
    paths.push(outPath);
  }
  return paths.join('\\n');
}`;
      const proc = spawn("osascript", ["-l", "JavaScript", "-e", script, pdfPath, outDir, String(maxPages), "2.0"]);
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve([]); }, 60_000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          this.logger.warn({ code, stderr: stderr.slice(0, 200), pdfPath }, "PDFKit JXA render failed");
          resolve([]);
          return;
        }
        const paths = stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
        resolve(paths);
      });
      proc.on("error", (err) => { clearTimeout(timer); this.logger.warn({ err }, "PDFKit JXA spawn error"); resolve([]); });
    });
  }

  // Single-page fallback via qlmanage Quick Look. Used when PDFKit
  // can't open the file (encrypted, malformed). Slower than the
  // JXA path because qlmanage spins up the Quick Look service.
  private renderPdfPage(pdfPath: string, outDir: string): Promise<boolean> {
    return new Promise((resolve) => {
      // 0700: rendered PDF page is a document scan — owner-only.
      try { mkdirSync(outDir, { recursive: true, mode: 0o700 }); } catch {}
      const proc = spawn("qlmanage", ["-t", "-s", "1600", "-o", outDir, pdfPath]);
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(false); }, 15_000);
      proc.stderr.on("data", () => {});
      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
    });
  }

  // Pure-Node PDF text extraction via the pdf-parse package. Works
  // on any platform without external binaries — perfect default
  // when poppler isn't installed. Slower than pdftotext on large
  // PDFs (loads into memory) but fine for typical doc sizes.
  private async pdfParseNode(path: string): Promise<string | null> {
    try {
      // Dynamic import so this module loads cleanly even if
      // pdf-parse isn't installed (graceful no-op).
      const mod = await import("pdf-parse").catch(() => null) as
        | { default?: (b: Buffer) => Promise<{ text: string }>; (b: Buffer): Promise<{ text: string }> }
        | null;
      if (!mod) return null;
      const parser = (mod as { default?: (b: Buffer) => Promise<{ text: string }> }).default
        ?? (mod as unknown as (b: Buffer) => Promise<{ text: string }>);
      const buf = readFileSync(path);
      const out = await parser(buf);
      return (out?.text || "").trim();
    } catch (err) {
      this.logger.debug({ err }, "pdf-parse failed");
      return null;
    }
  }

  private pdftotext(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn("pdftotext", ["-layout", "-nopgbrk", path, "-"]);
      let stdout = "", err = false;
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(null); }, 10_000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.on("error", () => { err = true; clearTimeout(timer); resolve(null); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (err) return;
        if (code === 0 && stdout.length > 0) resolve(stdout);
        else resolve(null);
      });
    });
  }

  // Spotlight indexes most files' content — `mdls -name kMDItemTextContent`
  // returns the indexed text. Limited (Spotlight caps preview length)
  // but works without any extra deps.
  private spotlightContent(path: string): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn("mdls", ["-raw", "-name", "kMDItemTextContent", path]);
      let stdout = "";
      const timer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {}; resolve(null); }, 4000);
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.on("close", () => {
        clearTimeout(timer);
        const out = stdout.trim();
        if (out && out !== "(null)") resolve(out);
        else resolve(null);
      });
      proc.on("error", () => { clearTimeout(timer); resolve(null); });
    });
  }

  private prettyPath(absolute: string): string {
    const home = homedir();
    if (absolute.startsWith(home)) return "~" + absolute.slice(home.length);
    return absolute;
  }

  private audit(action: string, data: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({ ts: new Date().toISOString(), action, ...data }) + "\n";
      // The audit log records raw doc queries + file paths (PII at rest)
      // — owner-only (0600), matching the OCR-cache standard. mode on the
      // append only applies on creation, so chmod defensively each write.
      const fresh = !existsSync(this.cfg.auditLogPath);
      appendFileSync(this.cfg.auditLogPath, line, { mode: 0o600 });
      if (fresh) { try { chmodSync(this.cfg.auditLogPath, 0o600); } catch {} }
    } catch {}
  }
}

// ---- markers + helpers ---------------------------------------------------

// Extract [ATTACH:/path/to/file.pdf] markers from an LLM reply. Used
// by the bridge to detect attach intent + strip the marker from the
// human-facing reply.
const ATTACH_RE = /\[ATTACH:([^\]\n]+)\]/g;
export interface ExtractedAttach {
  cleanedText: string;
  paths: string[];
}
export function extractAttachMarkers(text: string): ExtractedAttach {
  const paths: string[] = [];
  const cleaned = text.replace(ATTACH_RE, (_m, p) => {
    paths.push(p.trim());
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { cleanedText: cleaned, paths };
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function humanAgo(ms: number): string {
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.floor(ms / 86_400_000)}d ago`;
  return new Date(Date.now() - ms).toLocaleDateString();
}

// Tiny RTF stripper — enough to make `.rtf` files readable. Doesn't
// preserve formatting, just yanks the visible text out.
function stripRTF(rtf: string): string {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\[a-z]+-?\d*\s?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\\'[0-9a-fA-F]{2}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Re-export so the index barrel picks them up.
export { dirname, basename };
