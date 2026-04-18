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
import { WhatsAppSession } from "./session.js";
import { isValidJid, isValidGroupJid, timingSafeEqual } from "./validation.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3100", 10);
const BIND = process.env.LANTERN_BRIDGE_BIND || "127.0.0.1";
const BRIDGE_TOKEN = process.env.LANTERN_BRIDGE_TOKEN || "";
const CORS_ORIGIN = process.env.LANTERN_BRIDGE_ORIGIN || "*";

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
    agentEnabled: !!process.env.LANTERN_API_TOKEN,
    authRequired: !!BRIDGE_TOKEN,
    bind: BIND,
    port: PORT,
  },
  process.env.LANTERN_API_TOKEN
    ? "Agent auto-reply enabled"
    : "Agent auto-reply disabled (set LANTERN_API_TOKEN to enable)"
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
  res.json({ status: "ok", authRequired: !!BRIDGE_TOKEN });
});

// All /session/* routes require auth when a token is configured.
app.use("/session", requireToken);

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

// POST /session/:tenantId/start -- start a new session (triggers QR generation)
app.post("/session/:tenantId/start", async (req, res) => {
  const { tenantId } = req.params;

  const existing = sessions.get(tenantId);
  if (existing) {
    await existing.disconnect();
    sessions.delete(tenantId);
  }

  const session = new WhatsAppSession(tenantId, logger);
  sessions.set(tenantId, session);

  session.start();

  res.json({ status: "starting", message: "QR code will be sent via WebSocket" });
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

    const currentQR = session.getCurrentQR();
    if (currentQR) {
      ws.send(JSON.stringify({ type: "qr", data: currentQR }));
    }

    if (session.isConnected()) {
      ws.send(
        JSON.stringify({
          type: "connected",
          data: {
            phoneNumber: session.getPhoneNumber(),
            name: session.getName(),
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
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, BIND, () => {
  logger.info({ bind: BIND, port: PORT }, "WhatsApp bridge service started");
});

// Graceful shutdown: close Baileys sockets before exit so WhatsApp sees a
// clean disconnect and the next reconnect doesn't race a half-open socket.
function shutdown(signal: string) {
  logger.info({ signal }, "shutting down bridge");
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
