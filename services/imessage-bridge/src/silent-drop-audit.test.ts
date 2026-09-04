import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { shouldFireDropNotice } from "./session.js";
import { mutedNoticeBucket } from "@lantern/bridge-core/natural";

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
    // and the notice is behind the fired-bucket set, not the time dedup alone
    expect(body).toMatch(/firedMutedBuckets\.has\(bucket\)/);
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

describe("every send path reaches the outbound audit log", () => {
  const src = readFileSync(new URL("./session.ts", import.meta.url), "utf8");

  it("the SMS pre-route branch audits before it returns", () => {
    // Found by the first real end-to-end test: an RCS-only contact got a real
    // reply via Text Message Forwarding, but the branch returns early — before
    // the audit at the end of send() — so the log built to measure reply
    // quality had no record of the one reply that proved the path works.
    const branch = src.slice(src.indexOf("pre-routed via SMS service"));
    const upToReturn = branch.slice(0, branch.indexOf("return { ok: true }"));
    expect(upToReturn).toMatch(/"outbound sent"/);
  });

  it("send() has an audit line for each early return", () => {
    const fn = src.slice(src.indexOf("pre-routed via SMS service") - 4000);
    const body = fn.slice(0, fn.indexOf("private recordBridgeSend"));
    const audits = (body.match(/"outbound sent"/g) || []).length;
    // One for the SMS pre-route branch, one for the normal path.
    expect(audits).toBeGreaterThanOrEqual(2);
  });
});


// The ladder as first shipped was NOT a ladder. notifyOwnerOfDrop's dedup
// prunes keys older than 5 minutes, so the bucket key "muted:100" re-fired on
// every quiet gap: 484 drops over ten days → 204 owner notices. A bucket must
// fire once per mute episode regardless of how the drops are spaced.
describe("muted notice ladder — fires per bucket, not per quiet gap", () => {
  it("484 realistically-spaced drops produce at most ~6 notices", () => {
    // Model the bridge's gate: a fired-bucket Set in front of the dedup.
    const fired = new Set<string>();
    const dedup = new Map<string, number>();
    let now = 1_800_000_000_000;
    let notices = 0;
    for (let i = 1; i <= 484; i++) {
      now += (i % 3 === 0 ? 31 : 2) * 60_000; // most gaps > the 5-min window
      const b = mutedNoticeBucket(i);
      if (fired.has(b)) continue;
      fired.add(b);
      if (shouldFireDropNotice(dedup, `muted:${b}`, now, 5 * 60_000)) notices++;
    }
    expect(notices).toBeLessThanOrEqual(6);
    expect(notices).toBeGreaterThanOrEqual(4); // still escalates
  });

  it("the OLD gate (dedup only) re-fires on quiet gaps — pins why the set exists", () => {
    const dedup = new Map<string, number>();
    let now = 1_800_000_000_000;
    let notices = 0;
    for (let i = 1; i <= 484; i++) {
      now += (i % 3 === 0 ? 31 : 2) * 60_000;
      if (shouldFireDropNotice(dedup, `muted:${mutedNoticeBucket(i)}`, now, 5 * 60_000)) notices++;
    }
    expect(notices).toBeGreaterThan(50); // the spam the set prevents
  });

  it("unmute resets the episode so a later mute re-notifies from bucket 1", () => {
    const src = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
    const unmute = src.slice(src.indexOf("private applyUnmute("), src.indexOf("private applyUnmute(") + 600);
    expect(unmute).toMatch(/firedMutedBuckets\.clear\(\)/);
    expect(unmute).toMatch(/mutedDropCount = 0/);
  });
});
