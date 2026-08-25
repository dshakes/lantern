import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolvePersistedMute } from "./session.js";

// Regression: a TIMED mute survived restarts as a PERMANENT one.
//
// `mute for 2h` wrote muted:true to disk but kept the unmute as an in-memory
// setTimeout. A restart killed the timer and left the flag set, so the bot
// stayed silent indefinitely with nothing logging "still muted". Observed
// live on the iMessage bridge: 274 inbound over two days, zero auto-replies.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe("resolvePersistedMute — a temporary mute must not become permanent", () => {
  it("clears a mute whose deadline passed while the process was down", () => {
    const r = resolvePersistedMute(true, NOW - HOUR, NOW);
    expect(r.muted).toBe(false);
    expect(r.mutedUntil).toBe(0);
    expect(r.rearmMs).toBe(0);
  });

  it("keeps a still-valid mute and re-arms for the REMAINING time", () => {
    const r = resolvePersistedMute(true, NOW + 30 * 60_000, NOW);
    expect(r.muted).toBe(true);
    expect(r.rearmMs).toBe(30 * 60_000); // not the original full duration
  });

  it("leaves an INDEFINITE mute muted — only an explicit unmute clears it", () => {
    for (const deadline of [undefined, 0]) {
      const r = resolvePersistedMute(true, deadline, NOW);
      expect(r.muted).toBe(true);
      expect(r.rearmMs).toBe(0); // no timer: nothing to expire
    }
  });

  it("never mutes a bridge that was not muted", () => {
    const r = resolvePersistedMute(false, NOW + HOUR, NOW);
    expect(r.muted).toBe(false);
    expect(r.rearmMs).toBe(0);
  });

  it("treats a deadline exactly at now as expired (bot resumes)", () => {
    expect(resolvePersistedMute(true, NOW, NOW).muted).toBe(false);
  });
});

// Guard against the class of bug the reviewer caught on PR #226: a code path
// that flips `muted` directly, bypassing the deadline/timer bookkeeping. Every
// mute/unmute must funnel through the helpers, or a stale mutedUntil (or a live
// timer) outlives its command and the "temporary mute" bug returns by another
// door. This greps the sources because the invariant is about call sites, not
// about any single function's return value.
describe("no code path bypasses the mute bookkeeping", () => {
  const read = (p: string) =>
    readFileSync(new URL(p, import.meta.url), "utf8")
      .split("\n")
      // Ignore the helper definitions themselves and comments.
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"));

  it("whatsapp: setMuted is only called from the mute helpers", () => {
    const lines = read("./../../whatsapp-bridge/src/session.ts");
    const offenders = lines.filter(
      (l) => /this\.setMuted\(/.test(l) && !/mutedUntil|rearmAutoUnmute|applyUnmute/.test(l),
    );
    // The two legitimate sites: inside applyUnmute, and the NL-command mute
    // (which sets mutedUntil on the following line).
    expect(offenders.length).toBeLessThanOrEqual(2);
  });

  it("imessage: every muted assignment adjusts mutedUntil nearby", () => {
    const lines = read("./session.ts");
    // The invariant spans lines: `this.muted = X` must sit within a few lines
    // of the deadline bookkeeping. A NEW call site that just flips the flag —
    // the bug the reviewer caught on the WhatsApp side — has no such neighbour
    // and fails here.
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (!/this\.muted = (true|false)/.test(l)) return;
      const near = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
      if (!/mutedUntil|rearmAutoUnmute/.test(near)) offenders.push(l.trim());
    });
    expect(offenders).toEqual([]);
  });
});
