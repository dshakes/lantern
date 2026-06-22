// lantern-imessage-bridge — macOS-only service that bridges iMessage
// into the Lantern agent runtime.
//
// Exposes the same HTTP + WS surface as whatsapp-bridge so the
// dashboard can render both with shared components.
//
// Routes:
//   GET    /health                                — liveness
//   GET    /session/:tenantId/diagnostics         — state + permissions
//   POST   /session/:tenantId/start               — start the session
//   POST   /session/:tenantId/stop                — stop polling
//   GET    /session/:tenantId/bot                 — bot state
//   POST   /session/:tenantId/bot/mute            — disable auto-reply
//   POST   /session/:tenantId/bot/unmute          — enable
//   POST   /session/:tenantId/bot/pause           — pause one handle
//   POST   /session/:tenantId/bot/resume          — resume one handle
//   POST   /session/:tenantId/bot/resume-all      — clear all paused
//   POST   /session/:tenantId/bot/chat/monitor    — monitor a chat ROWID
//   POST   /session/:tenantId/bot/chat/unmonitor  — stop monitoring
//   GET    /session/:tenantId/chats               — list chats from chat.db
//   POST   /session/:tenantId/send                — send arbitrary message
//   POST   /session/:tenantId/send-self           — message your own handle (control-plane delivery)
//   GET    /ws?tenantId=…                        — live updates
//
// Auth: same shared-token pattern as WhatsApp bridge. Set
// LANTERN_IMESSAGE_BRIDGE_TOKEN; dashboard sends Authorization: Bearer.

// Load a local .env (gitignored) BEFORE anything reads process.env, so
// owner-only settings like LANTERN_IMESSAGE_OWNER_HANDLE survive every
// restart whether launched from a Terminal (make run-imessage-bridge)
// or launchd — without baking PII into the repo. Node 20.12+/21.7+
// native loader; no dependency. Looks next to the service dir first,
// then ~/.lantern/imessage.env as a fallback.
import { existsSync as _existsSync } from "node:fs";
import { join as _join, dirname as _dirname } from "node:path";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { homedir as _homedir } from "node:os";
{
  const _here = _dirname(_fileURLToPath(import.meta.url));
  const _candidates = [
    _join(_here, "..", ".env"),
    _join(process.cwd(), ".env"),
    _join(_homedir(), ".lantern", "imessage.env"),
  ];
  for (const _p of _candidates) {
    if (_existsSync(_p)) {
      try {
        process.loadEnvFile(_p);
      } catch {
        /* older node or malformed file — ignore, env stays as-is */
      }
    }
  }
}

import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { timingSafeEqual as nodeTimingSafeEqual } from "crypto";
import pino from "pino";
import { join } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

import { IMessageSession } from "./session.js";
import { initAuth } from "@lantern/bridge-core/auth";
import { buildLabel } from "@lantern/bridge-core/build-info";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = parseInt(process.env.LANTERN_IMESSAGE_BRIDGE_PORT || "3200", 10);
const BIND = process.env.LANTERN_IMESSAGE_BRIDGE_BIND || "127.0.0.1";
const BRIDGE_TOKEN = process.env.LANTERN_IMESSAGE_BRIDGE_TOKEN || "";
const CORS_ORIGIN = process.env.LANTERN_IMESSAGE_BRIDGE_ORIGIN || "http://localhost:3001";
const STATE_DIR = join(__dirname, "..", "bridge_state");

initAuth(logger);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// Sessions keyed by tenantId. The agent client is created PER-session
// inside IMessageSession now (it needs sessionsFile in the per-tenant
// state dir), so we don't instantiate a top-level one here.
const sessions = new Map<string, IMessageSession>();

function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return nodeTimingSafeEqual(ba, bb);
}

function requireToken(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!BRIDGE_TOKEN) { next(); return; }
  const header = req.headers["authorization"] || "";
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!bearer || !timingSafeEqual(bearer, BRIDGE_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function getOrCreateSession(tenantId: string): IMessageSession {
  let s = sessions.get(tenantId);
  if (!s) {
    s = new IMessageSession(tenantId, STATE_DIR, logger);
    sessions.set(tenantId, s);
  }
  return s;
}

// ---- HTTP --------------------------------------------------------------

app.get("/health", (_, res) => {
  res.json({ status: "ok", authRequired: !!BRIDGE_TOKEN, version: "0.1.0", build: buildLabel(), platform: process.platform });
});

// Guard the macOS-only routes — if running on Linux/Windows the bridge
// is non-functional but the binary still boots so dev folks don't lose
// CI on non-Mac hosts.
function requireMac(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (process.platform !== "darwin") {
    res.status(501).json({ error: "iMessage bridge requires macOS", platform: process.platform });
    return;
  }
  next();
}

app.use("/session", requireToken, requireMac);

app.get("/session/:tenantId/diagnostics", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.json({ state: "idle" }); return; }
  res.json(s.diagnostics());
});

app.post("/session/:tenantId/start", async (req, res) => {
  const s = getOrCreateSession(req.params.tenantId);
  await s.start();
  res.json(s.diagnostics());
});

app.post("/session/:tenantId/stop", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (s) s.stop();
  sessions.delete(req.params.tenantId);
  res.json({ ok: true });
});

app.get("/session/:tenantId/bot", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  res.json(s.botState());
});

app.post("/session/:tenantId/bot/mute", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  s.mute(); res.json(s.botState());
});
app.post("/session/:tenantId/bot/unmute", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  s.unmute(); res.json(s.botState());
});
app.post("/session/:tenantId/bot/pause", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { handle } = req.body as { handle?: string };
  if (!handle) { res.status(400).json({ error: "handle required" }); return; }
  s.pauseContact(handle); res.json(s.botState());
});
app.post("/session/:tenantId/bot/resume", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { handle } = req.body as { handle?: string };
  if (!handle) { res.status(400).json({ error: "handle required" }); return; }
  s.resumeContact(handle); res.json(s.botState());
});
app.post("/session/:tenantId/bot/resume-all", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  s.clearAllPaused(); res.json(s.botState());
});
app.post("/session/:tenantId/bot/chat/monitor", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { rowid } = req.body as { rowid?: number };
  if (typeof rowid !== "number") { res.status(400).json({ error: "rowid required" }); return; }
  s.monitorChat(rowid); res.json(s.botState());
});
app.post("/session/:tenantId/bot/chat/unmonitor", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { rowid } = req.body as { rowid?: number };
  if (typeof rowid !== "number") { res.status(400).json({ error: "rowid required" }); return; }
  s.unmonitorChat(rowid); res.json(s.botState());
});

app.get("/session/:tenantId/chats", (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  res.json({ chats: s.listChats() });
});

app.post("/session/:tenantId/send", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s || !s.isReady()) { res.status(400).json({ error: "not ready" }); return; }
  const { to, message } = req.body as { to?: unknown; message?: unknown };
  if (typeof to !== "string" || !to) { res.status(400).json({ error: "'to' required" }); return; }
  if (typeof message !== "string" || !message || message.length > 4096) {
    res.status(400).json({ error: "'message' required, ≤4096 chars" });
    return;
  }
  const result = await s.send(to, message);
  if (!result.ok) { res.status(500).json({ error: result.reason }); return; }
  res.json({ status: "sent" });
});

// Mirrors whatsapp-bridge's send-self — sends to the user's own handle.
// On iMessage you can message yourself, so this is the same path as
// send() but the "to" is the bridge owner's primary handle. The
// control-plane uses this to deliver Morning Brief / inbox-concierge
// summaries. Owner handle is set via LANTERN_IMESSAGE_OWNER_HANDLE.
app.post("/session/:tenantId/send-self", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s || !s.isReady()) { res.status(400).json({ error: "not ready" }); return; }
  const ownerHandle = process.env.LANTERN_IMESSAGE_OWNER_HANDLE;
  if (!ownerHandle) {
    res.status(400).json({ error: "LANTERN_IMESSAGE_OWNER_HANDLE not configured on the bridge host" });
    return;
  }
  const { message } = req.body as { message?: unknown };
  if (typeof message !== "string" || !message || message.length > 4096) {
    res.status(400).json({ error: "'message' required, ≤4096 chars" });
    return;
  }
  const result = await s.send(ownerHandle, message);
  if (!result.ok) { res.status(500).json({ error: result.reason }); return; }
  res.json({ status: "sent", handle: ownerHandle });
});

// POST /session/:tenantId/calendar/upcoming -- device calendar (iCloud +
// Google + subscribed) from the macOS Calendar store. Backs the read_calendar
// agentic tool (control-plane bridge callback).
app.post("/session/:tenantId/calendar/upcoming", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { days, max, query, fromIso, toIso } = (req.body || {}) as { days?: number; max?: number; query?: string; fromIso?: string; toIso?: string };
  try {
    const events = await s.getUpcomingCalendar({ days, max, query, fromIso, toIso });
    res.json({ events, count: events.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /session/:tenantId/contacts/search -- AddressBook contact search.
// Backs the `search_contacts` agentic tool.
app.post("/session/:tenantId/contacts/search", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { query, limit } = (req.body || {}) as { query?: string; limit?: number };
  if (typeof query !== "string" || !query.trim()) { res.status(400).json({ error: "'query' required" }); return; }
  try {
    const contacts = await s.searchContacts(query.trim(), limit);
    res.json({ contacts, count: contacts.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---- Personal-docs HTTP surface ----------------------------------------
//
// Exposes the per-session PersonalDocs instance so the control-plane's
// LLM tools (`search_personal_files`, `read_personal_file`) can drive
// it. Path-restricted (LANTERN_PERSONAL_DOCS_ROOTS), audit-logged in the
// PersonalDocs class, and reachable only via loopback (bind=127.0.0.1)
// + bridge token (mounted under /session/* middleware). Replaces the
// old regex pre-deciders — the LLM now picks WHEN to search instead of
// the bridge guessing from query shape.

app.post("/session/:tenantId/personal-docs/search", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { query, limit } = req.body as { query?: unknown; limit?: unknown };
  if (typeof query !== "string" || query.trim().length === 0) {
    res.status(400).json({ error: "'query' required (non-empty string)" });
    return;
  }
  if (query.length > 500) { res.status(400).json({ error: "'query' must be ≤ 500 chars" }); return; }
  const cap = typeof limit === "number" && limit > 0 && limit <= 25 ? limit : 8;
  try {
    const hits = await s.getDocs().search(query);
    // Trim to the requested cap and only expose the small, LLM-useful
    // fields. Bytes/mtime/ext stay — they help the model decide which
    // file to read next.
    const results = hits.slice(0, cap).map((h) => ({
      path: h.path,
      displayPath: h.displayPath,
      name: h.name,
      ext: h.ext,
      bytes: h.bytes,
      modifiedAt: h.modifiedAt,
      snippet: h.snippet ?? "",
    }));
    res.json({ query, count: results.length, results });
  } catch (err) {
    logger.warn({ err, tenantId: req.params.tenantId }, "personal-docs/search failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/session/:tenantId/personal-docs/read", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { path } = req.body as { path?: unknown };
  if (typeof path !== "string" || path.trim().length === 0) {
    res.status(400).json({ error: "'path' required (non-empty string)" });
    return;
  }
  if (path.length > 2048) { res.status(400).json({ error: "'path' must be ≤ 2048 chars" }); return; }
  try {
    const out = await s.getDocs().read(path);
    if (!out.ok) {
      // PersonalDocs.read returns ok=false for: not-allowed, not-found,
      // is-a-directory, extraction-failed. Surface each as a 4xx vs 5xx.
      const status =
        out.reason === "path not in allowed roots" ? 403 :
        out.reason === "file not found" ? 404 :
        out.reason === "is a directory" ? 400 :
        422;
      res.status(status).json({ error: out.reason, path: out.path, displayPath: out.displayPath });
      return;
    }
    res.json({
      path: out.path,
      displayPath: out.displayPath,
      ext: out.ext,
      bytes: out.bytes,
      truncated: out.truncated,
      content: out.content,
    });
  } catch (err) {
    logger.warn({ err, tenantId: req.params.tenantId }, "personal-docs/read failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- iMessage history search ------------------------------------------
//
// Exposes chat.db keyword + date-range search so the control-plane's
// LLM tool `search_imessage_history` can answer cross-source questions
// like "what did the family group say during my Turkey trip?".
// Path-restricted (owner self-chat allowed roots already enforced via
// requireToken), bound to loopback, returns at most 50 messages per
// query to keep LLM context tight.

app.get("/session/:tenantId/imessage/groups", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  try {
    const groups = s.listGroups();
    res.json({ count: groups.length, groups });
  } catch (err) {
    logger.warn({ err, tenantId: req.params.tenantId }, "imessage/groups failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/session/:tenantId/imessage/group", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { chatRowid, name } = req.body as { chatRowid?: unknown; name?: unknown };
  try {
    const out = s.getGroupMembers({
      chatRowid: typeof chatRowid === "number" ? chatRowid : undefined,
      name: typeof name === "string" ? name : undefined,
    });
    if (!out) { res.status(404).json({ error: "group not found" }); return; }
    res.json(out);
  } catch (err) {
    logger.warn({ err, tenantId: req.params.tenantId }, "imessage/group failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/session/:tenantId/imessage/search", async (req, res) => {
  const s = sessions.get(req.params.tenantId);
  if (!s) { res.status(400).json({ error: "session not started" }); return; }
  const { keyword, sinceMs, untilMs, handle, groupOnly, limit } = req.body as {
    keyword?: unknown;
    sinceMs?: unknown;
    untilMs?: unknown;
    handle?: unknown;
    groupOnly?: unknown;
    limit?: unknown;
  };
  try {
    const hits = s.searchHistory({
      keyword: typeof keyword === "string" ? keyword : undefined,
      sinceMs: typeof sinceMs === "number" ? sinceMs : undefined,
      untilMs: typeof untilMs === "number" ? untilMs : undefined,
      handle: typeof handle === "string" ? handle : undefined,
      groupOnly: !!groupOnly,
      limit: typeof limit === "number" ? limit : undefined,
    });
    res.json({ count: hits.length, results: hits });
  } catch (err) {
    logger.warn({ err, tenantId: req.params.tenantId }, "imessage/search failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---- WebSocket ---------------------------------------------------------

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const tenantId = url.searchParams.get("tenantId") || "default";
  if (BRIDGE_TOKEN) {
    const auth = (req.headers.authorization || "") as string;
    const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const qs = url.searchParams.get("token") || "";
    const provided = bearer || qs;
    if (!provided || !timingSafeEqual(provided, BRIDGE_TOKEN)) {
      ws.close(4401, "unauthorized");
      return;
    }
  }
  const s = sessions.get(tenantId);
  if (!s) {
    try { ws.send(JSON.stringify({ type: "connection_state", data: { state: "idle", reason: "session not started" } })); } catch {}
    ws.close();
    return;
  }
  s.attachSocket(ws);
});

// ---- Boot --------------------------------------------------------------

// On macOS, auto-start the session for the default tenant so the
// bridge is immediately useful without manual /start POSTs. Set
// LANTERN_IMESSAGE_AUTOSTART=0 to disable (e.g. for a multi-tenant
// prod host that expects explicit /start per tenant).
const DEFAULT_TENANT =
  process.env.LANTERN_TENANT_ID ||
  process.env.LANTERN_DEFAULT_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001";
const AUTOSTART = (process.env.LANTERN_IMESSAGE_AUTOSTART ?? "1") !== "0";

server.listen(PORT, BIND, async () => {
  logger.info({ port: PORT, bind: BIND, build: buildLabel(), platform: process.platform }, "lantern-imessage-bridge listening");
  if (process.platform !== "darwin") {
    logger.warn("not running on macOS — /session/* routes will return 501");
    return;
  }
  if (AUTOSTART) {
    try {
      const s = getOrCreateSession(DEFAULT_TENANT);
      await s.start();
      const diag = s.diagnostics();
      logger.info({ tenant: DEFAULT_TENANT, state: diag.state, reason: diag.reason }, "default session auto-started");
    } catch (err) {
      logger.warn({ err }, "default session auto-start failed");
    }
  }
});

// Crash-safety: a stray rejected promise (e.g. a fire-and-forget handler
// that escaped its own try/catch) must NOT take the bridge down — log it
// and keep serving. Same for an uncaught exception that slips through.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection — keeping bridge alive");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — keeping bridge alive");
});

process.on("SIGINT", () => {
  logger.info("SIGINT — shutting down");
  sessions.forEach((s) => s.stop());
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  logger.info("SIGTERM — shutting down");
  sessions.forEach((s) => s.stop());
  server.close(() => process.exit(0));
});

// Suppress unused-import linter — authedFetch is part of the public
// auth surface used by AgentClient indirectly.
