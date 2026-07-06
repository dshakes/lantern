// node:test suite for reaction-commands.ts — Brief reaction one-tap layer.
// Run: node --import=tsx/esm --test src/reaction-commands.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  tapbackToEmoji,
  mapBriefReactionToAction,
  ReactableLog,
  strikeBriefLines,
} from "./reaction-commands.ts";
import type { BriefItem, RefKind } from "./command-center.ts";

function item(ref: RefKind, over: Partial<BriefItem> = {}): BriefItem {
  return {
    n: 1,
    ref,
    id: `${ref}-id`,
    icon: "⏳",
    label: `a ${ref}`,
    defaultAction: "act",
    actions: ["act"],
    ...over,
  };
}

describe("tapbackToEmoji", () => {
  it("maps the four actionable add codes", () => {
    assert.equal(tapbackToEmoji(2000), "❤️");
    assert.equal(tapbackToEmoji(2001), "👍");
    assert.equal(tapbackToEmoji(2002), "👎");
    assert.equal(tapbackToEmoji(2005), "❓");
  });
  it("returns null for laugh, emphasize, removals, and junk", () => {
    for (const code of [2003, 2004, 3000, 3001, 3002, 3005, 0, 42, -1]) {
      assert.equal(tapbackToEmoji(code), null, `code ${code}`);
    }
  });
});

describe("mapBriefReactionToAction — kind-aware", () => {
  it("confirm set is kind-aware", () => {
    for (const e of ["👍", "❤️", "✅", "🫡", "💯"]) {
      assert.equal(mapBriefReactionToAction(e, item("draft")), "send", e);
      assert.equal(mapBriefReactionToAction(e, item("commitment")), "done", e);
      assert.equal(mapBriefReactionToAction(e, item("thread")), "draft", e);
      assert.equal(mapBriefReactionToAction(e, item("life_event")), "act", e);
      assert.equal(mapBriefReactionToAction(e, item("news_item")), "act", e);
    }
  });
  it("fire set escalates commitment to act, else like confirm", () => {
    for (const e of ["🔥", "🚀", "⚡"]) {
      assert.equal(mapBriefReactionToAction(e, item("draft")), "send", e);
      assert.equal(mapBriefReactionToAction(e, item("commitment")), "act", e);
      assert.equal(mapBriefReactionToAction(e, item("thread")), "draft", e);
    }
  });
  it("reject / snooze / peek are kind-independent", () => {
    for (const e of ["👎", "❌", "🚫"]) assert.equal(mapBriefReactionToAction(e, item("draft")), "skip", e);
    for (const e of ["⏰", "😴", "💤", "🕐"]) assert.equal(mapBriefReactionToAction(e, item("commitment")), "snooze", e);
    for (const e of ["❓", "❔", "👀"]) assert.equal(mapBriefReactionToAction(e, item("thread")), "review", e);
  });
  it("auto_action ALWAYS returns null (undo needs a typed word)", () => {
    for (const e of ["👍", "❤️", "✅", "👎", "⏰", "❓", "🔥"]) {
      assert.equal(mapBriefReactionToAction(e, item("auto_action")), null, e);
    }
  });
  it("unknown emoji returns null", () => {
    for (const ref of ["draft", "commitment", "thread", "life_event", "news_item"] as RefKind[]) {
      assert.equal(mapBriefReactionToAction("🍕", item(ref)), null, ref);
      assert.equal(mapBriefReactionToAction("", item(ref)), null, ref);
    }
  });
  it("trims surrounding whitespace on the emoji", () => {
    assert.equal(mapBriefReactionToAction(" 👍 ", item("draft")), "send");
  });
});

describe("ReactableLog", () => {
  it("resolves the top item (items[0]) regardless of which item, kind-aware", () => {
    const log = new ReactableLog();
    const items = [item("draft", { n: 1 }), item("thread", { n: 2 })];
    log.remember("m1", items);
    const hit = log.resolve("m1", "👍");
    assert.ok(hit);
    assert.equal(hit.item.n, 1); // top pick
    assert.equal(hit.action, "send"); // draft + confirm
  });
  it("misses on unknown message id", () => {
    const log = new ReactableLog();
    log.remember("m1", [item("draft")]);
    assert.equal(log.resolve("other", "👍"), null);
  });
  it("misses on non-actionable emoji even when id matches", () => {
    const log = new ReactableLog();
    log.remember("m1", [item("draft")]);
    assert.equal(log.resolve("m1", "🍕"), null);
  });
  it("expires entries past the 60-min TTL", () => {
    const log = new ReactableLog();
    const t0 = 1_000_000;
    log.remember("m1", [item("draft")], t0);
    assert.ok(log.resolve("m1", "👍", t0 + 59 * 60_000)); // just inside
    assert.equal(log.resolve("m1", "👍", t0 + 61 * 60_000), null); // past TTL
  });
  it("caps at 20 entries (ring buffer evicts oldest)", () => {
    const log = new ReactableLog();
    for (let i = 0; i < 25; i++) log.remember(`m${i}`, [item("draft")]);
    assert.equal(log.resolve("m0", "👍"), null); // evicted
    assert.ok(log.resolve("m24", "👍")); // newest kept
  });
  it("ignores empty id or empty items", () => {
    const log = new ReactableLog();
    log.remember("", [item("draft")]);
    log.remember("m1", []);
    assert.equal(log.resolve("", "👍"), null);
    assert.equal(log.resolve("m1", "👍"), null);
  });
  it("re-remembering the same id refreshes items, no duplicate", () => {
    const log = new ReactableLog();
    log.remember("m1", [item("draft", { n: 1 })]);
    log.remember("m1", [item("commitment", { n: 9 })]);
    const hit = log.resolve("m1", "👍");
    assert.equal(hit?.item.n, 9);
    assert.equal(hit?.action, "done");
  });

  // PRECEDENCE: a Brief in the log wins over legacy EMOJI_MAP semantics. ❤️ on a
  // tracked Brief confirms the top item; a miss lets the caller fall through to
  // the legacy dispatchReaction (mark-vip) unchanged.
  it("precedence: ❤️ on a tracked Brief confirms the top item", () => {
    const log = new ReactableLog();
    log.remember("brief1", [item("draft", { n: 1 })]);
    const hit = log.resolve("brief1", "❤️");
    assert.equal(hit?.action, "send"); // brief semantics, not legacy mark-vip
  });
  it("precedence: ❤️ on an untracked message misses so legacy path runs", () => {
    const log = new ReactableLog();
    log.remember("brief1", [item("draft")]);
    assert.equal(log.resolve("some-contact-reply", "❤️"), null);
  });
});

describe("strikeBriefLines", () => {
  const brief = ["☀️ Your day · Sun 3:04", "needs you (2)", " 1 ⏳ draft for Raju", " 2 📌 send the deck", "fyi: 3 new"].join("\n");
  it("strikes only the resolved numbered lines", () => {
    const out = strikeBriefLines(brief, new Set([1]));
    assert.match(out, /~1 ⏳ draft for Raju~/);
    assert.ok(!out.includes("~2 📌"));
    assert.ok(out.includes("☀️ Your day")); // header untouched
    assert.ok(out.includes("fyi: 3 new")); // fyi untouched (no leading digit)
  });
  it("no-ops when nothing is resolved", () => {
    assert.equal(strikeBriefLines(brief, new Set()), brief);
  });
  it("does not double-strike an already-struck line", () => {
    const once = strikeBriefLines(brief, new Set([1]));
    const twice = strikeBriefLines(once, new Set([1]));
    assert.equal(twice, once);
  });
});
