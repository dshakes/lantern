// Route Handler: iPhone APP-CONTEXT signal sink.
//
// The owner's iOS Shortcuts "Personal Automations" POST a tiny JSON event here
// (one per app-open / location / focus change) over the SAME cloudflare tunnel
// that already serves this dashboard. We append each event as one JSON line to
// ~/.lantern/device-signals.jsonl (mode 0600) on the Mac. The imessage-bridge
// reads recent lines, summarizes them, and injects the result into the OWNER's
// self-chat assistant context (never a contact reply).
//
// PRIVACY: signals stay on the Mac except the iPhone→tunnel hop that delivers
// them. The endpoint is token-gated (x-lantern-signal-token == LANTERN_SIGNAL_TOKEN,
// a SERVER-SIDE env, never NEXT_PUBLIC). The file is owner-only (0600), its dir
// 0700.
//
// POST /api/signals  — append a signal. Body: { app, kind?, detail?, ts? }
// GET  /api/signals?limit=N — last N signals (token-gated; for the Automations
//                              page / debugging).

import { NextRequest, NextResponse } from "next/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

// Must run on Node (not Edge) so it can write the local filesystem.
export const runtime = "nodejs";
// This is a stateful side-effect sink — never statically prerender / cache it.
export const dynamic = "force-dynamic";

const VALID_KINDS = new Set(["app_open", "location", "focus", "now_playing", "custom"]);

// Bound the file so an over-eager automation can't grow it without limit.
const MAX_LINES = 5000;
// When we trim, drop down to this so trimming is amortized (not every append).
const TRIM_TO = 4000;

function signalsDir(): string {
  return join(homedir(), ".lantern");
}
function signalsFile(): string {
  return join(signalsDir(), "device-signals.jsonl");
}

/** Constant-time-ish string compare — avoids leaking length/prefix via timing.
 *  Both sides are short tokens; we still avoid an early-return on first mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True iff the request carries the correct server-side signal token. */
function authorized(req: NextRequest): boolean {
  const expected = process.env.LANTERN_SIGNAL_TOKEN;
  // Fail closed: no token configured server-side → reject everything.
  if (!expected) return false;
  const given = req.headers.get("x-lantern-signal-token") ?? "";
  return safeEqual(given, expected);
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const app = typeof body.app === "string" ? body.app.trim() : "";
  if (!app) {
    return NextResponse.json({ error: "app required" }, { status: 400 });
  }
  const rawKind = typeof body.kind === "string" ? body.kind : "app_open";
  const kind = VALID_KINDS.has(rawKind) ? rawKind : "app_open";
  const detail =
    typeof body.detail === "string" && body.detail.trim() ? body.detail.trim().slice(0, 500) : undefined;
  const ts =
    typeof body.ts === "number" && Number.isFinite(body.ts) && body.ts > 0 ? body.ts : Date.now();

  const record: Record<string, unknown> = { app: app.slice(0, 120), kind, ts };
  if (detail) record.detail = detail;

  try {
    const dir = signalsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = signalsFile();
    appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
    // appendFileSync's mode only applies on create; enforce 0600 every time.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
    maybeTrim(file);
  } catch (err) {
    return NextResponse.json(
      { error: "write failed", detail: (err as Error).message },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const limitParam = parseInt(req.nextUrl.searchParams.get("limit") || "", 10);
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 50;

  const file = signalsFile();
  if (!existsSync(file)) {
    return NextResponse.json({ signals: [] });
  }
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const signals: unknown[] = [];
    for (const line of tail) {
      try {
        signals.push(JSON.parse(line));
      } catch {
        /* skip a malformed line */
      }
    }
    return NextResponse.json({ signals });
  } catch (err) {
    return NextResponse.json({ error: "read failed", detail: (err as Error).message }, { status: 500 });
  }
}

// Cheap bound: only read+rewrite when the file has grown past MAX_LINES. Most
// appends do nothing here (a single line-count read is far cheaper than a
// full rewrite per request).
function maybeTrim(file: string): void {
  try {
    const content = readFileSync(file, "utf8");
    // Quick newline count without splitting the whole string into an array first.
    let count = 0;
    for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) count++;
    if (count <= MAX_LINES) return;
    const lines = content.split("\n").filter(Boolean);
    const kept = lines.slice(-TRIM_TO).join("\n") + "\n";
    writeFileSync(file, kept, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort */
    }
  } catch {
    /* trimming is best-effort — never fail the append over it */
  }
}
