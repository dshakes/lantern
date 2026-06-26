#!/usr/bin/env node
// Anti-tell evaluation runner.
//
// Loads seeds.json, sends each one through the bridge's natural-reply
// path (via the control-plane /v1/completions proxy with the
// SAME persona prompt the bridges use), then runs each generated
// reply through scorer-prompt.txt with a second model and prints a
// pass/fail table.
//
// Usage:
//   node evals/anti-tell/run.mjs [--threshold 0.3] [--seeds path]
//
// Env:
//   LANTERN_API_URL  control-plane base (default http://localhost:8080)
//   LANTERN_TENANT   tenant id (default dev)
//   LANTERN_AGENT    agent name for generation (default whatsapp-assistant)
//   LANTERN_OWNER_NAME / LANTERN_OWNER_PROFILE — same as the bridges
//
// Exit codes:
//   0  all seeds at or below threshold
//   1  one or more seeds exceed threshold (regression)
//   2  runner error

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const ARGS = parseArgs(process.argv.slice(2));
const THRESHOLD = Number(ARGS.threshold ?? "0.3");
const SEED_PATH = ARGS.seeds ?? join(__dirname, "seeds.json");
const API_URL = process.env.LANTERN_API_URL || "http://localhost:8080";
const TENANT = process.env.LANTERN_TENANT || "00000000-0000-0000-0000-000000000001";
const AGENT_NAME = process.env.LANTERN_AGENT || "whatsapp-assistant";
const OWNER_NAME = (process.env.LANTERN_OWNER_NAME || "Ada").split(/\s+/)[0];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

async function login() {
  const r = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@lantern.dev", password: "lantern" }),
  });
  if (!r.ok) throw new Error(`login failed: ${r.status}`);
  const d = await r.json();
  return d.token;
}

async function generate(token, systemPrompt, userText) {
  // Use the same /v1/completions endpoint the bridges use.
  const r = await fetch(`${API_URL}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: "auto",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      max_tokens: 200,
    }),
  });
  if (!r.ok) throw new Error(`completion failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.content || d.message?.content || d.choices?.[0]?.message?.content || "";
}

async function score(token, scorerPrompt, payload) {
  const userMsg = JSON.stringify(payload, null, 2);
  const r = await fetch(`${API_URL}/v1/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: "auto",
      messages: [
        { role: "system", content: scorerPrompt },
        { role: "user", content: userMsg },
      ],
      max_tokens: 300,
    }),
  });
  if (!r.ok) throw new Error(`scorer failed: ${r.status}`);
  const d = await r.json();
  const raw = d.content || d.message?.content || d.choices?.[0]?.message?.content || "";
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { return { detectability: 1, topTells: ["scorer-returned-nonjson"], fix: cleaned.slice(0, 200) }; }
}

function buildPersonaPrompt(seed) {
  // Minimal persona — the goal of this eval is to test how well the
  // CURRENT shipping persona resists detection. So we replicate the
  // exact key chunks from natural.ts → agentPersonaPrompt without
  // taking a runtime dependency on the bridges.
  const c = seed.contact || {};
  const rel = c.relationship ? `Relationship to this contact: ${c.relationship}.` : "Relationship unknown.";
  const name = c.name ? `Contact name: ${c.name}.` : "Contact: unknown.";
  return [
    `You are texting AS ${OWNER_NAME} on WhatsApp/iMessage. Sound EXACTLY like a real human, never a chatbot.`,
    `${name} ${rel}`,
    "",
    "Hard rules:",
    "- Plain text only. No markdown, bullets, headers, em-dashes.",
    "- Default to one short line, under 15 words.",
    "- Use contractions.",
    "- Lowercase mostly. Skip greetings/signoffs unless contact opens with one.",
    "- Never customer-service phrasing ('Certainly!', 'I'd be happy to', 'Let me know if you need anything').",
    "- Never claim completed actions you didn't take ('I sent', 'I added', 'I told him').",
    "- Match contact's language. Telugu → reply in Telugu (Telangana dialect, SHORT verbs: vasta/cheptha/matladta — NOT vacchina tarvata/matladutanu).",
    "- NEVER use 'bava' with Srinivas/Arun/Raju/Sowmyadhar — they're addressed by name.",
    "- Wife is Sam. Never 'Mae' (that's just the contact-save alias).",
    "- Work hours Mon-Fri 9-5:30 ET. Never offer sync inside; reframe to evening/weekend.",
    "",
    "Reply now in plain text, in Ada's voice, no preface.",
  ].join("\n");
}

async function main() {
  const seeds = JSON.parse(readFileSync(SEED_PATH, "utf8"));
  const scorerPrompt = readFileSync(join(__dirname, "scorer-prompt.txt"), "utf8");
  const token = await login();

  console.log(`▶ Anti-tell eval — ${seeds.seeds.length} seeds, threshold=${THRESHOLD}`);
  console.log("");
  const results = [];

  for (const seed of seeds.seeds) {
    process.stdout.write(`  [${seed.id}] `);
    try {
      const persona = buildPersonaPrompt(seed);
      const reply = await generate(token, persona, seed.inbound);
      const verdict = await score(token, scorerPrompt, {
        INBOUND: seed.inbound,
        CONTACT: seed.contact,
        REPLY: reply,
        "EXPECTED TRAITS": seed.expectedTraits,
        "ANTI PATTERNS": seed.antiPatterns,
      });
      const d = Number(verdict.detectability) || 1;
      const pass = d <= THRESHOLD;
      const tag = pass ? "✓ PASS" : "✗ FAIL";
      console.log(`${tag}  d=${d.toFixed(2)}  reply="${reply.slice(0, 60).replace(/\n/g, " ")}"`);
      if (!pass) console.log(`           tells: ${(verdict.topTells || []).join(", ")}`);
      if (!pass && verdict.fix) console.log(`           fix:   ${verdict.fix}`);
      results.push({ id: seed.id, pass, d, reply, verdict });
    } catch (err) {
      console.log(`✗ ERROR  ${err.message}`);
      results.push({ id: seed.id, pass: false, d: 1, error: err.message });
    }
  }

  console.log("");
  const failed = results.filter((r) => !r.pass);
  const avgD = results.reduce((a, r) => a + (r.d || 0), 0) / results.length;
  console.log(`▶ ${results.length - failed.length}/${results.length} pass — avg detectability ${avgD.toFixed(2)}`);
  if (failed.length > 0) {
    console.log(`▶ ${failed.length} FAIL → exit 1`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("eval runner error:", err);
  process.exit(2);
});
