// Read-only reader for the local Apple Mail "Envelope Index" SQLite — the
// I/O side of the owner's local-mailbox search (pure query building /
// formatting lives in @lantern/bridge-core/mail-index).
//
// Why this exists: the live `gmail_search` connector tool depends on a
// Google OAuth token that expires; the Envelope Index is Mail.app's own
// always-current on-disk index of EVERY synced account (~100k messages of
// sender/subject/date history) and needs no auth at all. Travel history,
// USCIS notices, old receipts — all answerable from here.
//
// Security posture (mirrors mac-usage-reader):
//   * OWNER-ONLY consumer — surfaced as the `search_email` tool, which the
//     control-plane only exposes on owner self-chat sessions.
//   * READ-ONLY open of the live index (WAL mode is built for concurrent
//     readers; we never copy the 1.6GB file, so results are never stale).
//   * FAILS CLOSED. No Full Disk Access / schema drift / lock → a
//     structured error the LLM can relay, one debug log, never a throw.
//   * Disable entirely with LANTERN_MAIL_INDEX=0.

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import Database from "better-sqlite3";
import type { Logger } from "pino";
import {
  buildMailQuery,
  rowToHit,
  type MailHit,
  type MailSearchParams,
} from "@lantern/bridge-core/mail-index";

export type MailSearchOutcome =
  | { ok: true; hits: MailHit[] }
  | { ok: false; error: string };

export function mailIndexEnabled(): boolean {
  const v = (process.env.LANTERN_MAIL_INDEX || "").toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}

// Newest V<N> data dir wins — V10 today, future-proof for macOS bumps.
export function envelopeIndexPath(mailRoot = join(homedir(), "Library", "Mail")): string | null {
  try {
    const versions = readdirSync(mailRoot)
      .filter((d) => /^V\d+$/.test(d))
      .sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
    for (const v of versions) {
      const p = join(mailRoot, v, "MailData", "Envelope Index");
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

export function searchMailIndex(params: MailSearchParams, log: Logger): MailSearchOutcome {
  if (!mailIndexEnabled()) return { ok: false, error: "local mail index disabled (LANTERN_MAIL_INDEX=0)" };
  const indexPath = envelopeIndexPath();
  if (!indexPath) {
    return { ok: false, error: "no Apple Mail envelope index on this Mac (Mail.app not set up?)" };
  }
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(indexPath, { readonly: true, fileMustExist: true });
    const { sql, args } = buildMailQuery(params);
    const rows = db.prepare(sql).all(...args) as { ts: number; comment: string; address: string; subject: string }[];
    return { ok: true, hits: rows.map(rowToHit) };
  } catch (err) {
    // Fail closed: no FDA / schema drift / lock — single debug log,
    // structured error back to the LLM.
    log.debug({ err: (err as Error).message }, "mail index search failed (fails closed)");
    return { ok: false, error: `mail index unavailable: ${(err as Error).message}` };
  } finally {
    try { db?.close(); } catch {}
  }
}
