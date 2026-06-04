// Regression tests for the chat.db poll-loop silent-message-loss fixes.
//
// PRODUCTION BUG CLASS: pollNewMessages() advanced the high-water cursor
// internally BEFORE any row was handled, and the whole batch ran inside a
// single try/catch. So a row that threw mid-handling (LLM error,
// AppleScript error, decode error) aborted every row after it in the
// batch — and the cursor had already moved past them all, losing those
// inbounds forever.
//
// The fix: peekNewMessages() reads without advancing; the loop advances
// the cursor PER ROW (advanceCursorTo, monotonic) only after a row is
// handled or deliberately skipped; each row runs in its own try/catch via
// the pure processPollBatch(); and a thrown row is surfaced via onRowError
// (never silently lost) before the cursor steps past it.

import { describe, it, expect } from "vitest";
import { ChatDB } from "./chat-db.js";
import { processPollBatch, shouldFireDropNotice } from "./session.js";
import pino from "pino";

const silent = pino({ level: "silent" });

type Row = { rowid: number; isFromMe: boolean; handle?: string };

describe("processPollBatch — per-row isolation + cursor safety", () => {
  it("a throwing row does NOT prevent the next row from processing", () => {
    const rows: Row[] = [
      { rowid: 1, isFromMe: false, handle: "a" },
      { rowid: 2, isFromMe: false, handle: "POISON" },
      { rowid: 3, isFromMe: false, handle: "c" },
    ];
    const handled: number[] = [];
    const errored: number[] = [];
    let cursor = 0;
    processPollBatch(rows, {
      isFlood: false,
      handleRow: (r) => {
        if (r.handle === "POISON") throw new Error("boom");
        handled.push(r.rowid);
      },
      advanceCursorTo: (rowid) => {
        if (rowid > cursor) cursor = rowid;
      },
      onRowError: (r) => errored.push(r.rowid),
    });
    // Rows 1 and 3 processed despite row 2 throwing.
    expect(handled).toEqual([1, 3]);
    // Row 2's throw was surfaced, not swallowed.
    expect(errored).toEqual([2]);
  });

  it("does NOT advance the cursor past an unprocessed row until it is handled", () => {
    // Simulate handling stopping mid-batch (handleRow refuses row 3+).
    const rows: Row[] = [
      { rowid: 10, isFromMe: false, handle: "a" },
      { rowid: 11, isFromMe: false, handle: "b" },
      { rowid: 12, isFromMe: false, handle: "c" },
    ];
    let cursor = 5;
    const advances: number[] = [];
    let processedCount = 0;
    expect(() =>
      processPollBatch(rows, {
        isFlood: false,
        handleRow: () => {
          processedCount++;
          if (processedCount === 2) {
            // Row 11 throws — but row 12 must NOT have advanced the cursor
            // before row 11 is dealt with. The loop advances PAST a thrown
            // row deliberately (to avoid a poison-pill wedge), so after
            // the batch the cursor reaches 12 — but never SKIPS 11.
            throw new Error("transient");
          }
        },
        advanceCursorTo: (rowid) => {
          advances.push(rowid);
          if (rowid > cursor) cursor = rowid;
        },
        onRowError: () => {},
      }),
    ).not.toThrow();
    // Cursor advanced strictly in row order: 10, then 11 (after its throw
    // was surfaced), then 12 — never jumping 11→12 leaving 11 behind.
    expect(advances).toEqual([10, 11, 12]);
    expect(cursor).toBe(12);
  });

  it("flood is_from_me rows are skipped but still advance the cursor", () => {
    const rows: Row[] = [
      { rowid: 1, isFromMe: true, handle: "bot" },
      { rowid: 2, isFromMe: false, handle: "user" },
    ];
    const handled: number[] = [];
    let cursor = 0;
    processPollBatch(rows, {
      isFlood: true,
      handleRow: (r) => handled.push(r.rowid),
      advanceCursorTo: (rowid) => {
        if (rowid > cursor) cursor = rowid;
      },
      onRowError: () => {},
    });
    // Bot row skipped (not handled), user row handled.
    expect(handled).toEqual([2]);
    // Cursor advanced past BOTH — the skipped bot row is "handled" by
    // being deliberately dropped, so it never re-surfaces next tick.
    expect(cursor).toBe(2);
  });

  it("empty batch is a no-op", () => {
    let cursor = 7;
    processPollBatch([], {
      isFlood: false,
      handleRow: () => {
        throw new Error("should not be called");
      },
      advanceCursorTo: (rowid) => {
        cursor = rowid;
      },
      onRowError: () => {},
    });
    expect(cursor).toBe(7);
  });
});

describe("ChatDB.advanceCursorTo — monotonic high-water mark", () => {
  it("only ever moves the cursor forward (a stale advance can't rewind)", () => {
    const db = new ChatDB(silent);
    // No open() — lastSeenRowid starts at 0; advanceCursorTo is pure state.
    expect(db.diagnostics().lastSeenRowid).toBe(0);
    db.advanceCursorTo(5);
    expect(db.diagnostics().lastSeenRowid).toBe(5);
    db.advanceCursorTo(10);
    expect(db.diagnostics().lastSeenRowid).toBe(10);
    // A stale/duplicate advance behind the mark is ignored.
    db.advanceCursorTo(3);
    expect(db.diagnostics().lastSeenRowid).toBe(10);
    db.advanceCursorTo(10);
    expect(db.diagnostics().lastSeenRowid).toBe(10);
  });
});

describe("shouldFireDropNotice — owner heads-up dedup", () => {
  it("fires once per key per window, suppresses repeats inside the window", () => {
    const state = new Map<string, number>();
    const win = 60_000;
    // First fire for the key → true.
    expect(shouldFireDropNotice(state, "muted", 1_000, win)).toBe(true);
    // Same key inside the window → suppressed.
    expect(shouldFireDropNotice(state, "muted", 2_000, win)).toBe(false);
    expect(shouldFireDropNotice(state, "muted", 60_000, win)).toBe(false);
    // A DIFFERENT key fires independently.
    expect(shouldFireDropNotice(state, "killswitch", 2_000, win)).toBe(true);
    // After the window elapses, the same key fires again.
    expect(shouldFireDropNotice(state, "muted", 1_000 + win, win)).toBe(true);
  });

  it("per-contact keys dedup independently", () => {
    const state = new Map<string, number>();
    const win = 300_000;
    expect(shouldFireDropNotice(state, "llm-empty:+1555", 0, win)).toBe(true);
    expect(shouldFireDropNotice(state, "llm-empty:+1666", 0, win)).toBe(true);
    expect(shouldFireDropNotice(state, "llm-empty:+1555", 100, win)).toBe(false);
  });
});
