// Tests for the event scout (pure parts).
//   cd packages/bridge-core && npx tsx --test src/event-scout.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  applyCuration,
  buildCurationPrompt,
  buildScoutPrompt,
  calendarSpecFor,
  chunkCategories,
  formatScoutPage,
  formatScoutPicks,
  friendlyTime,
  parseCuration,
  defaultScoutState,
  eventKey,
  formatCategories,
  formatScoutList,
  isPastEvent,
  parseBookReply,
  parseScoutCommand,
  parseScoutEvents,
} from "./event-scout.ts";

const NOW = new Date(2026, 6, 4, 9, 0, 0); // 2026-07-04 local

test("prompt includes every category, location, and the date window", () => {
  const st = defaultScoutState();
  st.categories.push("diwali melas");
  const p = buildScoutPrompt(st, NOW);
  for (const c of st.categories) assert.ok(p.includes(c), `missing category: ${c}`);
  assert.ok(p.includes(st.location));
  assert.ok(p.includes("2026-07-04"));
  assert.ok(p.includes("2026-09-02")); // +60 days
  assert.match(p, /NEVER invent/);
});

test("chunkCategories batches for per-call scans; prompt can scope to a batch", () => {
  const st = defaultScoutState(); // 8 default categories
  const batches = chunkCategories(st.categories);
  assert.equal(batches.length, 3); // 3+3+2
  assert.deepEqual(batches.flat(), st.categories);
  const p = buildScoutPrompt(st, NOW, batches[1]);
  for (const c of batches[1]) assert.ok(p.includes(c));
  // "kids & family events" is unique to batch 0 (unlike "fireworks",
  // which also appears in the fixed source-list prose).
  assert.ok(!p.includes(batches[0][1]), "batch prompt must not include other batches");
});

test("parseScoutEvents: tolerant of fences + prose, validates + sorts", () => {
  const raw = [
    "Here's what I found:",
    "```json",
    JSON.stringify({
      events: [
        { title: "Circus Vazquez", date: "2026-08-01", time: "19:00", venue: "Dulles Expo", cost: "$25" },
        { title: "July 4 Fireworks", date: "2026-07-04", venue: "Sully District Park", cost: "free" },
        { title: "bad date", date: "next friday" },
        { title: "", date: "2026-07-10" },
        { notAnEvent: true },
      ],
    }),
    "```",
  ].join("\n");
  const events = parseScoutEvents(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].title, "July 4 Fireworks"); // sorted by date
  assert.equal(events[1].time, "19:00");
});

test("parseScoutEvents: garbage in → empty out", () => {
  assert.deepEqual(parseScoutEvents("no json here"), []);
  assert.deepEqual(parseScoutEvents('{"events": "nope"}'), []);
  assert.deepEqual(parseScoutEvents(""), []);
});

test("eventKey is stable across formatting noise; isPastEvent works", () => {
  const a = { title: "Diwali  Mela!", date: "2026-10-17" };
  const b = { title: "diwali mela", date: "2026-10-17" };
  assert.equal(eventKey(a), eventKey(b));
  assert.equal(isPastEvent({ title: "x", date: "2026-07-03" }, NOW), true);
  assert.equal(isPastEvent({ title: "x", date: "2026-07-04" }, NOW), false);
});

test("scout command grammar", () => {
  assert.deepEqual(parseScoutCommand("scan events"), { action: "scan" });
  assert.deepEqual(parseScoutCommand("Events scan"), { action: "scan" });
  assert.deepEqual(parseScoutCommand("events categories"), { action: "list-categories" });
  assert.deepEqual(parseScoutCommand("events add diwali melas"), { action: "add-category", value: "diwali melas" });
  assert.deepEqual(parseScoutCommand("events drop circus"), { action: "remove-category", value: "circus" });
  assert.deepEqual(parseScoutCommand("event remove light shows"), { action: "remove-category", value: "light shows" });
  assert.deepEqual(parseScoutCommand("events location Ashburn, VA"), { action: "set-location", value: "Ashburn, VA" });
  // Never fire on normal chat.
  assert.equal(parseScoutCommand("any events this weekend?"), null);
  assert.equal(parseScoutCommand("scan events for me please"), null);
  assert.equal(parseScoutCommand("quiet 2h"), null);
});

test("book reply grammar", () => {
  assert.deepEqual(parseBookReply("book 1,3"), { all: false, nums: [1, 3] });
  assert.deepEqual(parseBookReply("Book 2 and 5"), { all: false, nums: [2, 5] });
  assert.deepEqual(parseBookReply("book all"), { all: true, nums: [] });
  assert.deepEqual(parseBookReply("book 1, 1, 2"), { all: false, nums: [1, 2] }); // deduped
  assert.equal(parseBookReply("book the tickets tomorrow"), null);
  assert.equal(parseBookReply("book"), null);
  assert.equal(parseBookReply("booked 3 flights"), null);
});

test("formatScoutList numbers events and uses the registered 🎪 prefix", () => {
  const st = defaultScoutState();
  const msg = formatScoutList(
    [
      { title: "Fireworks", date: "2026-07-04", venue: "Sully Park", cost: "free" },
      { title: "Circus", date: "2026-08-01", time: "19:00" },
    ],
    st,
  );
  assert.ok(msg.startsWith("🎪 "));
  assert.match(msg, /1\. Sat, Jul 4 — Fireworks\n    Sully Park · free/);
  assert.match(msg, /2\. Sat, Aug 1 7pm — Circus/);
  assert.match(msg, /book 1,3/);
  assert.ok(formatCategories(st).startsWith("🎟 "));
});

test("curation: parse + apply reorders picks first; picks message + pager number globally", () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    title: `Event ${i + 1}`,
    date: `2026-07-${String(10 + i).padStart(2, "0")}`,
  }));
  const st = defaultScoutState();
  assert.ok(buildCurationPrompt(events, st).includes("10. 2026-07-19 — Event 10"));

  const raw = 'here you go\n```json\n{"picks":[{"n":7,"why":"perfect for a 4yo"},{"n":2,"why":"free and close"},{"n":7,"why":"dup"},{"n":99,"why":"bad"}]}\n```';
  const picks = parseCuration(raw, events.length);
  assert.deepEqual(picks.map((p) => p.n), [7, 2]); // deduped, range-checked

  const { ordered, whys } = applyCuration(events, picks);
  assert.equal(ordered.length, 10);
  // Picks lead the list but are DATE-sorted (Event 2 = Jul 11 < Event 7 = Jul 16),
  // with why-lines still paired to the right event.
  assert.equal(ordered[0].title, "Event 2");
  assert.equal(ordered[1].title, "Event 7");
  assert.equal(whys[0], "free and close");
  assert.equal(whys[1], "perfect for a 4yo");
  assert.equal(ordered[2].title, "Event 1"); // rest date order

  const picksMsg = formatScoutPicks(ordered, whys, st);
  assert.ok(picksMsg.startsWith("🎪 Top 2 picks"));
  assert.match(picksMsg, /1\. .*Event 2[\s\S]*↳ free and close/);
  assert.match(picksMsg, /events more → all 10/);

  // Pager: next page after the 2 picks = items 3..8, numbered globally.
  const page = formatScoutPage(ordered, 2, st);
  assert.match(page, /Events 3-8 of 10/);
  assert.match(page, /^3\. /m);
  assert.match(page, /^8\. /m);
  assert.match(page, /next 2/); // 2 left after this page
  // Final page footer flips to "that's everything".
  assert.match(formatScoutPage(ordered, 8, st), /that's everything/);

  assert.deepEqual(parseCuration("no json", 5), []);
});

test("display: strict date order, 2-line layout, category as tag, friendly times", () => {
  const st = defaultScoutState();
  // Renderers keep input order (pending is date-sorted upstream by
  // parseScoutEvents / applyCuration) — feed them sorted, as prod does.
  const events = [
    { title: "Fireworks A", date: "2026-07-04", category: "fireworks", venue: "Franklin Park", city: "Purcellville", cost: "free" },
    { title: "Mystery Expo", date: "2026-07-10", cost: "unknown" },
    { title: "Garba Night", date: "2026-08-28", time: "20:00", category: "Indian community events (Telugu shows)", venue: "Dulles SportsPlex" },
  ];
  const msg = formatScoutList(events, st);
  // Strict date order with global numbering.
  assert.match(msg, /1\. Sat, Jul 4 — Fireworks A/);
  assert.match(msg, /2\. Fri, Jul 10 — Mystery Expo/);
  assert.match(msg, /3\. Fri, Aug 28 8pm — Garba Night/);
  // Detail line: venue · cost · short category tag (no "(Telugu…)" tail).
  assert.match(msg, /    Franklin Park, Purcellville · free · fireworks/);
  assert.match(msg, /    Dulles SportsPlex · Indian community events\n/);
  // "unknown" cost is dropped, not displayed.
  assert.ok(!msg.includes("unknown"));
  assert.equal(friendlyTime("19:00"), "7pm");
  assert.equal(friendlyTime("10:30"), "10:30am");
  assert.equal(friendlyTime("00:15"), "12:15am");
});

test("list-all / pagination command grammar", () => {
  assert.deepEqual(parseScoutCommand("events"), { action: "list-all" });
  assert.deepEqual(parseScoutCommand("events more"), { action: "list-all" });
  assert.deepEqual(parseScoutCommand("more events"), { action: "list-all" });
  assert.deepEqual(parseScoutCommand("events all"), { action: "list-all" });
  assert.equal(parseScoutCommand("more"), null); // bare "more" stays normal chat
});

test("calendarSpecFor: start/end, notes, and 1d+2h alarms", () => {
  const spec = calendarSpecFor({
    title: "Circus",
    date: "2026-08-01",
    time: "19:00",
    venue: "Dulles Expo",
    url: "https://example.com",
  });
  assert.equal(spec.start, "2026-08-01T19:00:00");
  assert.equal(spec.end, "2026-08-01T21:00:00");
  assert.deepEqual(spec.alarmsMinutesBefore, [1440, 120]);
  assert.match(spec.notes, /Dulles Expo/);
  assert.match(spec.notes, /example\.com/);
  // No time → 10:00 default.
  assert.equal(calendarSpecFor({ title: "x", date: "2026-07-10" }).start, "2026-07-10T10:00:00");
  // Late event → end clamped to same day.
  assert.equal(calendarSpecFor({ title: "x", date: "2026-07-10", time: "22:30" }).end, "2026-07-10T23:30:00");
});
