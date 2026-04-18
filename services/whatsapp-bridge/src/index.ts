// WhatsApp Web Bridge Service
// Uses baileys to connect to WhatsApp's Multi-Device protocol
// Exposes a REST + WebSocket API for the dashboard to:
// 1. Get the QR code for pairing
// 2. Send/receive messages through the paired account
// 3. Check connection status

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { WhatsAppSession } from "./session.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

logger.info(
  { agentEnabled: !!process.env.LANTERN_API_TOKEN },
  process.env.LANTERN_API_TOKEN
    ? "Agent auto-reply enabled"
    : "Agent auto-reply disabled (set LANTERN_API_TOKEN to enable)"
);

// Store active sessions by tenant
const sessions = new Map<string, WhatsAppSession>();

// REST endpoints
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
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

// POST /session/:tenantId/start -- start a new session (triggers QR generation)
app.post("/session/:tenantId/start", async (req, res) => {
  const { tenantId } = req.params;

  // Clean up existing session
  const existing = sessions.get(tenantId);
  if (existing) {
    await existing.disconnect();
    sessions.delete(tenantId);
  }

  const session = new WhatsAppSession(tenantId, logger);
  sessions.set(tenantId, session);

  // Start the session -- this triggers QR code generation
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
// body: { jid: string, ttlMs?: number }
app.post("/session/:tenantId/bot/pause", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid, ttlMs } = req.body as { jid?: string; ttlMs?: number };
  if (!jid) {
    res.status(400).json({ error: "Missing 'jid' field" });
    return;
  }
  session.pauseContact(jid, ttlMs);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/resume -- resume a specific contact
// body: { jid: string }
app.post("/session/:tenantId/bot/resume", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: string };
  if (!jid) {
    res.status(400).json({ error: "Missing 'jid' field" });
    return;
  }
  session.resumeContact(jid);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/group/monitor -- opt a group in to the agent
// body: { jid: string }
app.post("/session/:tenantId/bot/group/monitor", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: string };
  if (!jid || !jid.endsWith("@g.us")) {
    res.status(400).json({ error: "jid must be a group JID (ending in @g.us)" });
    return;
  }
  session.monitorGroup(jid);
  res.json(session.getBotState());
});

// POST /session/:tenantId/bot/group/unmonitor -- remove a group from the agent
// body: { jid: string }
app.post("/session/:tenantId/bot/group/unmonitor", (req, res) => {
  const session = sessions.get(req.params.tenantId);
  if (!session) {
    res.status(404).json({ error: "No session" });
    return;
  }
  const { jid } = req.body as { jid?: string };
  if (!jid) {
    res.status(400).json({ error: "Missing 'jid' field" });
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

  const { to, message } = req.body;
  if (!to || !message) {
    res.status(400).json({ error: "Missing 'to' and 'message' fields" });
    return;
  }

  try {
    await session.sendMessage(to, message);
    res.json({ status: "sent" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// WebSocket -- streams QR codes and incoming messages to the dashboard
wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost`);
  const tenantId = url.searchParams.get("tenantId") || "default";

  logger.info({ tenantId }, "WebSocket client connected");

  const session = sessions.get(tenantId);
  if (session) {
    // Register this WebSocket to receive events
    session.addListener(ws);

    // If we already have a QR, send it immediately
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

const PORT = parseInt(process.env.PORT || "3100");
server.listen(PORT, () => {
  logger.info({ port: PORT }, "WhatsApp bridge service started");
});
