import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The world-model refresh must run on a MUTED channel. Mute means "don't SEND
// to contacts" (#250), not "stop thinking" — the refresh reads the owner's own
// mail/calendar/notes and writes the OWNER's profile; it never messages a
// contact. Live proof: the bridge was muted on 2026-09-18, so the refresh that
// would have corrected the stale grand-opening date never ran once, which is
// the exact incident the world model exists to prevent.
//
// Structural, because the bug is WHERE the call sits: under the
// `proactivePaused()` return (which is true whenever muted), it is dead code.
const src = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

describe("world model runs while muted", () => {
  it("is called ABOVE the proactivePaused() early return", () => {
    const tick = src.slice(src.indexOf("private async runAnticipationTick"));
    const body = tick.slice(0, tick.indexOf("gatherProactiveSignals"));
    const refresh = body.indexOf("this.maybeRefreshWorldModel(");
    const paused = body.indexOf("if (this.proactivePaused()) return;");
    expect(refresh).toBeGreaterThan(-1);
    expect(paused).toBeGreaterThan(-1);
    expect(refresh).toBeLessThan(paused);
  });

  it("still defers for quiet hours / an explicit quiet window", () => {
    const tick = src.slice(src.indexOf("private async runAnticipationTick"));
    expect(tick).toMatch(/const quiet = isQuietHours\(new Date\(\), defaultQuietHours\(\)\) \|\| now < this\.proactiveMuteUntil;/);
    expect(tick).toMatch(/if \(!quiet\) this\.maybeRefreshWorldModel\(target, now\);/);
  });

  it("the killswitch still stops it (do-nothing-at-all switch)", () => {
    const tick = src.slice(src.indexOf("private async runAnticipationTick"));
    const kill = tick.indexOf("if (this.killSwitch) return;");
    const refresh = tick.indexOf("this.maybeRefreshWorldModel(");
    expect(kill).toBeGreaterThan(-1);
    expect(kill).toBeLessThan(refresh);
  });
});
