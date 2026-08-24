import { describe, it, expect } from "vitest";
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
