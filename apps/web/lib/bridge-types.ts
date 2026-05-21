// Shared types for the personal-assistant bridges (WhatsApp + iMessage).
// Originally extracted from components/whatsapp-pairing.tsx; iMessage
// reuses 95% of the shape so the dashboard pages can be channel-agnostic.

// Which personal-assistant channel the user is currently looking at.
// Persisted to localStorage so deep links work + tab survives reload.
export type BridgeChannel = "whatsapp" | "imessage";

export const BRIDGE_CHANNELS: BridgeChannel[] = ["whatsapp", "imessage"];

export function isBridgeChannel(s: string): s is BridgeChannel {
  return s === "whatsapp" || s === "imessage";
}
//
// Source of truth for ConnectionState is the bridge's session.ts. Two
// extra states sit out front of the wire ones, owned by the dashboard:
//   - `unknown`         — initial mount before bridge probe answers
//   - `bridge_offline`  — bridge unreachable on this host
//   - `auth_required`   — bridge reachable but shared token is wrong

export type ConnectionState =
  | "unknown"
  | "bridge_offline"
  | "auth_required"
  | "idle"
  | "starting"
  | "qr_ready"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  // Terminal: another WhatsApp Web session is active for this number
  // and keeps stealing our slot. Reconnecting is futile until the user
  // closes the other session.
  | "conflict"
  | "error";

// Stepper stages — the four "wide" milestones the user walks through
// from cold start to live messaging.
export type Stage = "bridge" | "auth" | "pairing" | "connected";

export const STATE_TO_STAGE: Record<ConnectionState, Stage> = {
  unknown: "bridge",
  bridge_offline: "bridge",
  auth_required: "auth",
  idle: "auth",
  starting: "pairing",
  qr_ready: "pairing",
  connecting: "pairing",
  connected: "connected",
  reconnecting: "connected",
  logged_out: "pairing",
  conflict: "pairing",
  error: "pairing",
};

export interface BotState {
  muted: boolean;
  paused: Record<string, number>; // jid -> until_ms
  monitoredGroups?: string[];
}

// Live activity feed entries — derived from `message`, `agent_reply`,
// and `activity` WebSocket events. Flattened into one timeline so the
// user sees the full conversational context.
export type ActivityKind =
  | "bot_on"
  | "bot_off"
  | "monitor_on"
  | "monitor_off"
  | "contact_paused"
  | "contact_resumed"
  | "attention_dm"
  | "agent_skipped"
  | "message_in"
  | "agent_reply"
  | "system";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  summary: string;
  detail?: string;
  jid?: string;
  pushName?: string;
  timestamp: number;
}

// One row from GET /session/:tid/groups. Powers the searchable group
// picker on /personal/groups (and the original modal during the
// migration period).
export interface GroupRow {
  jid: string;
  name: string;
  participants: number;
  monitored: boolean;
}

// Bridge diagnostics blob — what the bridge reports about itself.
// Optional fields because the bridge fills them lazily.
export interface BridgeDiagnostics {
  tenantId?: string;
  state?: ConnectionState;
  paired?: boolean;
  connected?: boolean;
  phoneNumber?: string | null;
  displayName?: string | null;
  startedAt?: number;
  uptimeMs?: number;
  lastError?: string | null;
  reconnectAttempts?: number;
  authDirPresent?: boolean;
}
