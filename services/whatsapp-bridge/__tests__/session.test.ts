// Tests for WhatsAppSession state transitions + owner-targeting logic.
//
// We don't connect to WhatsApp — we just construct the class, drive the
// public state-mutators, and assert the published state. The class writes
// an agent_state.json file to auth_sessions/<tenant>/ so we run each test
// from a tmp dir to keep tests independent.
//
// `isOwnerTargeted` is a pure function of the message shape; we reach in
// via bracket access since it's private — acceptable for unit tests.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { WhatsAppSession, contactReplyWantsCalendar } from "../src/session.js";

const logger = pino({ level: "silent" });

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lantern-bridge-"));
  prevCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeSession() {
  return new WhatsAppSession("test-tenant", logger);
}

describe("WhatsAppSession: mute state", () => {
  it("starts unmuted", () => {
    const s = makeSession();
    expect(s.isMuted()).toBe(false);
    expect(s.getBotState().muted).toBe(false);
  });

  it("setMuted(true) persists", () => {
    const s = makeSession();
    s.setMuted(true);
    expect(s.isMuted()).toBe(true);
    expect(s.getBotState().muted).toBe(true);
  });

  it("setMuted is idempotent (no spurious save)", () => {
    const s = makeSession();
    s.setMuted(true);
    s.setMuted(true);
    s.setMuted(true);
    expect(s.isMuted()).toBe(true);
  });

  it("state round-trips through disk", async () => {
    const s1 = makeSession();
    s1.setMuted(true);
    await s1.disconnect();

    const s2 = makeSession();
    expect(s2.isMuted()).toBe(true);
  });
});

describe("WhatsAppSession: pause state", () => {
  const alice = "15551111111@s.whatsapp.net";
  const bob = "15552222222@s.whatsapp.net";

  it("isPaused is false for unknown jid", () => {
    const s = makeSession();
    expect(s.isPaused(alice)).toBe(false);
  });

  it("pauseContact makes isPaused true", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000);
    expect(s.isPaused(alice)).toBe(true);
    expect(s.isPaused(bob)).toBe(false);
  });

  it("resumeContact clears the pause", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000);
    s.resumeContact(alice);
    expect(s.isPaused(alice)).toBe(false);
  });

  it("pause auto-expires after ttl", async () => {
    const s = makeSession();
    s.pauseContact(alice, 1); // 1 ms
    await new Promise((r) => setTimeout(r, 10));
    expect(s.isPaused(alice)).toBe(false);
  });

  it("resumeAll returns the count and clears all", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000);
    s.pauseContact(bob, 60_000);
    expect(s.resumeAll()).toBe(2);
    expect(s.isPaused(alice)).toBe(false);
    expect(s.isPaused(bob)).toBe(false);
  });

  it("resumeAll on empty map returns 0", () => {
    const s = makeSession();
    expect(s.resumeAll()).toBe(0);
  });

  it("getBotState.paused filters out expired entries", async () => {
    const s = makeSession();
    s.pauseContact(alice, 1); // expires immediately
    s.pauseContact(bob, 60_000);
    await new Promise((r) => setTimeout(r, 10));
    const state = s.getBotState();
    expect(Object.keys(state.paused)).toEqual([bob]);
  });

  it("pauseContact accepts a pushName and exposes it via internal entry", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000, "Alice");
    const entry = (s as unknown as {
      pausedUntil: Map<string, { pushName?: string; warned: boolean }>;
    }).pausedUntil.get(alice);
    expect(entry?.pushName).toBe("Alice");
    expect(entry?.warned).toBe(false);
  });

  it("pauseContact preserves pushName across re-pauses without explicit name", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000, "Alice");
    s.pauseContact(alice, 120_000); // rolling extension, no pushName
    const entry = (s as unknown as {
      pausedUntil: Map<string, { pushName?: string; warned: boolean }>;
    }).pausedUntil.get(alice);
    expect(entry?.pushName).toBe("Alice");
    expect(entry?.warned).toBe(false); // reset on every pause call
  });

  it("pauseContact re-pause resets warned flag", () => {
    const s = makeSession();
    s.pauseContact(alice, 60_000);
    const map = (s as unknown as {
      pausedUntil: Map<string, { warned: boolean }>;
    }).pausedUntil;
    const entry = map.get(alice)!;
    entry.warned = true; // simulate a prior warning
    s.pauseContact(alice, 60_000);
    expect(map.get(alice)!.warned).toBe(false);
  });

  it("pause state (with pushName) round-trips through disk", async () => {
    const s1 = makeSession();
    s1.pauseContact(alice, 60_000, "Alice");
    await s1.disconnect();

    const s2 = makeSession();
    const entry = (s2 as unknown as {
      pausedUntil: Map<string, { pushName?: string; warned: boolean }>;
    }).pausedUntil.get(alice);
    expect(entry?.pushName).toBe("Alice");
    expect(s2.isPaused(alice)).toBe(true);
  });

  it("loadState migrates legacy numeric pausedUntil entries", async () => {
    // Write a state file in the v1 (number) shape and confirm a fresh
    // session picks it up as a PauseEntry with warned=false.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const authDir = join(process.cwd(), "auth_sessions", "test-tenant");
    mkdirSync(authDir, { recursive: true });
    const until = Date.now() + 60_000;
    writeFileSync(
      join(authDir, "agent_state.json"),
      JSON.stringify({
        muted: false,
        pausedUntil: { [alice]: until },
        monitoredGroups: [],
      })
    );
    const s = makeSession();
    expect(s.isPaused(alice)).toBe(true);
    const entry = (s as unknown as {
      pausedUntil: Map<string, { until: number; warned: boolean }>;
    }).pausedUntil.get(alice);
    expect(entry?.until).toBe(until);
    expect(entry?.warned).toBe(false);
  });
});

describe("WhatsAppSession: grace-period pause-expiry warnings", () => {
  const alice = "15551111111@s.whatsapp.net";
  const bob = "15552222222@s.whatsapp.net";
  const carol = "15553333333@s.whatsapp.net";

  // Reach in to the private ticker + buffer for deterministic tests.
  // We don't await the real 30s timers — we drive them by hand.
  function tick(s: WhatsAppSession) {
    (s as unknown as { checkPauseExpiries: () => void }).checkPauseExpiries();
  }
  function pending(s: WhatsAppSession) {
    return (s as unknown as {
      pendingWarnings: Array<{ jid: string; pushName?: string }>;
    }).pendingWarnings;
  }

  it("ticker does not warn when pause is comfortably in the future", () => {
    const s = makeSession();
    s.pauseContact(alice, 60 * 60_000); // 1 hour out
    tick(s);
    expect(pending(s)).toHaveLength(0);
  });

  it("ticker warns once when pause is within 5 minutes of expiring", () => {
    const s = makeSession();
    s.pauseContact(alice, 4 * 60_000, "Alice"); // 4 min — inside the 5-min lead
    tick(s);
    expect(pending(s).map((w) => w.jid)).toEqual([alice]);
    tick(s); // second tick: already warned, no dup
    expect(pending(s)).toHaveLength(1);
  });

  it("re-pausing a contact clears `warned` so the next near-expiry warns again", () => {
    const s = makeSession();
    s.pauseContact(alice, 4 * 60_000, "Alice");
    tick(s);
    expect(pending(s)).toHaveLength(1);
    // Drain the buffer as if flushWarnings ran.
    (s as unknown as {
      pendingWarnings: Array<unknown>;
    }).pendingWarnings = [];
    // Owner replies again → pause extended → warned resets.
    s.pauseContact(alice, 4 * 60_000);
    tick(s);
    expect(pending(s)).toHaveLength(1);
  });

  it("ticker drops expired entries and warns on near-expiry in same pass", () => {
    const s = makeSession();
    s.pauseContact(alice, 1); // will be expired by the time tick runs
    s.pauseContact(bob, 2 * 60_000, "Bob");
    // busy-wait micro-sleep to guarantee expiry for alice
    const stop = Date.now() + 15;
    while (Date.now() < stop) {
      /* spin */
    }
    tick(s);
    expect(s.isPaused(alice)).toBe(false);
    expect(pending(s).map((w) => w.jid)).toEqual([bob]);
  });

  it("indefinite pauses (e.g. /bot off for a contact) never hit the warn window", () => {
    const s = makeSession();
    s.pauseContact(alice, 365 * 24 * 60 * 60_000); // 1 year
    tick(s);
    expect(pending(s)).toHaveLength(0);
  });
});

describe("WhatsAppSession: monitored groups", () => {
  const groupA = "120363042055163051@g.us";
  const groupB = "120363042055163052@g.us";
  const dm = "15551234567@s.whatsapp.net";

  it("starts with no monitored groups", () => {
    const s = makeSession();
    expect(s.getBotState().monitoredGroups).toEqual([]);
  });

  it("monitorGroup only accepts @g.us jids", () => {
    const s = makeSession();
    s.monitorGroup(dm); // silently ignored — not a group
    expect(s.isMonitoredGroup(dm)).toBe(false);
    expect(s.getBotState().monitoredGroups).toEqual([]);
  });

  it("monitorGroup/unmonitorGroup toggle", () => {
    const s = makeSession();
    s.monitorGroup(groupA);
    expect(s.isMonitoredGroup(groupA)).toBe(true);
    expect(s.isMonitoredGroup(groupB)).toBe(false);

    s.unmonitorGroup(groupA);
    expect(s.isMonitoredGroup(groupA)).toBe(false);
  });

  it("monitorGroup is idempotent", () => {
    const s = makeSession();
    s.monitorGroup(groupA);
    s.monitorGroup(groupA);
    s.monitorGroup(groupA);
    expect(s.getBotState().monitoredGroups).toEqual([groupA]);
  });

  it("monitoredGroups persist across restarts", async () => {
    const s1 = makeSession();
    s1.monitorGroup(groupA);
    s1.monitorGroup(groupB);
    await s1.disconnect();

    const s2 = makeSession();
    expect(new Set(s2.getBotState().monitoredGroups)).toEqual(new Set([groupA, groupB]));
  });
});

// ---------------------------------------------------------------------------
// isOwnerTargeted — private, but the targeting rule is the whole point
// of group support. We reach in via bracket access; acceptable for tests.
// ---------------------------------------------------------------------------
//
// We also stub the internal `socket.user` getter since ownIds() reads from it.

describe("WhatsAppSession.isOwnerTargeted", () => {
  const ownerPhone = "15550000000";
  const ownerLid = "123456789";
  const ownerJid = `${ownerPhone}@s.whatsapp.net`;
  const ownerLidJid = `${ownerLid}@lid`;

  function sessionWithOwner() {
    const s = makeSession();
    // Pretend Baileys finished handshake.
    (s as unknown as { socket: unknown }).socket = {
      user: {
        id: `${ownerPhone}:1@s.whatsapp.net`,
        lid: `${ownerLid}:1@lid`,
      },
    };
    return s;
  }

  function call(
    s: WhatsAppSession,
    msg: Parameters<
      (typeof WhatsAppSession.prototype)["isOwnerTargeted" extends keyof typeof WhatsAppSession.prototype
        ? "isOwnerTargeted"
        : never]
    >[0]
  ): boolean {
    return (s as unknown as { isOwnerTargeted: (m: unknown) => boolean }).isOwnerTargeted(msg);
  }

  it("returns false with no contextInfo", () => {
    const s = sessionWithOwner();
    expect(call(s, { message: { extendedTextMessage: {} } })).toBe(false);
  });

  it("returns true when owner is @mentioned via s.whatsapp.net", () => {
    const s = sessionWithOwner();
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: { mentionedJid: [ownerJid] },
        },
      },
    };
    expect(call(s, msg)).toBe(true);
  });

  it("returns true when owner is @mentioned via @lid (newer groups)", () => {
    const s = sessionWithOwner();
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: { mentionedJid: [ownerLidJid] },
        },
      },
    };
    expect(call(s, msg)).toBe(true);
  });

  it("returns false when someone else is @mentioned", () => {
    const s = sessionWithOwner();
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: { mentionedJid: ["15559999999@s.whatsapp.net"] },
        },
      },
    };
    expect(call(s, msg)).toBe(false);
  });

  it("returns true when message quotes one of the owner's messages", () => {
    const s = sessionWithOwner();
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: {
            quotedMessage: { conversation: "earlier" },
            participant: ownerJid,
          },
        },
      },
    };
    expect(call(s, msg)).toBe(true);
  });

  it("returns false when message quotes someone else", () => {
    const s = sessionWithOwner();
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: {
            quotedMessage: { conversation: "earlier" },
            participant: "15559999999@s.whatsapp.net",
          },
        },
      },
    };
    expect(call(s, msg)).toBe(false);
  });

  it("returns false when ownIds can't be resolved (no socket yet)", () => {
    const s = makeSession(); // no socket stub
    const msg = {
      message: {
        extendedTextMessage: {
          contextInfo: { mentionedJid: [ownerJid] },
        },
      },
    };
    expect(call(s, msg)).toBe(false);
  });
});

describe("contactReplyWantsCalendar: schedule-intent gate", () => {
  it("fires on availability / appointment phrasing", () => {
    expect(contactReplyWantsCalendar("are you free friday?")).toBe(true);
    expect(contactReplyWantsCalendar("can we meet next week to sync?")).toBe(true);
    expect(contactReplyWantsCalendar("what's your schedule like tomorrow")).toBe(true);
  });

  it("fires on travel / 'when are you coming' phrasing", () => {
    expect(contactReplyWantsCalendar("when are you coming to the Bay Area?")).toBe(true);
    expect(contactReplyWantsCalendar("are you visiting town this month?")).toBe(true);
    expect(contactReplyWantsCalendar("any plans for the long weekend?")).toBe(true);
  });

  it("does NOT fire on ordinary 1:1 chatter", () => {
    expect(contactReplyWantsCalendar("haha ok")).toBe(false);
    expect(contactReplyWantsCalendar("thanks so much!")).toBe(false);
    expect(contactReplyWantsCalendar("that movie was great")).toBe(false);
    expect(contactReplyWantsCalendar("did you eat yet")).toBe(false);
  });
});
