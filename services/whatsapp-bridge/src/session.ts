import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "baileys";
import { Boom } from "@hapi/boom";
import { WebSocket } from "ws";
import * as QRCode from "qrcode";
import { join } from "path";
import { mkdirSync } from "fs";
import type { Logger } from "pino";

export class WhatsAppSession {
  private tenantId: string;
  private logger: Logger;
  private socket: ReturnType<typeof makeWASocket> | null = null;
  private listeners: Set<WebSocket> = new Set();
  private currentQR: string | null = null;
  private connected = false;
  private paired = false;
  private phoneNumber: string | null = null;
  private displayName: string | null = null;
  private authDir: string;

  constructor(tenantId: string, logger: Logger) {
    this.tenantId = tenantId;
    this.logger = logger.child({ tenant: tenantId });
    this.authDir = join(process.cwd(), "auth_sessions", tenantId);
    mkdirSync(this.authDir, { recursive: true });
  }

  async start() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      this.socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, this.logger),
        },
        printQRInTerminal: true,
        logger: this.logger,
        browser: ["Lantern", "Desktop", "1.0.0"],
      });

      // QR code event
      this.socket.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // Convert QR string to data URL for the dashboard
          const qrDataUrl = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2,
            color: { dark: "#000000", light: "#ffffff" },
          });
          this.currentQR = qrDataUrl;
          this.broadcast({ type: "qr", data: qrDataUrl });
          this.logger.info("QR code generated -- scan with WhatsApp");
        }

        if (connection === "open") {
          this.connected = true;
          this.paired = true;
          this.currentQR = null;

          // Get user info
          const user = this.socket?.user;
          this.phoneNumber = user?.id?.split(":")[0] || null;
          this.displayName = user?.name || null;

          this.logger.info(
            { phone: this.phoneNumber, name: this.displayName },
            "WhatsApp connected"
          );
          this.broadcast({
            type: "connected",
            data: {
              phoneNumber: this.phoneNumber,
              name: this.displayName,
            },
          });
        }

        if (connection === "close") {
          this.connected = false;
          const statusCode = (lastDisconnect?.error as Boom)?.output
            ?.statusCode;
          const shouldReconnect =
            statusCode !== DisconnectReason.loggedOut;

          this.logger.info(
            { statusCode, shouldReconnect },
            "WhatsApp disconnected"
          );
          this.broadcast({ type: "disconnected", data: { statusCode } });

          if (shouldReconnect) {
            // Auto-reconnect
            setTimeout(() => this.start(), 3000);
          }
        }
      });

      // Save credentials on update
      this.socket.ev.on("creds.update", saveCreds);

      // Incoming messages
      this.socket.ev.on("messages.upsert", async (m) => {
        for (const msg of m.messages) {
          if (!msg.key.fromMe && m.type === "notify") {
            const from = msg.key.remoteJid || "";
            const text =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              "";

            if (text) {
              this.logger.info(
                { from, text: text.slice(0, 100) },
                "Incoming message"
              );
              this.broadcast({
                type: "message",
                data: {
                  from,
                  text,
                  timestamp: msg.messageTimestamp,
                  pushName: msg.pushName,
                },
              });

              // TODO: Forward to the Lantern surface-gateway for agent processing
            }
          }
        }
      });
    } catch (err) {
      this.logger.error({ err }, "Failed to start WhatsApp session");
      this.broadcast({ type: "error", data: { message: String(err) } });
    }
  }

  async sendMessage(to: string, text: string) {
    if (!this.socket || !this.connected) {
      throw new Error("Not connected");
    }
    // Ensure the JID format is correct
    const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
    await this.socket.sendMessage(jid, { text });
  }

  async disconnect() {
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connected = false;
    this.currentQR = null;
  }

  isConnected() {
    return this.connected;
  }
  isPaired() {
    return this.paired;
  }
  getPhoneNumber() {
    return this.phoneNumber;
  }
  getName() {
    return this.displayName;
  }
  getCurrentQR() {
    return this.currentQR;
  }

  addListener(ws: WebSocket) {
    this.listeners.add(ws);
  }
  removeListener(ws: WebSocket) {
    this.listeners.delete(ws);
  }

  private broadcast(event: { type: string; data: unknown }) {
    const msg = JSON.stringify(event);
    for (const ws of this.listeners) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}
