// Typed HTTP wrapper for the WhatsApp bridge's REST surface.
// Mirrors the endpoints registered in services/whatsapp-bridge/src/index.ts.
//
// Pure functions returning typed responses — no state, no side effects
// beyond the network call. Consumed by components/personal/bridge-context.tsx
// (which owns the WS) and by any one-off command (a script, the curl-
// bypass replacements in the UI).

import type {
  BotState,
  BridgeChannel,
  BridgeDiagnostics,
  GroupRow,
} from "@/lib/bridge-types";

// Per-channel bridge base URLs. These are NOT secret — just service addresses.
// Used only by bridgeWebSocketUrl() which must connect directly (WS cannot
// go through a Next.js Route Handler).
//
// All REST calls from the browser go through /api/bridge/<channel>/...
// where the server-side handler injects LANTERN_BRIDGE_TOKEN /
// LANTERN_IMESSAGE_BRIDGE_TOKEN (non-public server env vars). The token
// never reaches the browser bundle.
const BRIDGE_WS_URLS: Record<BridgeChannel, string> = {
  whatsapp:
    process.env.NEXT_PUBLIC_LANTERN_BRIDGE_URL || "http://localhost:3100",
  imessage:
    process.env.NEXT_PUBLIC_LANTERN_IMESSAGE_BRIDGE_URL || "http://localhost:3200",
};

// Same-origin prefix for all REST bridge calls (proxied server-side).
function proxyBase(channel: BridgeChannel): string {
  return `/api/bridge/${channel}`;
}

// Still exported so existing code that renders the URL for diagnostics can
// call it — but REST fetches no longer use this.
export function bridgeBaseUrl(channel: BridgeChannel = "whatsapp"): string {
  return BRIDGE_WS_URLS[channel].replace(/\/$/, "");
}

async function post<T>(channel: BridgeChannel, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${proxyBase(channel)}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new BridgeError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

async function get<T>(channel: BridgeChannel, path: string): Promise<T> {
  const res = await fetch(`${proxyBase(channel)}${path}`);
  if (!res.ok) throw new BridgeError(res.status, await res.text().catch(() => ""));
  return (await res.json()) as T;
}

export class BridgeError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`bridge ${status}: ${body.slice(0, 200)}`);
    this.name = "BridgeError";
    this.status = status;
    this.body = body;
  }
}

// ---- Lifecycle --------------------------------------------------------------

export interface BridgeHealth {
  status: "ok" | string;
  authRequired: boolean;
  version: string;
  platform?: string;
}

export function fetchHealth(channel: BridgeChannel = "whatsapp"): Promise<BridgeHealth> {
  return get(channel, "/health");
}

// ---- Session ----------------------------------------------------------------

export function startPairing(tenantId: string, channel: BridgeChannel = "whatsapp") {
  return post(channel, `/session/${encodeURIComponent(tenantId)}/start`);
}

export function disconnect(tenantId: string, channel: BridgeChannel = "whatsapp") {
  // iMessage uses /stop instead of /disconnect; map here.
  const path = channel === "imessage" ? "stop" : "disconnect";
  return post(channel, `/session/${encodeURIComponent(tenantId)}/${path}`);
}

export function reset(tenantId: string, channel: BridgeChannel = "whatsapp") {
  // iMessage doesn't have a 'reset' (no paired credentials to wipe).
  // Falls back to stop on iMessage so the UI doesn't break.
  const path = channel === "imessage" ? "stop" : "reset";
  return post<{ status: string; message: string }>(
    channel,
    `/session/${encodeURIComponent(tenantId)}/${path}`,
  );
}

export function fetchSessionDiagnostics(
  tenantId: string,
  channel: BridgeChannel = "whatsapp",
): Promise<BridgeDiagnostics> {
  return get(channel, `/session/${encodeURIComponent(tenantId)}/diagnostics`);
}

// ---- Bot state --------------------------------------------------------------

export function fetchBotState(tenantId: string, channel: BridgeChannel = "whatsapp"): Promise<BotState> {
  return get(channel, `/session/${encodeURIComponent(tenantId)}/bot`);
}

export function muteBot(tenantId: string, channel: BridgeChannel = "whatsapp"): Promise<BotState> {
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/mute`);
}

export function unmuteBot(tenantId: string, channel: BridgeChannel = "whatsapp"): Promise<BotState> {
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/unmute`);
}

export function pauseContact(
  tenantId: string,
  jid: string,
  channel: BridgeChannel = "whatsapp",
): Promise<BotState> {
  // iMessage expects `handle`; WhatsApp expects `jid`. Accept both
  // from callers but send what the bridge wants.
  const body = channel === "imessage" ? { handle: jid } : { jid };
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/pause`, body);
}

export function resumeContact(
  tenantId: string,
  jid: string,
  channel: BridgeChannel = "whatsapp",
): Promise<BotState> {
  const body = channel === "imessage" ? { handle: jid } : { jid };
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/resume`, body);
}

export function resumeAllPaused(tenantId: string, channel: BridgeChannel = "whatsapp"): Promise<BotState> {
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/resume-all`);
}

// ---- Groups (WhatsApp) / Chats (iMessage) -----------------------------------
//
// iMessage uses chat ROWIDs from chat.db; WhatsApp uses JID strings.
// The dashboard's groups page uses the same shape and only displays
// what comes back. Bridges return slightly different fields — we
// normalize to GroupRow here.

export interface IMessageChat {
  rowid: number;
  displayName: string;
  chatIdentifier: string;
  participantCount: number;
}

export function listGroups(tenantId: string, channel: BridgeChannel = "whatsapp"): Promise<{ groups: GroupRow[] }> {
  if (channel === "imessage") {
    // /chats returns { chats: IMessageChat[] }; convert to GroupRow.
    return get<{ chats: IMessageChat[] }>(channel, `/session/${encodeURIComponent(tenantId)}/chats`).then((d) => ({
      groups: d.chats.map((c) => ({
        jid: String(c.rowid), // bridge uses numeric rowid; we stringify
        name: c.displayName || c.chatIdentifier,
        participants: c.participantCount,
        monitored: false, // filled in by the page from bot.monitoredChats
      })),
    }));
  }
  return get(channel, `/session/${encodeURIComponent(tenantId)}/groups`);
}

export function refreshGroupSessions(tenantId: string, channel: BridgeChannel = "whatsapp") {
  if (channel === "imessage") {
    // iMessage doesn't need a refresh — chat.db is always live.
    return Promise.resolve({ ok: true, count: 0 });
  }
  return post<{ ok: boolean; count: number; error?: string }>(
    channel,
    `/session/${encodeURIComponent(tenantId)}/groups/refresh`,
  );
}

export function monitorGroup(
  tenantId: string,
  jid: string,
  channel: BridgeChannel = "whatsapp",
): Promise<BotState> {
  if (channel === "imessage") {
    const rowid = parseInt(jid, 10);
    return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/chat/monitor`, { rowid });
  }
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/group/monitor`, { jid });
}

export function unmonitorGroup(
  tenantId: string,
  jid: string,
  channel: BridgeChannel = "whatsapp",
): Promise<BotState> {
  if (channel === "imessage") {
    const rowid = parseInt(jid, 10);
    return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/chat/unmonitor`, { rowid });
  }
  return post(channel, `/session/${encodeURIComponent(tenantId)}/bot/group/unmonitor`, { jid });
}

// ---- WebSocket URL ----------------------------------------------------------
//
// Components open their own WS to handle reconnection/cleanup, but the URL
// + auth-query shape is centralized here.

export function bridgeWebSocketUrl(
  tenantId: string,
  channel: BridgeChannel = "whatsapp",
): string {
  // WebSocket connections go directly to the bridge — Next.js Route Handlers
  // cannot proxy WS.  The bridge URL is not a secret (it's a localhost port).
  // The shared token is intentionally omitted from the WS URL: it would be
  // visible in browser devtools and logs.  Bridge WS auth is enforced at the
  // HTTP level (REST calls proxy through /api/bridge/... with the server-side
  // token).  If the bridge requires token auth on WS too, set
  // LANTERN_BRIDGE_WS_TOKEN_REQUIRED=0 on the bridge side to disable it,
  // or upgrade to cookie-based WS auth.
  const wsUrl = bridgeBaseUrl(channel).replace(/^http/, "ws");
  const qs = new URLSearchParams({ tenantId });
  return `${wsUrl}/ws?${qs.toString()}`;
}
