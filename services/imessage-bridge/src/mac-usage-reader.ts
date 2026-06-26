// Read-only reader for macOS knowledgeC.db app-usage — the I/O side of the
// Mac app-usage signal (the pure parsing/summarization lives in
// @lantern/bridge-core/mac-usage).
//
// macOS records foreground app usage in a CoreDuet store at
//   ~/Library/Application Support/Knowledge/knowledgeC.db
// The relevant rows are in ZOBJECT where ZSTREAMNAME is '/app/usage' (a usage
// session) or '/app/inFocus' (foreground focus). Columns:
//   ZVALUESTRING  -> the app's bundle id (e.g. "com.apple.Safari")
//   ZSTARTDATE    -> Mac-absolute-time seconds (since 2001-01-01)
//   ZENDDATE      -> Mac-absolute-time seconds; duration = ZENDDATE - ZSTARTDATE
//
// PRIVACY / SAFETY (HARD RULES — see mac-usage.ts header):
//   * OFF by default. The bridge only constructs + ticks this reader when
//     LANTERN_MAC_USAGE=on. This module does nothing on its own.
//   * FAILS CLOSED. Any failure — no Full Disk Access (the bridge process has
//     FDA in prod; YOUR dev shell may not), missing DB, schema drift, lock —
//     is caught and turned into an EMPTY result + a single debug log. It NEVER
//     throws and NEVER crashes the bridge.
//   * SUMMARIES ONLY. This returns the distilled UsageSummary, not raw rows.
//     The caller persists only the small rolling cache (~/.lantern/mac-usage.json).
//
// The knowledgeC.db file is frequently WAL-locked by the live CoreDuet daemon,
// so — like other macOS-DB readers — we copy it (plus any -wal/-shm sidecars)
// to a private tempfile and open the COPY read-only. The copy is deleted after
// each read.

import Database from "better-sqlite3";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, copyFileSync, rmSync, mkdtempSync } from "node:fs";
import type { Logger } from "pino";
import {
  summarizeUsage,
  unixMsToMacAbsolute,
  type UsageRow,
  type UsageSummary,
} from "@lantern/bridge-core/mac-usage";

/** Default knowledgeC.db location for the current user. */
export function defaultKnowledgeDbPath(): string {
  return join(homedir(), "Library", "Application Support", "Knowledge", "knowledgeC.db");
}

export interface ReadUsageOpts {
  /** Override the DB path (tests / non-standard installs). */
  dbPath?: string;
  /** "now" anchor in Unix ms — the lookback window is [startOfLocalDay, now].
   *  Defaults to Date.now(). */
  nowMs?: number;
  /** Lower bound override in Unix ms. Defaults to local-midnight of nowMs
   *  ("today"). */
  sinceMs?: number;
}

// What summarizeUsage needs but defaulted here so a caller just gets a summary.
const TOP_N = 4;

/**
 * Read today's macOS app-usage and return the distilled summary. NEVER throws:
 * on any failure returns an empty summary (summaryLine === "") and logs once at
 * debug. The bridge treats an empty summary as "no signal this tick".
 */
export function readMacUsageSummary(logger: Logger, opts: ReadUsageOpts = {}): UsageSummary {
  const log = logger.child({ component: "mac-usage-reader" });
  const empty = summarizeUsage([], {}); // canonical empty summary

  const dbPath = opts.dbPath ?? defaultKnowledgeDbPath();
  const nowMs = opts.nowMs ?? Date.now();
  const sinceMs = opts.sinceMs ?? startOfLocalDay(nowMs);

  if (!existsSync(dbPath)) {
    log.debug({ dbPath }, "knowledgeC.db not found — no app-usage signal (no-op)");
    return empty;
  }

  let tmpDir = "";
  let db: Database.Database | null = null;
  try {
    // Copy the DB (+ WAL/SHM sidecars) to a private temp dir and open the COPY
    // read-only, so a live CoreDuet write-lock can't make us fail or block.
    tmpDir = mkdtempSync(join(tmpdir(), "lantern-knowledge-"));
    const tmpDb = join(tmpDir, "knowledgeC.db");
    copyFileSync(dbPath, tmpDb);
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(dbPath + ext)) {
        try {
          copyFileSync(dbPath + ext, tmpDb + ext);
        } catch {
          /* sidecar copy is best-effort */
        }
      }
    }

    db = new Database(tmpDb, { readonly: true, fileMustExist: true });
    db.pragma("query_only = 1");

    const sinceMac = unixMsToMacAbsolute(sinceMs);
    const untilMac = unixMsToMacAbsolute(nowMs);

    // ZOBJECT rows for app usage/focus within the window. We bound on
    // ZSTARTDATE so a long-running session that started today is included.
    const raw = db
      .prepare(
        `SELECT
           ZVALUESTRING AS bundleId,
           ZSTARTDATE   AS startMac,
           ZENDDATE     AS endMac
         FROM ZOBJECT
         WHERE ZSTREAMNAME IN ('/app/usage', '/app/inFocus')
           AND ZVALUESTRING IS NOT NULL
           AND ZSTARTDATE IS NOT NULL
           AND ZENDDATE   IS NOT NULL
           AND ZSTARTDATE >= ?
           AND ZSTARTDATE <= ?`,
      )
      .all(sinceMac, untilMac) as Array<{ bundleId: string; startMac: number; endMac: number }>;

    const rows: UsageRow[] = raw.map((r) => ({
      bundleId: r.bundleId,
      startMac: r.startMac,
      endMac: r.endMac,
    }));

    const summary = summarizeUsage(rows, { topN: TOP_N, nowMs });
    log.debug(
      { rows: rows.length, apps: summary.apps.length, totalMinutes: summary.totalMinutes },
      "read mac app-usage",
    );
    return summary;
  } catch (err) {
    // Fail closed: no FDA / schema drift / lock — single debug log, empty result.
    log.debug({ err: (err as Error).message }, "mac app-usage read failed (no-op, fails closed)");
    return empty;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// Local-midnight (start of "today") for a given Unix ms, in the host's local TZ.
function startOfLocalDay(unixMs: number): number {
  const d = new Date(unixMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
