import { test } from "node:test";
import assert from "node:assert";
import { buildMailQuery, rowToHit, formatMailHits, parseEmlx, decodeEntities, MAIL_SEARCH_MAX_LIMIT } from "./mail-index.ts";

test("buildMailQuery ANDs words across subject+sender and parameterizes everything", () => {
  const { sql, args } = buildMailQuery({ query: "united receipt" });
  assert.ok(sql.includes("m.deleted = 0"));
  // Every hit carries its ROWID so the model can chain search → read_email.
  assert.ok(sql.includes("m.ROWID AS rowid"));
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

test("rowToHit formats date and display name and carries rowid", () => {
  const hit = rowToHit({ rowid: 4242, ts: Date.parse("2024-03-27T12:00:00Z") / 1000, comment: "United Airlines", address: "receipts@united.com", subject: "eTicket" });
  assert.deepStrictEqual(hit, { rowid: 4242, date: "2024-03-27", from: "United Airlines <receipts@united.com>", subject: "eTicket" });
  // No display name → bare address, no angle brackets.
  assert.strictEqual(rowToHit({ rowid: 1, ts: 0, comment: "", address: "a@b.c", subject: "x" }).from, "a@b.c");
});

test("formatMailHits surfaces the rowid so the model can chain read_email", () => {
  assert.strictEqual(formatMailHits([]), "No matching emails in the local mail index.");
  const line = formatMailHits([{ rowid: 99, date: "2024-03-27", from: "a@b.c", subject: "Trip" }]);
  assert.strictEqual(line, "[#99] 2024-03-27 · a@b.c · Trip");
});

test("parseEmlx extracts the text/plain body from a multipart .emlx and strips headers", () => {
  const rfc = [
    "From: Dr Smith <office@clinic.com>",
    "Subject: Your appointment confirmation",
    'Content-Type: multipart/alternative; boundary="BOUND1"',
    "",
    "--BOUND1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your appointment is at 8:30 am on Monday.",
    "--BOUND1",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<html><body>ignore me</body></html>",
    "--BOUND1--",
  ].join("\r\n");
  const raw = `${Buffer.byteLength(rfc)}\n${rfc}\n<?xml version="1.0"?><plist></plist>`;
  const parsed = parseEmlx(raw);
  assert.strictEqual(parsed.from, "Dr Smith <office@clinic.com>");
  assert.strictEqual(parsed.subject, "Your appointment confirmation");
  assert.ok(parsed.text.includes("appointment is at 8:30 am"));
  // Headers + trailing plist + html part are gone.
  assert.ok(!parsed.text.includes("Content-Type"));
  assert.ok(!parsed.text.includes("plist"));
  assert.ok(!parsed.text.includes("ignore me"));
});

test("parseEmlx decodes a quoted-printable body", () => {
  const rfc = [
    "From: shop@store.com",
    "Subject: Receipt",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Total =E2=82=AC5 due =\r\ntoday",
  ].join("\r\n");
  const parsed = parseEmlx(`${Buffer.byteLength(rfc)}\n${rfc}`);
  // =E2=82=AC is UTF-8 euro; the soft line-break (=\r\n) joins the words.
  assert.ok(parsed.text.includes("Total €5 due today"), parsed.text);
});

test("decodeEntities decodes numeric + named HTML entities (times survive)", () => {
  assert.equal(decodeEntities("appt 8&#58;30 am"), "appt 8:30 am");
  assert.equal(decodeEntities("We&#x27;ve set &amp; confirmed"), "We've set & confirmed");
});
