import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWorldModelPrompt, parseWorldModel, applyWorldModel, formatWorldModelFyi, MANAGED_PUBLIC_HEADER } from "./world-model.js";

const today = "2026-09-17";
const evidence = [
  "2026-09-16 · Square <noreply@messaging.squareup.com> · Crispy Cones - Brambleton, VA—Your Daily Sales Summary Report for September 15, 2026",
  "2026-09-15 · me · PLUMBING & EQUIPMENT CONFIRMATION // Crispy Cones Brambleton",
  "Fri Sep 18 10:00 — Crispy Cones grand opening (Bram Quarter)",
].join("\n");

test("prompt carries the inputs and the source rule", () => {
  const p = buildWorldModelPrompt({ todayISO: today, ownerName: "Shekhar", mailLines: evidence.split("\n").slice(0, 2), calendarBlock: evidence.split("\n")[2], currentNow: ["opening day is the 10th | until: 2026-09-10"], currentPublic: ["grand opening September 10, 2026"] });
  assert.match(p, /Daily Sales Summary/);
  assert.match(p, /source.*MUST be an exact subject line or calendar title/);
  assert.match(p, /opening day is the 10th/);
});

test("parse keeps sourced, future-dated items and drops hallucinated, past, or unsourced ones", () => {
  const raw = `here you go {"now":[
    {"text":"Crispy Cones grand opening is Friday Sept 18 — opening day","until":"2026-09-18","source":"Crispy Cones grand opening (Bram Quarter)"},
    {"text":"flying to Vegas","until":"2026-09-20","source":"United itinerary LAS"},
    {"text":"store opened on the 10th","until":"2026-09-10","source":"Crispy Cones grand opening (Bram Quarter)"},
    {"text":"no source here","until":"2026-09-19","source":""}
  ],"public":[
    {"text":"Crispy Cones Brambleton grand opening Sept 18, 2026","until":"2026-09-18","source":"PLUMBING & EQUIPMENT CONFIRMATION // Crispy Cones Brambleton"},
    {"text":"immigration interview next week","until":"2026-09-25","source":"Crispy Cones grand opening (Bram Quarter)"}
  ]}`;
  const m = parseWorldModel(raw, today, evidence);
  assert.deepEqual(m.now.map((i) => i.text), ["Crispy Cones grand opening is Friday Sept 18 — opening day"]);
  // The prompt forbids private items; the parser cannot judge that, only
  // sourcing — so the sourced-but-private line survives parse and it is the
  // prompt + owner FYI that guard it. Pin the contract honestly.
  assert.equal(m.public.length, 2);
  assert.equal(parseWorldModel("no json", today, evidence).now.length, 0);
});

test("apply upserts Now, rebuilds the managed Public section, and is idempotent", () => {
  const md = ["## Public", "- grand opening September 10, 2026", "", "## Now", "- opening day is the 10th | until: 2026-09-10", ""].join("\n");
  const model = { now: [{ text: "Crispy Cones grand opening is Sept 18 — opening day", until: "2026-09-18", source: "x" }], public: [{ text: "Crispy Cones Brambleton grand opening Sept 18, 2026", until: "2026-09-18", source: "y" }] };
  const a = applyWorldModel(md, model, today);
  assert.equal(a.changes.length, 2);
  assert.match(a.md, /## Now\n- opening day is the 10th \| until: 2026-09-10\n- Crispy Cones grand opening is Sept 18 — opening day \| until: 2026-09-18/);
  assert.match(a.md, new RegExp(`${MANAGED_PUBLIC_HEADER.replace(/[()]/g, "\\$&")}\\n<!--[^\\n]*refreshed 2026-09-17[^\\n]*-->\\n- Crispy Cones Brambleton grand opening Sept 18, 2026 \\| until: 2026-09-18`));
  // Hand-written ## Public untouched.
  assert.match(a.md, /## Public\n- grand opening September 10, 2026/);
  const b = applyWorldModel(a.md, model, today);
  assert.equal(b.changes.length, 0);
  assert.equal(b.md, a.md);
  // A later refresh with a different public set replaces the managed section only.
  const c = applyWorldModel(a.md, { now: [], public: [{ text: "Store 2 lease signed", until: "2026-10-01", source: "z" }] }, "2026-09-19");
  assert.doesNotMatch(c.md, /Brambleton grand opening Sept 18, 2026 \| until/);
  assert.match(c.md, /Store 2 lease signed \| until: 2026-10-01/);
  assert.match(c.md, /## Public\n- grand opening September 10, 2026/);
});

test("owner FYI is short and invites a correction", () => {
  const s = formatWorldModelFyi(["now: a", "public: b"]);
  assert.match(s, /^🧭 updated what I know/);
  assert.match(s, /wrong\? tell me/);
});
