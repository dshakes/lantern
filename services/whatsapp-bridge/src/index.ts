// WhatsApp Web Bridge Service
//
// A local-first REST + WebSocket server that owns a Baileys socket and
// exposes a minimal control surface for the dashboard:
//
//   - /session/:tenantId/start | status | disconnect
//   - /session/:tenantId/bot/{mute,unmute,pause,resume,resume-all,group/...}
//   - /session/:tenantId/send
//   - GET /ws?tenantId=...   -- QR and message events
//
// Security posture (see docs/adr if you promote this to multi-user):
//   1. Binds to 127.0.0.1 by default. Override with LANTERN_BRIDGE_BIND.
//   2. Shared-token auth: if LANTERN_BRIDGE_TOKEN is set, every /session/*
//      request must present `Authorization: Bearer <token>` or a matching
//      `token=` query param on the WebSocket.
//   3. If bound to a non-loopback interface, a token is required at boot —
//      we refuse to start otherwise rather than quietly run open.
//   4. CORS: permissive by default for local dev; set LANTERN_BRIDGE_ORIGIN
//      to a comma-separated allowlist for tighter posture.
//
// JIDs are validated at the boundary — see validateJid. The rest of the
// service trusts the validated JID shape.

import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WhatsAppSession } from "./session.js";
import { isValidJid, isValidGroupJid, timingSafeEqual } from "./validation.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Initialize bridge → control-plane auth. Lazily logs in on first use
// (using LANTERN_BRIDGE_EMAIL / PASSWORD, defaults to admin@lantern.dev
// for dev). Survives JWT expiry + API restarts via auto-relogin on 401.
import { initAuth, authEnabled } from "@lantern/bridge-core/auth";
initAuth(logger);

// Resolve the bridge's package version once at boot so /diagnostics can
// report it. Failing the read is non-fatal — diagnostics is best-effort.
const SERVICE_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();
const SERVICE_STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3100", 10);
const BIND = process.env.LANTERN_BRIDGE_BIND || "127.0.0.1";
const BRIDGE_TOKEN = process.env.LANTERN_BRIDGE_TOKEN || "";
const CORS_ORIGIN = process.env.LANTERN_BRIDGE_ORIGIN || "*";

// Optional control-plane heartbeat. When both LANTERN_CONTROL_PLANE_URL
// and LANTERN_BRIDGE_HEARTBEAT_TOKEN are set, the bridge POSTs the current
// pairing state for every active session to the control-plane every 30s.
// This is what flips pairing-state from "lives only on the bridge box" to
// "queryable from anywhere" — important for prod where the dashboard is
// not on the same host as the bridge. In dev (no env vars) it is a no-op.
const CONTROL_PLANE_URL = (process.env.LANTERN_CONTROL_PLANE_URL || "").replace(
  /\/$/,
  ""
);
const HEARTBEAT_TOKEN = process.env.LANTERN_BRIDGE_HEARTBEAT_TOKEN || "";
const HEARTBEAT_INTERVAL_MS = 30_000;

const isLoopback = BIND === "127.0.0.1" || BIND === "::1" || BIND === "localhost";
if (!isLoopback && !BRIDGE_TOKEN) {
  logger.fatal(
    { bind: BIND },
    "refusing to start: bind is non-loopback but LANTERN_BRIDGE_TOKEN is not set"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN.split(",").map((s) => s.trim()),
    credentials: false,
  })
);
app.use(express.json({ limit: "1mb" }));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

logger.info(
  {
    agentEnabled: authEnabled(),
    authRequired: !!BRIDGE_TOKEN,
    bind: BIND,
    port: PORT,
  },
  authEnabled()
    ? "Agent auto-reply enabled (will log in to control-plane on first use)"
    : "Agent auto-reply disabled (set LANTERN_BRIDGE_EMAIL + LANTERN_BRIDGE_PASSWORD, or LANTERN_API_TOKEN)"
);

// sessions keyed by tenantId. One tenant = one Baileys socket.
const sessions = new Map<string, WhatsAppSession>();

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

// requireToken enforces shared-token auth on mutation endpoints. It is a
// no-op when LANTERN_BRIDGE_TOKEN is unset (explicitly allowed only on
// loopback binds; see the boot check above).
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (!BRIDGE_TOKEN) return next();
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && timingSafeEqual(bearer, BRIDGE_TOKEN)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// /health is unauthenticated so the dashboard can probe reachability before
// asking the user for a token.
app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    authRequired: !!BRIDGE_TOKEN,
    version: SERVICE_VERSION,
  });
});

// /diagnostics is also unauthenticated (read-only, no secrets in the body)
// so the dashboard's "Trouble pairing?" expander can render even when the
// bridge token check is failing. Per-session diagnostics are gated by
// auth via /session/:tenantId/diagnostics below.
app.get("/diagnostics", (_, res) => {
  res.json({
    version: SERVICE_VERSION,
    startedAt: SERVICE_STARTED_AT,
    uptimeMs: Date.now() - SERVICE_STARTED_AT,
    bind: BIND,
    port: PORT,
    authRequired: !!BRIDGE_TOKEN,
    controlPlaneHeartbeat: !!(CONTROL_PLANE_URL && HEARTBEAT_TOKEN),
    agentEnabled: authEnabled(),
    activeSessions: [...sessions.keys()],
  });
});

// All /session/* routes require auth when a token is configured.
app.use("/session", requireToken);

// GET /session/:tenantId/diagnostics -- per-session snapshot
app.get("/session/:tenantId/diagnostics", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.json({ state: "idle", paired: false, present: false });
    return;
  }
  res.json({ ...session.getDiagnostics(), present: true });
});

// GET /session/:tenantId/status -- check if a session exists and is connected
app.get("/session/:tenantId/status", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.json({ status: "disconnected", paired: false });
    return;
  }
  res.json({
    status: session.isConnected() ? "connected" : "connecting",
    paired: session.isPaired(),
    phoneNumber: session.getPhoneNumber(),
    name: session.getName(),
  });
});

// GET /session/:tenantId/has-creds -- does the on-disk auth dir hold
// usable WhatsApp credentials? Dashboard uses this to choose between
// "Reconnect" (creds exist → silent reconnect) and "Pair with QR"
// (no creds → fresh pairing flow). Cheap: a single stat() call.
app.get("/session/:tenantId/has-creds", (req, res) => {
  const { tenantId } = req.params;
  // Reject path-traversal — tenantId is always a UUID or short slug.
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    res.status(400).json({ error: "invalid tenantId" });
    return;
  }
  const credsFile = join(process.cwd(), "auth_sessions", tenantId, "creds.json");
  let hasCreds = false;
  let credsAgeMs: number | null = null;
  try {
    if (existsSync(credsFile)) {
      const stat = statSync(credsFile);
      if (stat.size >= 32) {
        hasCreds = true;
        credsAgeMs = Date.now() - stat.mtimeMs;
      }
    }
  } catch {}
  res.json({ hasCreds, credsAgeMs, sessionActive: sessions.has(tenantId) });
});

// POST /session/:tenantId/start -- start (or resume) a session.
//
// Idempotent: if a session is already active and connected, return
// the current status WITHOUT disconnecting. Tearing down a working
// connection only to recreate it triggers WhatsApp pre-key drift +
// makes the next outbound message lossy. Only when the session is
// dead/missing do we instantiate a new one.
//
// To force a re-pair (different number / wiped creds), use /reset.
app.post("/session/:tenantId/start", async (req, res) => {
  const { tenantId } = req.params;

  const existing = sessions.get(tenantId);
  if (existing) {
    const state = existing.getConnectionState();
    if (state === "connected" || state === "connecting" || state === "starting" || state === "reconnecting") {
      res.json({ status: state, message: "session already active", reused: true });
      return;
    }
    // Stale or errored session — replace it.
    await existing.disconnect().catch(() => {});
    sessions.delete(tenantId);
  }

  const session = new WhatsAppSession(tenantId, logger);
  sessions.set(tenantId, session);
  session.start();

  res.json({ status: "starting", message: "session starting — reuse creds if available, else QR via WebSocket", reused: false });
});

// POST /session/:tenantId/disconnect -- disconnect and remove session
app.post("/session/:tenantId/disconnect", async (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (session) {
    await session.disconnect();
    sessions.delete(req.params.tenantId);
  }
  res.json({ status: "disconnected" });
});

// POST /session/:tenantId/reset -- disconnect AND wipe the on-disk auth
// credentials so the next /start issues a fresh QR. Plain disconnect
// leaves credentials in place and Baileys silently reconnects to the
// previously-paired WhatsApp number, which the user noticed: "When I
// disconnect and connect, it auto-connects prev session". Use this when
// the user wants to pair a different WhatsApp account.
app.post("/session/:tenantId/reset", async (req, res) => {
  const tenantId = req.params.tenantId;
  let session = sessions.get(tenantId);
  if (!session) {
    // Build a transient session just so we can wipe the auth dir.
    session = new WhatsAppSession(tenantId, logger);
  }
  await session.reset();
  sessions.delete(tenantId);
  res.json({ status: "reset", message: "Auth credentials wiped. Call /start to issue a fresh QR." });
});

// POST /session/:tenantId/groups/refresh -- re-fetch metadata for every
// group the user is in. Triggers WhatsApp to send sender-key
// distribution messages, which unsticks 'failed to decrypt' loops on
// groups that were active before the bridge paired. Auto-runs on pair;
// this endpoint lets the dashboard re-trigger without a full re-pair.
app.post("/session/:tenantId/groups/refresh", async (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No active session for this tenant" });
    return;
  }
  const result = await session.refreshGroupSessions("manual");
  res.json(result);
});

// GET /session/:tenantId/groups -- list every group the bridge knows
// about with {jid, name, participants, monitored}. Powers the dashboard's
// "monitored groups" checkbox list. Sorted: monitored first, then
// alphabetical by name.
app.get("/session/:tenantId/groups", async (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No active session for this tenant" });
    return;
  }
  const groups = await session.listGroups();
  res.json({ groups });
});

// GET /session/:tenantId/bot -- current bot mute/pause state
app.get("/session/:tenantId/bot", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/mute -- global mute
app.post("/session/:tenantId/bot/mute", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  session.setMuted(true);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/unmute -- clear global mute
app.post("/session/:tenantId/bot/unmute", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  session.setMuted(false);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/pause -- pause a specific contact
app.post("/session/:tenantId/bot/pause", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid, ttlMs } = req.body as { jid?: unknown; ttlMs?: unknown };
  if (!isValidJid(jid)) {
    res.status(400).json({ error: "invalid jid" });
    return;
  }
  const ttl = typeof ttlMs === "number" && ttlMs > 0 && ttlMs < 365 * 24 * 3600_000
    ? ttlMs
    : undefined;
  session.pauseContact(jid, ttl);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/resume -- resume a specific contact
app.post("/session/:tenantId/bot/resume", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: unknown };
  if (!isValidJid(jid)) {
    res.status(400).json({ error: "invalid jid" });
    return;
  }
  session.resumeContact(jid);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/group/monitor -- opt a group in to the agent
app.post("/session/:tenantId/bot/group/monitor", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: unknown };
  if (!isValidGroupJid(jid)) {
    res.status(400).json({ error: "jid must be a group JID (ending in @g.us)" });
    return;
  }
  session.monitorGroup(jid);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/group/unmonitor -- remove a group from the agent
app.post("/session/:tenantId/bot/group/unmonitor", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: unknown };
  if (!isValidGroupJid(jid)) {
    res.status(400).json({ error: "jid must be a group JID (ending in @g.us)" });
    return;
  }
  session.unmonitorGroup(jid);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/resume-all -- clear all per-contact pauses
app.post("/session/:tenantId/bot/resume-all", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const cleared = session.resumeAll();
  res.json({ ...session.getBotState(), cleared });
});

// POST /session/:tenantId/send -- send a message
app.post("/session/:tenantId/send", async (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session || !session.isConnected()) {
    res.status(400).json({ error: "Not connected" });
    return;
  }

  const { to, message } = req.body as { to?: unknown; message?: unknown };
  if (!isValidJid(to)) {
    res.status(400).json({ error: "invalid 'to' jid" });
    return;
  }
  if (typeof message !== "string" || message.length === 0 || message.length > 4096) {
    res.status(400).json({ error: "'message' must be a non-empty string (<=4096 chars)" });
    return;
  }

  try {
    await session.sendMessage(to, message);
    res.json({ status: "sent" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Send a message to the bridge owner's own WhatsApp self-chat. Used
// by the control-plane to deliver agent output (Morning Brief,
// inbox-concierge summary, etc.) directly to the user's phone without
// the control-plane needing to know the owner JID.
app.post("/session/:tenantId/send-self", async (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session || !session.isConnected()) {
    res.status(400).json({ error: "Not connected" });
    return;
  }
  const { message } = req.body as { message?: unknown };
  if (typeof message !== "string" || message.length === 0 || message.length > 4096) {
    res.status(400).json({ error: "'message' must be a non-empty string (<=4096 chars)" });
    return;
  }
  try {
    const ownJid = await session.sendSelf(message);
    res.json({ status: "sent", jid: ownJid });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const tenantId = url.searchParams.get("tenantId") || "default";

  // Token auth also applies to WS. `authorization` header doesn't cross the
  // WS upgrade reliably in browsers, so we also accept ?token= on the URL.
  if (BRIDGE_TOKEN) {
    const header = (req.headers.authorization || "") as string;
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    const qs = url.searchParams.get("token") || "";
    const provided = bearer || qs;
    if (!provided || !timingSafeEqual(provided, BRIDGE_TOKEN)) {
      logger.warn({ tenantId }, "WebSocket unauthorized");
      ws.close(4401, "unauthorized");
      return;
    }
  }

  logger.info({ tenantId }, "WebSocket client connected");

  const session = sessions.get(tenantId);
  if (session) {
    session.addListener(ws);

    // Replay enough state that a freshly-attached dashboard tab can render
    // the right view without a round-trip:
    //   1. connection_state — drives the stepper UI
    //   2. qr — if a pairing QR is currently live
    //   3. connected — if we're already paired
    ws.send(
      JSON.stringify({
        type: "connection_state",
        data: {
          state: session.getConnectionState(),
          since: Date.now(),
          attempt: 0,
          reason: null,
        },
      })
    );

    const currentQR = session.getCurrentQR();
    const qrIssuedAt = session.getQRIssuedAt();
    if (currentQR) {
      ws.send(
        JSON.stringify({
          type: "qr",
          data: currentQR,
          issuedAt: qrIssuedAt,
          expiresInMs: 20_000,
        })
      );
    }

    if (session.isConnected()) {
      ws.send(
        JSON.stringify({
          type: "connected",
          data: {
            phoneNumber: session.getPhoneNumber(),
            name: session.getName(),
            connectedAt: Date.now(),
          },
        })
      );
    }
  }

  ws.on("close", () => {
    session?.removeListener(ws);
    logger.info({ tenantId }, "WebSocket client disconnected");
  });
});

// ---------------------------------------------------------------------------
// Control-plane heartbeat (optional)
// ---------------------------------------------------------------------------

// Push pairing state for every active session up to the control-plane on a
// fixed cadence. Best-effort: failures are logged at debug level and never
// disturb the bridge's own lifecycle. The control-plane is the system of
// record for "is tenant X paired right now" in multi-host deployments.
async function sendHeartbeat() {
  if (!CONTROL_PLANE_URL || !HEARTBEAT_TOKEN) return;
  const payload = {
    bridgeVersion: SERVICE_VERSION,
    timestamp: Date.now(),
    sessions: [...sessions.entries()].map(([tenantId, session]) => {
      const d = session.getDiagnostics();
      return {
        tenantId,
        state: d.state,
        paired: d.paired,
        connected: d.connected,
        phoneNumber: d.phoneNumber,
        displayName: d.displayName,
        lastConnectionEventAt: d.lastConnectionEventAt,
        lastError: d.lastError,
      };
    }),
  };
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/v1/surfaces/whatsapp/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HEARTBEAT_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.debug({ status: res.status }, "heartbeat rejected by control-plane");
    }
  } catch (err) {
    logger.debug({ err }, "heartbeat failed");
  }
}

let heartbeatTimer: NodeJS.Timeout | null = null;
if (CONTROL_PLANE_URL && HEARTBEAT_TOKEN) {
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
  logger.info(
    { url: CONTROL_PLANE_URL, intervalMs: HEARTBEAT_INTERVAL_MS },
    "control-plane heartbeat enabled"
  );
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Scan auth_sessions/ for tenants with persisted creds and auto-start
// their sessions. Baileys reconnects silently using the on-disk creds —
// no QR needed. This means the dashboard sees `connected` from the
// first request, instead of `idle` + a "Pair with QR" CTA. Lets the
// bridge survive code restarts as a true daemon.
//
// A tenant directory counts as "has creds" when it contains a
// non-empty creds.json file (the canonical Baileys auth file).
function autoResumeSessions(): void {
  const authBase = join(process.cwd(), "auth_sessions");
  if (!existsSync(authBase)) {
    logger.info({ authBase }, "no auth_sessions dir yet — skipping auto-resume");
    return;
  }
  let resumed = 0;
  let skipped = 0;
  for (const entry of readdirSync(authBase, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const tenantId = entry.name;
    const credsFile = join(authBase, tenantId, "creds.json");
    if (!existsSync(credsFile)) { skipped++; continue; }
    try {
      const stat = statSync(credsFile);
      if (stat.size < 32) { skipped++; continue; } // creds.json is always 200+ bytes
    } catch { skipped++; continue; }
    if (sessions.has(tenantId)) continue; // already started somehow
    try {
      const session = new WhatsAppSession(tenantId, logger);
      sessions.set(tenantId, session);
      session.start();
      resumed++;
      logger.info({ tenantId }, "auto-resumed WhatsApp session from disk");
    } catch (err) {
      logger.warn({ err, tenantId }, "auto-resume failed for tenant");
    }
  }
  logger.info({ resumed, skipped, total: resumed + skipped }, "auto-resume scan done");
}

server.listen(PORT, BIND, () => {
  logger.info({ bind: BIND, port: PORT }, "WhatsApp bridge service started");
  // Auto-resume runs AFTER listen so the bridge accepts requests
  // immediately. Sessions reconnect in the background; their state
  // flows out via the existing WebSocket broadcast.
  autoResumeSessions();
});

// ---------------------------------------------------------------------------
// Graceful shutdown — CRITICAL for Signal session integrity.
//
// Baileys persists the Signal/Noise session keys to auth_sessions/ on
// each creds.update. If the process is SIGKILL'd mid-write (e.g.
// `launchctl kickstart -k`), the on-disk keys can be left partial or
// stale → the next boot loads desynced keys → "Bad MAC" decrypt
// failures → WhatsApp shows "Waiting for this message" placeholders that
// never clear. A clean shutdown calls session.disconnect(), which does
// socket.end() and lets Baileys flush its final creds write before exit.
//
// ALWAYS restart this bridge with SIGTERM (the default `kill`, or
// `launchctl bootout`), NEVER `kickstart -k` (SIGKILL), so this runs.
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, sessions: sessions.size }, "graceful shutdown — flushing Signal sessions");
  const deadline = setTimeout(() => {
    logger.warn("graceful shutdown timed out — forcing exit");
    process.exit(0);
  }, 8000);
  try {
    await Promise.all(
      [...sessions.values()].map((s) =>
        s.disconnect().catch((err) => logger.warn({ err }, "session disconnect failed")),
      ),
    );
  } finally {
    clearTimeout(deadline);
    logger.info("graceful shutdown complete");
    process.exit(0);
  }
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

// Graceful shutdown: close Baileys sockets before exit so WhatsApp sees a
// clean disconnect and the next reconnect doesn't race a half-open socket.
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down bridge");
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const closes = [...sessions.values()].map((s) => s.disconnect().catch(() => {}));
  Promise.all(closes).finally(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Re-export validators for tests that want to import through index.
export { isValidJid, isValidGroupJid, timingSafeEqual } from "./validation.js";
