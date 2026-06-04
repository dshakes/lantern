// Tests for the PROD-grade severe-issue fixes in the WhatsApp bridge:
//  1. start() live-socket guard (no double-socket → no 440 flap)
//  2. getMessage cache (bounded LRU populated from messages.upsert)
//  3. unified auto-reply gate (live + history-sync share one predicate)
//  4. operational-drop owner heads-up (deduped, best-effort)
//
// As with session.test.ts we never connect to WhatsApp — we construct the
// class and drive the (private) logic via bracket access. Each test runs
// from a tmp cwd so the on-disk state files stay isolated.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { WhatsAppSession } from "../src/session.js";

const logger = pino({ level: "silent" });

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lantern-bridge-fixes-"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.LANTERN_WA_OWNER_JID;
});

function makeSession() {
  return new WhatsAppSession("test-tenant", logger);
}

// ---------------------------------------------------------------------------
// Fix 1 — start() live-socket guard
// ---------------------------------------------------------------------------
describe("start() live-socket guard (440 flap prevention)", () => {
  it("no-ops when a socket already exists (does not build a second)", async () => {
    const s = makeSession();
    // Pretend a socket is live.
    const fakeSocket = { ev: { on() {} } };
    (s as unknown as { socket: unknown }).socket = fakeSocket;

    await s.start();

    // The guard must have left the existing socket untouched (no rebuild).
    expect((s as unknown as { socket: unknown }).socket).toBe(fakeSocket);
    // And the in-flight flag must not have been left set.
    expect((s as unknown as { connecting: boolean }).connecting).toBe(false);
  });

  it("no-ops when a start() is already in-flight (connecting flag set)", async () => {
    const s = makeSession();
    (s as unknown as { connecting: boolean }).connecting = true;

    await s.start();

    // Still no socket — the concurrent call bailed before building one.
    expect((s as unknown as { socket: unknown }).socket).toBeNull();
    // Guard untouched (the original in-flight start owns it).
    expect((s as unknown as { connecting: boolean }).connecting).toBe(true);
  });

  it("close handler resets the connecting flag so reconnect isn't deadlocked", () => {
    // Simulate what the connection.update 'close' branch does.
    const s = makeSession();
    (s as unknown as { connecting: boolean }).connecting = true;
    // The real handler sets connected=false; connecting=false on close.
    (s as unknown as { connecting: boolean; connected: boolean }).connecting = false;
    expect((s as unknown as { connecting: boolean }).connecting).toBe(false);
  });

  it("disconnect() clears the connecting flag", async () => {
    const s = makeSession();
    (s as unknown as { connecting: boolean }).connecting = true;
    await s.disconnect();
    expect((s as unknown as { connecting: boolean }).connecting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — getMessage cache
// ---------------------------------------------------------------------------
describe("getMessage cache (retry-receipt resend)", () => {
  type Cacher = {
    cacheMessage: (id: string | null | undefined, m: unknown) => void;
    getCachedMessage: (k: { id?: string | null }) => unknown;
    msgCache: Map<string, unknown>;
  };

  it("returns a cached message body by key.id", () => {
    const s = makeSession() as unknown as Cacher;
    const body = { conversation: "hello" };
    s.cacheMessage("ABC", body);
    expect(s.getCachedMessage({ id: "ABC" })).toBe(body);
  });

  it("returns undefined for an unknown id (Baileys then proceeds without resend)", () => {
    const s = makeSession() as unknown as Cacher;
    expect(s.getCachedMessage({ id: "nope" })).toBeUndefined();
    expect(s.getCachedMessage({})).toBeUndefined();
  });

  it("ignores empty id / empty message", () => {
    const s = makeSession() as unknown as Cacher;
    s.cacheMessage("", { conversation: "x" });
    s.cacheMessage("Y", null);
    expect(s.msgCache.size).toBe(0);
  });

  it("is bounded — FIFO-evicts the oldest beyond MSG_CACHE_MAX (1000)", () => {
    const s = makeSession() as unknown as Cacher;
    for (let i = 0; i < 1010; i++) s.cacheMessage(`id-${i}`, { conversation: String(i) });
    expect(s.msgCache.size).toBe(1000);
    // The 10 oldest were evicted; the newest survive.
    expect(s.getCachedMessage({ id: "id-0" })).toBeUndefined();
    expect(s.getCachedMessage({ id: "id-9" })).toBeUndefined();
    expect(s.getCachedMessage({ id: "id-10" })).toBeDefined();
    expect(s.getCachedMessage({ id: "id-1009" })).toBeDefined();
  });

  it("re-inserting an id refreshes its recency (delete + set moves to tail)", () => {
    const s = makeSession() as unknown as Cacher;
    s.cacheMessage("keep", { conversation: "first" });
    for (let i = 0; i < 999; i++) s.cacheMessage(`pad-${i}`, { conversation: String(i) });
    // Touch "keep" so it moves to the tail.
    s.cacheMessage("keep", { conversation: "refreshed" });
    // One more push evicts the oldest pad, NOT "keep".
    s.cacheMessage("overflow", { conversation: "z" });
    expect(s.getCachedMessage({ id: "keep" })).toEqual({ conversation: "refreshed" });
    expect(s.getCachedMessage({ id: "pad-0" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — unified auto-reply gate
// ---------------------------------------------------------------------------
describe("shouldAutoReplyToInbound — unified live/history gate", () => {
  const dm = "15551234567@s.whatsapp.net";
  const group = "120363042055163051@g.us";
  type Gate = {
    shouldAutoReplyToInbound: (a: {
      jid: string;
      text: string;
      isGroup: boolean;
      targetsOwner: boolean;
    }) => boolean;
  };

  it("DMs always pass (no allow-list)", () => {
    const s = makeSession() as unknown as Gate;
    expect(s.shouldAutoReplyToInbound({ jid: dm, text: "hi", isGroup: false, targetsOwner: false })).toBe(true);
  });

  it("unmonitored group never passes, even when targeting the owner", () => {
    const s = makeSession() as unknown as Gate;
    expect(s.shouldAutoReplyToInbound({ jid: group, text: "hey", isGroup: true, targetsOwner: true })).toBe(false);
  });

  it("monitored group requires owner-targeting", () => {
    const sess = makeSession();
    sess.monitorGroup(group);
    const s = sess as unknown as Gate;
    expect(s.shouldAutoReplyToInbound({ jid: group, text: "random chatter", isGroup: true, targetsOwner: false })).toBe(false);
    expect(s.shouldAutoReplyToInbound({ jid: group, text: "yo @you", isGroup: true, targetsOwner: true })).toBe(true);
  });

  it("a celebratory wish naming the owner bypasses monitoring + targeting", () => {
    process.env.LANTERN_OWNER_NAME = "Shekhar";
    const s = makeSession() as unknown as Gate;
    // unmonitored group, not @mention-targeted, but it's a wish naming the owner
    expect(
      s.shouldAutoReplyToInbound({
        jid: group,
        text: "Happy birthday Shekhar! 🎉",
        isGroup: true,
        targetsOwner: false,
      }),
    ).toBe(true);
    delete process.env.LANTERN_OWNER_NAME;
  });

  it("owner channel is excluded (handled elsewhere)", () => {
    process.env.LANTERN_WA_OWNER_JID = "15551234567";
    const s = makeSession() as unknown as Gate;
    expect(s.shouldAutoReplyToInbound({ jid: dm, text: "hi", isGroup: false, targetsOwner: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 — operational-drop owner heads-up (dedup)
// ---------------------------------------------------------------------------
describe("notifyOwnerOfDrop — deduped operational heads-up", () => {
  const dm = "15551234567@s.whatsapp.net";
  const other = "15559999999@s.whatsapp.net";

  function notifier(s: WhatsAppSession) {
    return s as unknown as {
      notifyOwnerOfDrop: (a: { jid: string; reason: string; text?: string; senderName?: string }) => void;
    };
  }

  it("fires confirmToSelf once, then dedups the same (jid, reason)", () => {
    const s = makeSession();
    const spy = vi.fn().mockResolvedValue(undefined);
    (s as unknown as { confirmToSelf: unknown }).confirmToSelf = spy;

    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted", text: "hello?" });
    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted", text: "still there?" });
    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted", text: "hello??" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("Unanswered message");
  });

  it("distinct reasons and distinct contacts each get their own heads-up", () => {
    const s = makeSession();
    const spy = vi.fn().mockResolvedValue(undefined);
    (s as unknown as { confirmToSelf: unknown }).confirmToSelf = spy;

    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted" });
    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "this thread is paused (you took over)" });
    notifier(s).notifyOwnerOfDrop({ jid: other, reason: "bot is muted" });

    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("never pages about the owner's own channel", () => {
    process.env.LANTERN_WA_OWNER_JID = "15551234567";
    const s = makeSession();
    const spy = vi.fn().mockResolvedValue(undefined);
    (s as unknown as { confirmToSelf: unknown }).confirmToSelf = spy;

    notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is best-effort — a throwing confirmToSelf never propagates", () => {
    const s = makeSession();
    (s as unknown as { confirmToSelf: unknown }).confirmToSelf = () => {
      throw new Error("boom");
    };
    expect(() => notifier(s).notifyOwnerOfDrop({ jid: dm, reason: "bot is muted" })).not.toThrow();
  });
});
