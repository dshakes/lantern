// Read-only access to macOS Messages.app's SQLite database.
//
// The file at ~/Library/Messages/chat.db is where Messages.app stores
// every conversation. We open it read-only and poll for new rows in
// the `message` table since our last seen rowid. This is the standard
// pattern every iMessage automation tool uses (mautrix-imessage,
// BlueBubbles, etc.) — it's stable across macOS versions and doesn't
// require any private APIs.
//
// Permission requirements (one-time, on the macOS host running this):
//   System Settings → Privacy & Security → Full Disk Access
//   Add the binary that runs this service (your terminal app for dev,
//   or the LaunchAgent .plist binary for prod).
//
// Without Full Disk Access, sqlite3 will fail to open chat.db with
// SQLITE_AUTH or ENOENT — we surface that as a clear error so the user
// knows what to fix.

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import type { Logger } from "pino";
import { decodeAttributedBody } from "./attributed-body.js";

export interface IMessageRow {
  // Stable per-message identity. We track lastSeenRowid in memory and
  // bump it as we read.
  rowid: number;
  // The text body. Newer macOS (and RCS/SMS) often leave `text` NULL and put
  // the body in `attributedBody` (a typedstream archive); pollNewMessages
  // falls back to decodeAttributedBody() so those messages aren't seen as empty.
  text: string;
  // Apple-epoch nanoseconds. Apple epoch is 2001-01-01 UTC, not Unix.
  // Helper toUnixMs() converts.
  date: number;
  // True if the message was sent BY the user (outbound), false for
  // inbound from a contact.
  isFromMe: boolean;
  // Contact handle — phone "+15551234567" or email — depending on
  // how the conversation was started.
  handle: string;
  // Apple's GUID — useful for de-duping and for AppleScript
  // operations that target a specific message.
  guid: string;
  // Group chat display name (if this is a group), else empty.
  chatDisplayName: string;
  // chat.chat_identifier — the GUID/identifier needed to target a send
  // at the GROUP (e.g. "chat1234..." or the group's iMessage id). For a
  // group reply, send to this, NOT to the individual sender's handle —
  // otherwise the bot DMs the sender instead of posting in the group.
  chatIdentifier: string;
  // Service: "iMessage" or "SMS". We may want to surface SMS
  // differently in the UI.
  service: string;
  // chat.ROWID — useful for identifying threads/groups.
  chatRowid: number;
  // True if the message references one or more attachments. We
  // resolve them lazily via attachmentsFor(rowid) to avoid the join
  // cost when the caller doesn't need media.
  hasAttachments: boolean;
  // iMessage tapback / reaction marker. 0 = a normal message. Non-zero
  // means this row is a reaction (love=2000, like=2001, dislike=2002,
  // laugh=2003, emphasize=2004, question=2005; 3000-3005 = reaction
  // removed; newer macOS uses other ranges for emoji/sticker reactions).
  // The bridge must NEVER treat a reaction as an inbound message —
  // someone hearting a message in a group is not a prompt to reply.
  associatedMessageType: number;
  // When this row IS a tapback (associatedMessageType != 0), this is
  // the GUID of the message it's reacting to. Empty for normal messages.
  // Lets the bridge look up which bot-reply the owner reacted to so
  // 👎 can trigger critique-retry on THAT specific message.
  associatedMessageGuid: string;
}

export interface Attachment {
  rowid: number;
  filename: string; // absolute or ~-prefixed path to the file on disk
  mimeType: string;
  transferName: string; // original filename as transmitted (good for video labels)
  totalBytes: number;
}

const APPLE_EPOCH_OFFSET_MS = 978307200_000; // 2001-01-01 UTC in Unix ms

export function appleNsToUnixMs(ns: number): number {
  // chat.db uses nanoseconds-since-Apple-epoch in newer macOS, seconds
  // in much older ones. We detect by magnitude — values > 1e15 are ns,
  // smaller are seconds. (As of macOS Ventura, all writes are ns.)
  if (ns > 1e15) {
    return Math.round(ns / 1_000_000) + APPLE_EPOCH_OFFSET_MS;
  }
  return ns * 1000 + APPLE_EPOCH_OFFSET_MS;
}

export class ChatDB {
  private db: Database.Database | null = null;
  private path: string;
  private logger: Logger;
  private lastSeenRowid: number = 0;

  constructor(logger: Logger, customPath?: string) {
    this.logger = logger.child({ component: "chat-db" });
    this.path = customPath ?? join(homedir(), "Library", "Messages", "chat.db");
  }

  // Returns true if the database is readable. The most common failure
  // is missing Full Disk Access — we surface that explicitly.
  open(): { ok: true } | { ok: false; reason: string } {
    if (!existsSync(this.path)) {
      return {
        ok: false,
        reason: `chat.db not found at ${this.path}. iMessage may not be set up on this macOS account.`,
      };
    }
    try {
      this.db = new Database(this.path, {
        readonly: true,
        fileMustExist: true,
      });
      // Tune for our read pattern — frequent polling, no writes.
      this.db.pragma("journal_mode = WAL"); // safe for read-only opens
      this.db.pragma("query_only = 1");
      this.logger.info({ path: this.path }, "opened chat.db");
      // Initialize the high-water-mark to the current max rowid so we
      // don't spam the bridge with the user's entire message history
      // on first boot.
      const row = this.db
        .prepare("SELECT COALESCE(MAX(ROWID), 0) AS max FROM message")
        .get() as { max: number };
      this.lastSeenRowid = row.max;
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      // sqlite3's "authorization denied" or EACCES → no Full Disk Access
      if (
        msg.includes("authorization") ||
        msg.includes("EACCES") ||
        msg.includes("permission denied")
      ) {
        return {
          ok: false,
          reason: `Permission denied reading chat.db. Grant Full Disk Access to the process running lantern-imessage-bridge: System Settings → Privacy & Security → Full Disk Access → add your terminal/launchd binary.`,
        };
      }
      return { ok: false, reason: `Failed to open chat.db: ${msg}` };
    }
  }

  close() {
    this.db?.close();
    this.db = null;
  }

  // Return all messages with ROWID > lastSeenRowid, then bump the high-
  // water mark. This is the hot path called by the polling loop.
  pollNewMessages(): IMessageRow[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT
           m.ROWID                              AS rowid,
           COALESCE(m.text, '')                 AS text,
           m.attributedBody                     AS attributed_body,
           m.date                               AS date,
           m.is_from_me                         AS is_from_me,
           m.guid                               AS guid,
           COALESCE(h.id, '')                   AS handle,
           m.service                            AS service,
           m.cache_has_attachments              AS has_attachments,
           COALESCE(m.associated_message_type, 0) AS associated_message_type,
           COALESCE(m.associated_message_guid, '') AS associated_message_guid,
           c.ROWID                              AS chat_rowid,
           COALESCE(c.display_name, '')         AS chat_display_name,
           COALESCE(c.chat_identifier, '')      AS chat_identifier
         FROM message m
         LEFT JOIN handle h            ON m.handle_id = h.ROWID
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c              ON c.ROWID = cmj.chat_id
         WHERE m.ROWID > ?
         ORDER BY m.ROWID ASC
         LIMIT 200`,
      )
      .all(this.lastSeenRowid) as Array<{
      rowid: number;
      text: string;
      attributed_body: Buffer | null;
      date: number;
      is_from_me: number;
      guid: string;
      handle: string;
      service: string;
      has_attachments: number;
      associated_message_type: number;
      associated_message_guid: string;
      chat_rowid: number;
      chat_display_name: string;
      chat_identifier: string;
    }>;

    if (rows.length === 0) return [];
    this.lastSeenRowid = rows[rows.length - 1].rowid;

    return rows.map((r) => ({
      rowid: r.rowid,
      // Newer iMessages — and RCS/SMS — frequently leave m.text NULL and
      // store the body in attributedBody (a typedstream archive). Decode it
      // so the bot sees those messages instead of an empty inbound.
      text: r.text || decodeAttributedBody(r.attributed_body) || "",
      date: r.date,
      isFromMe: !!r.is_from_me,
      handle: r.handle,
      guid: r.guid,
      service: r.service ?? "iMessage",
      chatRowid: r.chat_rowid,
      chatDisplayName: r.chat_display_name,
      chatIdentifier: r.chat_identifier,
      hasAttachments: !!r.has_attachments,
      associatedMessageType: r.associated_message_type ?? 0,
      // The associated_message_guid column has prefixes in newer
      // macOS (e.g. "p:0/<guid>" for the part-index variant) —
      // strip them so a downstream GUID compare matches.
      associatedMessageGuid: (r.associated_message_guid || "").replace(
        /^p:\d+\//,
        "",
      ),
    }));
  }

  // Look up attachments for a specific message. Called lazily when a
  // poll row has hasAttachments=true — most messages don't, so we
  // skip the join cost in the common case.
  attachmentsFor(messageRowid: number): Attachment[] {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT
           a.ROWID                       AS rowid,
           COALESCE(a.filename, '')      AS filename,
           COALESCE(a.mime_type, '')     AS mime_type,
           COALESCE(a.transfer_name, '') AS transfer_name,
           COALESCE(a.total_bytes, 0)    AS total_bytes
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         WHERE maj.message_id = ?`,
      )
      .all(messageRowid) as Array<{
      rowid: number;
      filename: string;
      mime_type: string;
      transfer_name: string;
      total_bytes: number;
    }>;
    return rows.map((r) => ({
      rowid: r.rowid,
      filename: r.filename,
      mimeType: r.mime_type,
      transferName: r.transfer_name,
      totalBytes: r.total_bytes,
    }));
  }

  // Recent messages for a chat (both directions), oldest→newest, for
  // building the conversation-context block fed to the reply model.
  // Reaction/tapback rows (associated_message_type != 0) are excluded —
  // they're not real messages. Empty-text rows (attachments/stickers)
  // are kept as a placeholder so the timeline reads correctly.
  recentMessages(
    chatRowid: number,
    limit = 10,
  ): Array<{ fromMe: boolean; text: string }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT m.is_from_me AS is_from_me,
                COALESCE(m.text, '') AS text,
                m.attributedBody AS attributed_body,
                COALESCE(m.associated_message_type, 0) AS amt,
                m.cache_has_attachments AS has_att
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         WHERE cmj.chat_id = ?
           AND COALESCE(m.associated_message_type, 0) = 0
         ORDER BY m.ROWID DESC
         LIMIT ?`,
      )
      .all(chatRowid, limit) as Array<{
      is_from_me: number;
      text: string;
      attributed_body: Buffer | null;
      amt: number;
      has_att: number;
    }>;
    // Query is newest-first; reverse to oldest-first for natural reading.
    return rows
      .reverse()
      .map((r) => ({
        fromMe: !!r.is_from_me,
        // Decode attributedBody so RCS/newer messages stay in the reply
        // context instead of dropping out of the transcript.
        text:
          r.text.trim() ||
          decodeAttributedBody(r.attributed_body) ||
          (r.has_att ? "[attachment]" : ""),
      }))
      .filter((m) => m.text.length > 0);
  }

  // Cold-start voice mining: pull the owner's OWN recent sent messages
  // (is_from_me=1) from 1:1 chats, grouped by contact handle, newest
  // first within each handle. Used at session start to pre-seed the
  // per-contact owner-voice ring buffer so the bot can mimic the owner's
  // real style before the owner happens to text during this process's
  // lifetime. Group chats are excluded (display_name <> '') because the
  // owner's voice there is diluted by audience; we want true 1:1 voice.
  //
  // `perHandle` caps rows kept per contact; `maxHandles` bounds total
  // work so a chat.db with thousands of threads can't blow up boot.
  // Newest-first ordering means callers can fill the ring with the most
  // recent (most representative) messages and trim the rest.
  ownerSentByHandle(opts: {
    perHandle: number;
    maxHandles?: number;
  }): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (!this.db) return out;
    const perHandle = Math.max(1, opts.perHandle);
    const maxHandles = Math.max(1, opts.maxHandles ?? 500);
    // Scan a bounded window of recent owner-sent rows, newest first, and
    // bucket by handle until each bucket is full / the handle cap is hit.
    // A flat LIMIT keeps the query cheap (date-indexed) without a window
    // function — we do the per-handle capping in JS.
    const scanLimit = perHandle * maxHandles;
    const rows = this.db
      .prepare(
        `SELECT COALESCE(h.id, '')          AS handle,
                COALESCE(m.text, '')         AS text,
                m.attributedBody             AS attributed_body
         FROM message m
         JOIN handle h               ON m.handle_id = h.ROWID
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c            ON c.ROWID = cmj.chat_id
         WHERE m.is_from_me = 1
           AND COALESCE(m.associated_message_type, 0) = 0
           AND COALESCE(c.display_name, '') = ''
           AND (COALESCE(m.text, '') <> '' OR m.attributedBody IS NOT NULL)
         ORDER BY m.ROWID DESC
         LIMIT ?`,
      )
      .all(scanLimit) as Array<{
      handle: string;
      text: string;
      attributed_body: Buffer | null;
    }>;
    for (const r of rows) {
      const handle = r.handle.trim();
      if (!handle) continue;
      const text = (r.text.trim() || decodeAttributedBody(r.attributed_body) || "").trim();
      if (!text) continue;
      let bucket = out.get(handle);
      if (!bucket) {
        if (out.size >= maxHandles) continue;
        bucket = [];
        out.set(handle, bucket);
      }
      if (bucket.length >= perHandle) continue;
      bucket.push(text);
    }
    // Buckets are newest-first; reverse to oldest-first so callers append
    // into a ring that ends on the most recent message.
    for (const bucket of out.values()) bucket.reverse();
    return out;
  }

  // List all known chats so the dashboard can show a contact picker.
  // Used by GET /session/:tid/chats.
  listChats(): Array<{
    rowid: number;
    displayName: string;
    chatIdentifier: string;
    participantCount: number;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT
           c.ROWID                       AS rowid,
           COALESCE(c.display_name, '')  AS display_name,
           COALESCE(c.chat_identifier, '') AS chat_identifier,
           (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participant_count
         FROM chat c
         ORDER BY c.last_read_message_timestamp DESC
         LIMIT 500`,
      )
      .all() as Array<{
      rowid: number;
      display_name: string;
      chat_identifier: string;
      participant_count: number;
    }>;
    return rows.map((r) => ({
      rowid: r.rowid,
      displayName: r.display_name,
      chatIdentifier: r.chat_identifier,
      participantCount: r.participant_count,
    }));
  }

  // Powerful keyword + date-range search across the entire chat.db.
  // Used by the LLM tool `search_imessage_history` to answer cross-
  // source questions like "what did the family group say during my
  // Turkey trip?". All filters are optional; an empty filter set
  // returns the most recent `limit` messages overall.
  //
  // Performance: chat.db is well-indexed on date — typical query is
  // sub-100ms even on tens of thousands of messages. We cap `limit`
  // to 50 to keep LLM context small.
  searchMessages(opts: {
    keyword?: string;
    sinceMs?: number; // Unix ms (inclusive)
    untilMs?: number; // Unix ms (inclusive)
    handle?: string; // exact match on contact phone/email
    groupOnly?: boolean;
    limit?: number;
  }): Array<{
    rowid: number;
    text: string;
    unixMs: number;
    fromMe: boolean;
    handle: string;
    chatDisplayName: string;
    chatIdentifier: string;
    isGroup: boolean;
  }> {
    if (!this.db) return [];
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
    const APPLE_EPOCH_MS = 978307200_000;
    // chat.db stores date as nanoseconds-since-Apple-epoch on modern
    // macOS. Convert our Unix-ms bounds to that scale.
    const toAppleNs = (unixMs: number) => (unixMs - APPLE_EPOCH_MS) * 1_000_000;
    const where: string[] = [
      "COALESCE(m.associated_message_type, 0) = 0",
      "(COALESCE(m.text, '') <> '' OR m.attributedBody IS NOT NULL)",
    ];
    const params: Array<string | number> = [];
    if (opts.keyword && opts.keyword.trim()) {
      where.push("m.text LIKE ?");
      params.push("%" + opts.keyword.trim() + "%");
    }
    if (typeof opts.sinceMs === "number" && Number.isFinite(opts.sinceMs)) {
      where.push("m.date >= ?");
      params.push(toAppleNs(opts.sinceMs));
    }
    if (typeof opts.untilMs === "number" && Number.isFinite(opts.untilMs)) {
      where.push("m.date <= ?");
      params.push(toAppleNs(opts.untilMs));
    }
    if (opts.handle && opts.handle.trim()) {
      where.push("h.id = ?");
      params.push(opts.handle.trim());
    }
    if (opts.groupOnly) {
      where.push("COALESCE(c.display_name, '') <> ''");
    }
    const sql = `
      SELECT
        m.ROWID                              AS rowid,
        COALESCE(m.text, '')                 AS text,
        m.attributedBody                     AS attributed_body,
        m.date                               AS date,
        m.is_from_me                         AS is_from_me,
        COALESCE(h.id, '')                   AS handle,
        COALESCE(c.display_name, '')         AS chat_display_name,
        COALESCE(c.chat_identifier, '')      AS chat_identifier
      FROM message m
      LEFT JOIN handle h               ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj  ON cmj.message_id = m.ROWID
      LEFT JOIN chat c                 ON c.ROWID = cmj.chat_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.date DESC
      LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Array<{
      rowid: number;
      text: string;
      attributed_body: Buffer | null;
      date: number;
      is_from_me: number;
      handle: string;
      chat_display_name: string;
      chat_identifier: string;
    }>;
    return rows.map((r) => ({
      rowid: r.rowid,
      text: r.text || decodeAttributedBody(r.attributed_body) || "",
      unixMs: appleNsToUnixMs(r.date),
      fromMe: !!r.is_from_me,
      handle: r.handle,
      chatDisplayName: r.chat_display_name,
      chatIdentifier: r.chat_identifier,
      isGroup: r.chat_display_name !== "",
    }));
  }

  // List all iMessage groups (multi-participant chats) with their
  // names and participant counts. Used by the LLM tool
  // `list_imessage_groups` so the bot can find a trip/family/etc
  // group by name. Sorted by recency.
  listGroups(): Array<{
    chatRowid: number;
    name: string;
    chatIdentifier: string;
    participantCount: number;
  }> {
    if (!this.db) return [];
    const rows = this.db
      .prepare(
        `SELECT
           c.ROWID                       AS rowid,
           COALESCE(c.display_name, '')  AS display_name,
           COALESCE(c.chat_identifier, '') AS chat_identifier,
           (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS participant_count
         FROM chat c
         WHERE (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) >= 2
         ORDER BY c.last_read_message_timestamp DESC
         LIMIT 500`,
      )
      .all() as Array<{
      rowid: number;
      display_name: string;
      chat_identifier: string;
      participant_count: number;
    }>;
    return rows.map((r) => ({
      chatRowid: r.rowid,
      name: r.display_name || r.chat_identifier,
      chatIdentifier: r.chat_identifier,
      participantCount: r.participant_count,
    }));
  }

  // Return all members (handles) of a specific group, looked up by
  // chatRowid OR by group-name (case-insensitive substring). Generic
  // enough to answer "who's in the Japan trip group?" — works for
  // ANY chat the user is part of.
  getGroupMembers(opts: { chatRowid?: number; name?: string }): {
    chatRowid: number;
    name: string;
    chatIdentifier: string;
    members: string[];
  } | null {
    if (!this.db) return null;
    let target = opts.chatRowid || 0;
    if (!target && opts.name && opts.name.trim()) {
      const all = this.listGroups();
      const needle = opts.name.trim().toLowerCase();
      const match = all.find((g) => g.name.toLowerCase().includes(needle));
      if (!match) return null;
      target = match.chatRowid;
    }
    if (!target) return null;
    const meta = this.db
      .prepare(
        `SELECT COALESCE(display_name, '') AS display_name,
                COALESCE(chat_identifier, '') AS chat_identifier
         FROM chat WHERE ROWID = ?`,
      )
      .get(target) as
      | { display_name: string; chat_identifier: string }
      | undefined;
    if (!meta) return null;
    const handleRows = this.db
      .prepare(
        `SELECT COALESCE(h.id, '') AS handle
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
         WHERE chj.chat_id = ?`,
      )
      .all(target) as Array<{ handle: string }>;
    return {
      chatRowid: target,
      name: meta.display_name || meta.chat_identifier,
      chatIdentifier: meta.chat_identifier,
      members: handleRows.map((r) => r.handle).filter(Boolean),
    };
  }

  // For surfacing to the dashboard health view.
  diagnostics(): { path: string; lastSeenRowid: number; open: boolean } {
    return {
      path: this.path,
      lastSeenRowid: this.lastSeenRowid,
      open: this.db !== null,
    };
  }
}
