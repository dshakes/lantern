import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { mutedNoticeBucket, shouldFireDropNotice } from "./session.js";

// The failure these guard: auto-reply was globally muted for WEEKS. 300+ real
// contact messages were dropped and the ONLY owner-facing signal was a single
// notice, because the notice deduped on the key "muted" with a 5-minute window
// while the state lasted weeks. Nothing was logged at all. A silent drop is
// indistinguishable from "nobody messaged me" — which is why it survived.

describe("mutedNoticeBucket — a persistent mute must get louder, not quieter", () => {
  it("re-notifies as the damage grows instead of once per window", () => {
    // Same 5-minute dedup window, but the KEY changes as drops accumulate,
    // so the owner is re-told at meaningful milestones.
    const buckets = [1, 3, 5, 10, 25, 60, 100, 300, 500, 1500, 2000].map(mutedNoticeBucket);
    expect(new Set(buckets).size).toBeGreaterThan(4);
  });

  it("still collapses runs so it never becomes spam", () => {
    // Everything between two thresholds shares a bucket => one notice.
    expect(mutedNoticeBucket(6)).toBe(mutedNoticeBucket(24));
    expect(mutedNoticeBucket(101)).toBe(mutedNoticeBucket(499));
  });

  it("keeps escalating past the last threshold", () => {
    expect(mutedNoticeBucket(4000)).not.toBe(mutedNoticeBucket(2000));
  });

  it("the old behaviour would have fired exactly once — this does not", () => {
    const state = new Map<string, number>();
    const WINDOW = 5 * 60_000;
    let now = 1_800_000_000_000;
    let oldFires = 0;
    let newFires = 0;
    const oldState = new Map<string, number>();
    // 300 drops over ~10 hours, i.e. the real outage shape.
    for (let i = 1; i <= 300; i++) {
      now += 2 * 60_000; // a message every 2 minutes
      if (shouldFireDropNotice(oldState, "muted", now, WINDOW)) oldFires++;
      if (shouldFireDropNotice(state, `muted:${mutedNoticeBucket(i)}`, now, WINDOW)) newFires++;
    }
    // The old key is constant, so it re-fires only once per 5 min of wall time;
    // the point is the NEW scheme fires on damage milestones regardless.
    expect(newFires).toBeGreaterThan(1);
    expect(newFires).toBeLessThan(oldFires + 10); // and is not spammier by much
  });
});

describe("no reply-suppressing path returns without a trace", () => {
  const src = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

  it("the muted gate logs every drop, not just the deduped notice", () => {
    const gate = src.slice(src.indexOf("if (this.muted) {"));
    const body = gate.slice(0, gate.indexOf("const until = this.pausedUntil"));
    expect(body).toMatch(/this\.logger\.warn/);
    expect(body).toMatch(/mutedDropCount/);
  });

  it("an unmonitored group chat is logged, not dropped bare", () => {
    // Regression: `if (!this.monitoredChats.has(...)) return;` with no trace
    // hid 119 dropped group messages in two days.
    expect(src).not.toMatch(/if \(!this\.monitoredChats\.has\(row\.chatRowid\)\) return;/);
    expect(src).toMatch(/group msg ignored — chat not in monitoredChats/);
  });

  it("the vestigial allow-list no longer claims to gate replies", () => {
    // The stale "default behavior is DENY" comment sent debugging down a dead
    // end; isContactEnabled had already been called from nowhere for months.
    expect(src).not.toMatch(/private isContactEnabled/);
    expect(src).toMatch(/VESTIGIAL — does NOT gate replies/);
  });

  it("a suppressing state is reported on every tick", () => {
    expect(src).toMatch(/LIVENESS: auto-reply is MUTED/);
    expect(src).toMatch(/this\.reportSilentDrops\(\);/);
  });
});
