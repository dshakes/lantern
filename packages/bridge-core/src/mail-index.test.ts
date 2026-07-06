import { test } from "node:test";
import assert from "node:assert";
import { buildMailQuery, rowToHit, formatMailHits, MAIL_SEARCH_MAX_LIMIT } from "./mail-index.ts";

test("buildMailQuery ANDs words across subject+sender and parameterizes everything", () => {
  const { sql, args } = buildMailQuery({ query: "united receipt" });
  assert.ok(sql.includes("m.deleted = 0"));
  // Two words → two (subject OR address OR comment) clauses.
  assert.strictEqual(sql.match(/s\.subject LIKE \?/g)?.length, 2);
  assert.deepStrictEqual(args.slice(0, 3), ["%united%", "%united%", "%united%"]);
  assert.strictEqual(args[args.length - 1], 25); // default limit
  // No raw user text spliced into SQL.
  assert.ok(!sql.includes("united"));
});

test("buildMailQuery date range and limit clamping", () => {
  const { sql, args } = buildMailQuery({ query: "uscis", since: "2021-01-01", until: "2021-12-31", limit: 5000 });
  assert.ok(sql.includes("m.date_received >= ?"));
  assert.ok(sql.includes("m.date_received < ?"));
  const since = Math.floor(Date.parse("2021-01-01") / 1000);
  const until = Math.floor(Date.parse("2021-12-31") / 1000) + 86400; // inclusive end
  assert.ok(args.includes(since) && args.includes(until));
  assert.strictEqual(args[args.length - 1], MAIL_SEARCH_MAX_LIMIT);
});

test("buildMailQuery rejects empty query", () => {
  assert.throws(() => buildMailQuery({ query: "   " }), /empty query/);
});

test("rowToHit formats date and display name", () => {
  const hit = rowToHit({ ts: Date.parse("2024-03-27T12:00:00Z") / 1000, comment: "United Airlines", address: "receipts@united.com", subject: "eTicket" });
  assert.deepStrictEqual(hit, { date: "2024-03-27", from: "United Airlines <receipts@united.com>", subject: "eTicket" });
  // No display name → bare address, no angle brackets.
  assert.strictEqual(rowToHit({ ts: 0, comment: "", address: "a@b.c", subject: "x" }).from, "a@b.c");
});

test("formatMailHits", () => {
  assert.strictEqual(formatMailHits([]), "No matching emails in the local mail index.");
  const line = formatMailHits([{ date: "2024-03-27", from: "a@b.c", subject: "Trip" }]);
  assert.strictEqual(line, "2024-03-27 · a@b.c · Trip");
});
