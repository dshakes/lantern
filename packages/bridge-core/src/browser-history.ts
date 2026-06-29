// browser-history.ts — "what did I watch / browse" for the OWNER self-chat.
//
// The bot already knows which APP was in focus (knowledgeC via mac-usage), but
// not the actual content. The video titles the owner wants ("what did I watch
// on YouTube") live in the browser's own history DB. This reads Chrome (every
// profile) + Safari history READ-ONLY and returns recent watch/browse items.
//
// Mirrors the repo's two established idioms:
//   • dynamic better-sqlite3 import (contact-resolver.ts) — bridge-core has no
//     hard dep on the native module.
//   • copy-the-DB-to-a-tempfile then open read-only (mac-usage-reader.ts) — the
//     browser holds a write lock on the live DB.
//
// OWNER-ONLY by construction: the caller (handleOwnerDocQuery) only runs in the
// owner's own self-chat. Fails CLOSED: any error (no Full Disk Access, locked
// DB, schema drift, module missing) → [] and never throws. Nothing is persisted.

export interface WatchItem {
  title: string;
  url: string;
  source: "youtube" | "web";
  /** Unix ms of the last visit. */
  ts: number;
}

export interface ReadHistoryOpts {
  /** Lookback window in hours (default 168 = 7 days). */
  windowHours?: number;
  /** Max items returned (default 40). */
  limit?: number;
  /** Override "now" for tests (unix ms). */
  nowMs?: number;
  /** Override the home dir for tests. */
  homeDir?: string;
  logger?: { debug?: (o: unknown, m?: string) => void };
}

const CHROME_EPOCH_OFFSET_SEC = 11644473600; // 1601-01-01 → 1970-01-01
const SAFARI_EPOCH_OFFSET_SEC = 978307200; // 2001-01-01 → 1970-01-01

/** Is this owner message asking what they watched / browsed? */
export function isWatchQuery(text: string): boolean {
  const t = (text || "").toLowerCase().trim();
  if (!t) return false;
  // "what did i watch", "what was i watching", "what have i been watching",
  // "what did i see on youtube", "my youtube history", "what did i browse".
  if (/\b(watch(ed|ing)?|browse|browsing|browsed)\b/.test(t) && /\b(i|me|my)\b/.test(t)) {
    if (/\b(what|which|recent|history|today|earlier|lately|been)\b/.test(t)) return true;
  }
  if (/\b(youtube|yt)\b.*\bhistory\b/.test(t) || /\bhistory\b.*\b(youtube|yt)\b/.test(t)) return true;
  if (/^what('?s| is| was| did)?\b.*\bwatch/.test(t)) return true;
  return false;
}

/**
 * Read recent watch/browse history across Chrome (all profiles) + Safari.
 * Returns newest-first, deduped by URL. Never throws.
 */
export async function readWatchHistory(opts: ReadHistoryOpts = {}): Promise<WatchItem[]> {
  if (typeof process !== "undefined" && process.platform !== "darwin") return [];
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = opts.windowHours ?? 168;
  const sinceMs = nowMs - windowHours * 3_600_000;
  const limit = Math.max(1, Math.min(opts.limit ?? 40, 200));

  let Database: any, os: typeof import("node:os"), fs: typeof import("node:fs"), path: typeof import("node:path");
  try {
    const sqliteSpecifier = "better-sqlite3";
    const [sqliteMod, osMod, fsMod, pathMod] = await Promise.all([
      import(sqliteSpecifier) as Promise<any>,
      import("node:os"),
      import("node:fs"),
      import("node:path"),
    ]);
    Database = sqliteMod.default;
    os = osMod; fs = fsMod; path = pathMod;
  } catch (err) {
    opts.logger?.debug?.({ err: (err as Error)?.message }, "browser-history: better-sqlite3 unavailable (no-op)");
    return [];
  }

  const home = opts.homeDir ?? os.homedir();
  const byUrl = new Map<string, WatchItem>();

  // Each DB: copy to a private temp dir, open the COPY read-only, query, clean up.
  const readDb = (dbPath: string, query: (db: any) => WatchItem[]): void => {
    if (!fs.existsSync(dbPath)) return;
    let tmpDir = "";
    let db: any;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lantern-hist-"));
      const tmpDb = path.join(tmpDir, "h.db");
      fs.copyFileSync(dbPath, tmpDb);
      for (const ext of ["-wal", "-shm"]) {
        if (fs.existsSync(dbPath + ext)) { try { fs.copyFileSync(dbPath + ext, tmpDb + ext); } catch { /* best-effort */ } }
      }
      db = new Database(tmpDb, { readonly: true, fileMustExist: true });
      db.pragma("query_only = 1");
      for (const it of query(db)) {
        const prev = byUrl.get(it.url);
        if (!prev || it.ts > prev.ts) byUrl.set(it.url, it);
      }
    } catch (err) {
      opts.logger?.debug?.({ err: (err as Error)?.message, dbPath }, "browser-history: db read failed (fails closed)");
    } finally {
      try { db?.close(); } catch { /* ignore */ }
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  };

  const classify = (url: string): "youtube" | "web" => (/(^|\.)youtube\.com|youtu\.be/.test(url) ? "youtube" : "web");

  // ── Chrome (Default + Profile N) ──────────────────────────────────────────
  const chromeBase = path.join(home, "Library", "Application Support", "Google", "Chrome");
  if (fs.existsSync(chromeBase)) {
    let profiles: string[] = [];
    try { profiles = fs.readdirSync(chromeBase).filter((d) => d === "Default" || /^Profile \d+$/.test(d)); } catch { /* ignore */ }
    const sinceChrome = (sinceMs / 1000 + CHROME_EPOCH_OFFSET_SEC) * 1_000_000;
    for (const prof of profiles) {
      readDb(path.join(chromeBase, prof, "History"), (db) => {
        const rows = db.prepare(
          `SELECT url, title, last_visit_time AS t FROM urls
           WHERE title != '' AND last_visit_time > ?
             AND (url LIKE 'http://%' OR url LIKE 'https://%')
           ORDER BY last_visit_time DESC LIMIT 300`,
        ).all(sinceChrome) as Array<{ url: string; title: string; t: number }>;
        return rows.map((r) => ({ title: r.title, url: r.url, source: classify(r.url), ts: Math.round(r.t / 1000 - CHROME_EPOCH_OFFSET_SEC * 1000) }));
      });
    }
  }

  // ── Safari ────────────────────────────────────────────────────────────────
  const safariDb = path.join(home, "Library", "Safari", "History.db");
  const sinceSafari = sinceMs / 1000 - SAFARI_EPOCH_OFFSET_SEC;
  readDb(safariDb, (db) => {
    const rows = db.prepare(
      `SELECT i.url AS url, COALESCE(v.title, '') AS title, MAX(v.visit_time) AS t
       FROM history_visits v JOIN history_items i ON i.id = v.history_item
       WHERE v.visit_time > ? AND (i.url LIKE 'http://%' OR i.url LIKE 'https://%')
       GROUP BY i.url ORDER BY t DESC LIMIT 300`,
    ).all(sinceSafari) as Array<{ url: string; title: string; t: number }>;
    return rows
      .filter((r) => r.title)
      .map((r) => ({ title: r.title, url: r.url, source: classify(r.url), ts: Math.round((r.t + SAFARI_EPOCH_OFFSET_SEC) * 1000) }));
  });

  return [...byUrl.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/** Minimal shape of a device-signals row (avoids importing device-signals here). */
export interface PhoneSignalLite {
  kind: string; // "now_playing" | "app_open" | "focus" | ...
  app?: string;
  detail?: string;
  ts: number;
}

/** iPhone app/media usage block from device-signals (Shortcuts → /v1/signals).
 *  Surfaces what PLAYED (now_playing) + which APPS were opened in the window.
 *  Pure — testable with mock signals. Empty string when there's nothing usable. */
export function iphoneUsageBlock(signals: PhoneSignalLite[], nowMs = Date.now(), windowHours = 48): string {
  const since = nowMs - windowHours * 3_600_000;
  const recent = (signals || []).filter((s) => s && s.ts >= since);
  const ago = (ts: number): string => {
    const m = Math.max(0, Math.round((nowMs - ts) / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  const clip = (s: string, n: number): string => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  // now_playing: most recent few, dedup by title.
  const played: PhoneSignalLite[] = [];
  const seenTrack = new Set<string>();
  for (const s of recent.filter((s) => s.kind === "now_playing").sort((a, b) => b.ts - a.ts)) {
    const title = (s.detail || s.app || "").trim();
    if (!title || seenTrack.has(title.toLowerCase())) continue;
    seenTrack.add(title.toLowerCase());
    played.push(s);
    if (played.length >= 6) break;
  }
  // app_open: top apps by open count.
  const appCounts = new Map<string, { count: number; last: number }>();
  for (const s of recent.filter((s) => s.kind === "app_open" && s.app)) {
    const e = appCounts.get(s.app!) ?? { count: 0, last: 0 };
    e.count++; e.last = Math.max(e.last, s.ts);
    appCounts.set(s.app!, e);
  }
  const topApps = [...appCounts.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 6);
  if (!played.length && !topApps.length) return "";
  const lines = ["📱 On your iPhone:"];
  for (const s of played) lines.push(`• ▶ ${clip(s.detail || s.app || "", 60)} — ${ago(s.ts)}`);
  for (const [app, e] of topApps) lines.push(`• ${clip(app, 30)}${e.count > 1 ? ` ×${e.count}` : ""} — ${ago(e.last)}`);
  return lines.join("\n");
}

/** Owner-facing summary block. YouTube watches first (what they asked for),
 *  then a short "also browsed" tail. Pure — safe to unit-test with mock items.
 *  `askedYouTube`: the owner specifically asked about YouTube, so when there's
 *  no YouTube in browser history, say so + point at the iPhone-app gap. */
export function watchSummary(items: WatchItem[], nowMs = Date.now(), askedYouTube = false): string {
  const ago = (ts: number): string => {
    const m = Math.max(0, Math.round((nowMs - ts) / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };
  const clip = (s: string, n: number): string => { s = (s || "").replace(/\s*-\s*YouTube\s*$/i, "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  // Collapse repeated identical titles (e.g. 12 distinct Gmail URLs → "Gmail ×12").
  const collapse = (list: WatchItem[]): Array<{ title: string; ts: number; count: number }> => {
    const by = new Map<string, { title: string; ts: number; count: number }>();
    for (const i of list) {
      const key = clip(i.title, 80).toLowerCase();
      const e = by.get(key);
      if (e) { e.count++; e.ts = Math.max(e.ts, i.ts); } else by.set(key, { title: i.title, ts: i.ts, count: 1 });
    }
    return [...by.values()].sort((a, b) => b.ts - a.ts);
  };
  const yt = collapse(items.filter((i) => i.source === "youtube"));
  const web = collapse(items.filter((i) => i.source === "web"));

  const lines: string[] = [];
  if (yt.length) {
    lines.push("📺 Recently watched on YouTube:");
    for (const i of yt.slice(0, 8)) lines.push(`• ${clip(i.title, 70)}${i.count > 1 ? ` ×${i.count}` : ""} — ${ago(i.ts)}`);
  } else if (askedYouTube) {
    lines.push("nothing on YouTube in your browser history lately. if you watched in the YouTube *app* on your phone, I can't see that yet — it only shows up if your iPhone posts a now-playing signal (Shortcut).");
  }
  if (web.length) {
    if (lines.length) lines.push("");
    lines.push("🌐 Also browsed:");
    for (const i of web.slice(0, 6)) lines.push(`• ${clip(i.title, 60)}${i.count > 1 ? ` ×${i.count}` : ""} — ${ago(i.ts)}`);
  }
  if (!lines.length) {
    return "no browser history in the last week I can see — either nothing tracked or I don't have Full Disk Access to the browser DB.";
  }
  return lines.join("\n");
}
