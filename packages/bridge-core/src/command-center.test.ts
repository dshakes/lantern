// Tests for the owner chat command-center: the unified numbered-action grammar,
// command recognition, and the Brief/plate/drill-down composers.
//   cd packages/bridge-core && npx tsx --test src/command-center.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseActionReply,
  parseCenterCommand,
  buildBrief,
  buildPlate,
  buildAgents,
  buildDomain,
  buildDid,
  buildNews,
  buildNewsDigest,
  buildReadlist,
  selectTopDrops,
  buildTopDropPush,
  type BriefItem,
} from "./command-center.ts";
import type { Commitment } from "./commitments-edge.ts";

const ITEMS: BriefItem[] = [
  { n: 1, ref: "draft", id: "d1", icon: "📨", label: "draft to Boss", defaultAction: "review", actions: ["send", "edit", "skip"] },
  { n: 2, ref: "commitment", id: "c1", icon: "💳", label: "Netflix +$3", defaultAction: "done", actions: ["done", "snooze", "skip"] },
];

// ── unified action grammar ───────────────────────────────────────────────────
test("bare number → the item's default action", () => {
  assert.deepEqual(parseActionReply("1", ITEMS), { item: ITEMS[0], action: "review" });
  assert.deepEqual(parseActionReply("2", ITEMS), { item: ITEMS[1], action: "done" });
});

test("'<n> send' confirms a draft, '<n> yes' on a commitment means done", () => {
  assert.equal(parseActionReply("1 send", ITEMS)!.action, "send");
  assert.equal(parseActionReply("1 yes", ITEMS)!.action, "send"); // draft → send
  assert.equal(parseActionReply("2 yes", ITEMS)!.action, "done"); // commitment → done
});

test("skip / snooze(+duration) / edit / review / undo / custom", () => {
  assert.equal(parseActionReply("2 skip", ITEMS)!.action, "skip");
  const sn = parseActionReply("2 snooze 2h", ITEMS)!;
  assert.equal(sn.action, "snooze");
  assert.equal(sn.arg, "2h");
  const ed = parseActionReply("1 edit make it warmer", ITEMS)!;
  assert.equal(ed.action, "edit");
  assert.equal(ed.arg, "make it warmer");
  assert.equal(parseActionReply("1 review", ITEMS)!.action, "review");
  // free text after the number = the owner's own version
  const cu = parseActionReply("1 actually tell him I'll call tonight", ITEMS)!;
  assert.equal(cu.action, "custom");
  assert.match(cu.arg!, /call tonight/);
});

test("non-action replies return null (fall through to chat)", () => {
  assert.equal(parseActionReply("how's it going", ITEMS), null);
  assert.equal(parseActionReply("9", ITEMS), null); // out of range
  assert.equal(parseActionReply("", ITEMS), null);
  assert.equal(parseActionReply("1 send", []), null); // no items shown
});

// ── command recognition ──────────────────────────────────────────────────────
test("center commands: brief / plate / agents / did / domains", () => {
  assert.equal(parseCenterCommand("?"), "brief");
  assert.equal(parseCenterCommand("today"), "brief");
  assert.equal(parseCenterCommand("plate"), "plate");
  assert.equal(parseCenterCommand("agents"), "agents");
  assert.equal(parseCenterCommand("did"), "did");
  assert.deepEqual(parseCenterCommand("health"), { domain: "health" });
  assert.deepEqual(parseCenterCommand("car"), { domain: "vehicle" }); // alias
  assert.deepEqual(parseCenterCommand("finance"), { domain: "money" }); // alias
  assert.deepEqual(parseCenterCommand("how's health"), { domain: "health" });
  assert.equal(parseCenterCommand("tell me a joke"), null);
});

test("news/radar command — case-insensitive (regression: 'News' fell through to the assistant)", () => {
  assert.deepEqual(parseCenterCommand("news"), { news: {} });
  assert.deepEqual(parseCenterCommand("News"), { news: {} }); // capital — the exact text that failed live
  assert.deepEqual(parseCenterCommand("NEWS"), { news: {} });
  assert.deepEqual(parseCenterCommand("radar"), { news: {} });
  assert.deepEqual(parseCenterCommand("News "), { news: {} }); // trailing space
  assert.deepEqual(parseCenterCommand("what's new"), { news: {} });
  assert.deepEqual(parseCenterCommand("latest"), { news: {} });
});

test("news time-windows + category (feature: 'news today/week/month', 'news labs')", () => {
  assert.deepEqual(parseCenterCommand("news today"), { news: { window: "today" } });
  assert.deepEqual(parseCenterCommand("news week"), { news: { window: "week" } });
  assert.deepEqual(parseCenterCommand("news this week"), { news: { window: "week" } });
  assert.deepEqual(parseCenterCommand("news month"), { news: { window: "month" } });
  assert.deepEqual(parseCenterCommand("radar today"), { news: { window: "today" } });
  assert.deepEqual(parseCenterCommand("news labs"), { news: { category: "labs" } });
  assert.deepEqual(parseCenterCommand("news coding-tools"), { news: { category: "coding-tools" } });
  // any non-window/non-category word → a source/company filter
  assert.deepEqual(parseCenterCommand("news openai"), { news: { source: "openai" } });
  assert.deepEqual(parseCenterCommand("news claude"), { news: { source: "claude" } });
  assert.deepEqual(parseCenterCommand("news google"), { news: { source: "google" } });
  assert.deepEqual(parseCenterCommand("news perplexity"), { news: { source: "perplexity" } });
});

test("buildNews shows the window + popularity label + numbered saveable items", () => {
  const items = [{ source: "Anthropic", category: "labs", title: "Claude 4.8", url: "https://x", score: 9 }];
  assert.match(buildNews(items, { window: "week" }).text, /this week · top by popularity/);
  assert.match(buildNews(items, {}).text, /📡 AI Radar · top \d/);
  assert.match(buildNews(items, { category: "labs" }).text, /\(labs\)/);
  assert.match(buildNews(items, { source: "openai" }).text, /\(openai\)/);
});

test("buildNews caps one dominant source when unfiltered, but not when filtered", () => {
  const flood = Array.from({ length: 10 }, (_, i) => ({ source: "OpenAI Blog", title: `o${i}`, url: `https://o/${i}`, score: 90 - i }));
  const others = [{ source: "Anthropic", title: "a", url: "https://a", score: 50 }];
  // unfiltered: OpenAI Blog capped at 3
  const mixed = buildNews([...flood, ...others], {});
  assert.equal(mixed.items.filter((it) => it.url?.startsWith("https://o/")).length, 3);
  // filtered to that source: show its top items (no per-source cap)
  const only = buildNews(flood, { source: "openai" });
  assert.ok(only.items.length > 3);
});

test("buildNewsDigest: top-8 cross-source, ≤2 per source, empty → quiet-day line", () => {
  assert.match(buildNewsDigest([], "today"), /quiet day/);
  const items = [
    ...Array.from({ length: 5 }, (_, i) => ({ source: "OpenAI Blog", title: `o${i}`, url: `https://o/${i}`, score: 90 - i })),
    { source: "Anthropic", title: "a", url: "https://a", score: 80 },
    { source: "HN", title: "h", url: "https://h", score: 70 },
    { source: "AWS", title: "w", url: "https://w", score: 60 },
  ];
  const out = buildNewsDigest(items, "today");
  assert.match(out, /📰 AI news · today/);
  // OpenAI capped at 2 in the digest
  assert.equal((out.match(/https:\/\/o\//g) ?? []).length, 2);
});

test("buildNews items are numbered + saveable", () => {
  const v = buildNews([{ source: "X", category: "labs", title: "T", url: "https://x", score: 5 }], {});
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].ref, "news_item");
  assert.equal(v.items[0].url, "https://x");
  assert.equal(v.items[0].defaultAction, "save");
});

test("save action ('<n> save' + 'save <n>' + bookmark) → save", () => {
  const news = buildNews([{ source: "X", category: "labs", title: "T", url: "https://x", score: 5 }], {}).items;
  assert.equal(parseActionReply("1 save", news)?.action, "save");
  assert.equal(parseActionReply("save 1", news)?.action, "save");
  assert.equal(parseActionReply("1 bookmark", news)?.action, "save");
  assert.equal(parseActionReply("1", news)?.action, "save"); // news default = save
});

test("readlist: command recognition + buildReadlist", () => {
  assert.equal(parseCenterCommand("readlist"), "readlist");
  assert.equal(parseCenterCommand("saved"), "readlist");
  assert.equal(parseCenterCommand("reading list"), "readlist");
  const v = buildReadlist([{ id: "c1", title: "Saved article", url: "https://a" }]);
  assert.equal(v.items.length, 1);
  assert.match(v.text, /Readlist · 1 saved/);
  assert.match(v.text, /https:\/\/a/);
});

// ── Brief composition ────────────────────────────────────────────────────────
function cmt(over: Partial<Commitment>): Commitment {
  return { id: "x", title: "t", status: "open", ...over } as Commitment;
}

test("buildBrief numbers drafts first then commitments by urgency, items match text", () => {
  const v = buildBrief({
    now: new Date(2026, 5, 28, 9, 5),
    agentActivity: ["25 emails triaged", "0 escalations"],
    drafts: [{ id: "d1", to: "Boss", preview: "sounds good" }],
    commitments: [cmt({ id: "c1", title: "pay water bill", urgency: "normal" }), cmt({ id: "c2", title: "call plumber", urgency: "now" })],
    fyi: [{ id: "e1", kind: "delivery", summary: "Amazon today" }],
  });
  // draft is item 1; "now"-urgency commitment outranks "normal" so it's item 2
  assert.equal(v.items[0].ref, "draft");
  assert.equal(v.items[0].n, 1);
  assert.equal(v.items[1].id, "c2"); // call plumber (now) before water bill (normal)
  assert.equal(v.items[2].id, "c1");
  assert.match(v.text, /agents \(24h\): 25 emails triaged · 0 escalations/);
  assert.match(v.text, /needs you \(3\)/);
  assert.match(v.text, /fyi: Amazon today/);
});

test("buildBrief shows an all-clear when nothing needs the owner", () => {
  const v = buildBrief({ now: new Date(2026, 5, 28, 20, 0), agentActivity: [], drafts: [], commitments: [], fyi: [] });
  assert.equal(v.items.length, 0);
  assert.match(v.text, /nothing — you're clear/);
});

// ── drill-downs ──────────────────────────────────────────────────────────────
test("buildPlate is numbered + actionable; buildDid offers undo per item", () => {
  const plate = buildPlate([cmt({ id: "c1", title: "file taxes" })], [{ id: "d1", to: "Mom", preview: "hi" }]);
  assert.equal(plate.items.length, 2);
  assert.match(plate.text, /on your plate \(2\)/);

  const did = buildDid([{ id: "a1", label: 'added "standup" to calendar', undoable: true }, { id: "a2", label: "logged delivery", undoable: false }]);
  assert.equal(did.items.length, 1); // only the undoable one is numbered
  assert.match(did.text, /1 undo/);
});

test("buildAgents flags failures; buildDomain summarizes records + obligations", () => {
  const a = buildAgents([
    { name: "inbox-triage", health: "idle", lastRunAgo: "2m ago", lastOutcome: "3 fyi", nextRun: "45m" },
    { name: "garage", health: "failed" },
  ]);
  assert.match(a, /1 healthy/);
  assert.match(a, /⚠️ 1 failed/);

  const d = buildDomain({ domain: "health", recordCount: 6, next: "dentist Jul 3", recent: ["lab result"], obligations: ["refill metformin"] });
  assert.match(d, /health — 6 records/);
  assert.match(d, /dentist Jul 3/);
  assert.match(d, /refill metformin/);
});

test("selectTopDrops: high-signal, deduped, capped", () => {
  const items = [
    { source: "HN", title: "Big model", url: "https://a", score: 740 },
    { source: "HN", title: "meh", url: "https://b", score: 10 },
    { source: "GH", title: "Hot repo", url: "https://c", score: 300 },
    { source: "X", title: "already seen", url: "https://d", score: 500 },
  ];
  const pushed = new Set(["https://d"]);
  const drops = selectTopDrops(items, pushed, { threshold: 100, max: 2 });
  assert.equal(drops.length, 2);
  assert.equal(drops[0].url, "https://a"); // highest score
  assert.equal(drops[1].url, "https://c");
  assert.ok(!drops.some((d) => d.url === "https://b")); // below threshold
  assert.ok(!drops.some((d) => d.url === "https://d")); // already pushed
  assert.match(buildTopDropPush(items[0]), /Top AI drop \(740\): Big model/);
});
