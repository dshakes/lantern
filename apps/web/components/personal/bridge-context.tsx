"use client";

// React context owning the WhatsApp bridge connection: WebSocket
// lifecycle, connection state machine, activity feed, bot state, and
// the imperative actions a page might trigger (pair, disconnect,
// mute/unmute, pause/resume contacts, monitor/unmonitor groups).
//
// Why a single context rather than duplicating the state in each
// /personal/* page: there's ONE bridge per tenant. Multiple subscribers
// to the same WS would either need their own copies of the state-
// machine (drift) or pay the cost of separate connections (the bridge
// caps a few connections per tenant). Hoisting both to one provider
// gives every page a synchronized view + cheap re-renders.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import * as bridge from "@/lib/bridge-client";
import type {
  ActivityEvent,
  ActivityKind,
  BotState,
  BridgeChannel,
  ConnectionState,
  GroupRow,
} from "@/lib/bridge-types";
import { useToast } from "@/components/toast";

interface BridgeContextValue {
  channel: BridgeChannel;
  // Live connection state
  state: ConnectionState;
  reason: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  connectedAt: number | null;

  // QR pairing
  qrDataUrl: string | null;
  qrIssuedAt: number | null;
  qrExpiresInMs: number;

  // Bot state
  bot: BotState | null;

  // Activity feed (newest first, capped at 200)
  activity: ActivityEvent[];

  // Per-action busy flags for inline spinners
  busy: {
    pairing: boolean;
    disconnecting: boolean;
    resetting: boolean;
    togglingMute: boolean;
    clearingPauses: boolean;
    refreshingGroups: boolean;
  };

  // Actions
  startPairing: () => Promise<void>;
  disconnect: () => Promise<void>;
  reset: () => Promise<void>;
  toggleMute: () => Promise<void>;
  clearAllPauses: () => Promise<void>;
  pauseContact: (jid: string) => Promise<void>;
  resumeContact: (jid: string) => Promise<void>;
  monitorGroup: (jid: string) => Promise<void>;
  unmonitorGroup: (jid: string) => Promise<void>;
  refreshGroups: () => Promise<GroupRow[]>;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

interface ProviderProps {
  tenantId: string;
  channel: BridgeChannel;
  children: React.ReactNode;
}

const ACTIVITY_CAP = 200;

export function BridgeProvider({ tenantId, channel, children }: ProviderProps) {
  const [state, setState] = useState<ConnectionState>("unknown");
  const [reason, setReason] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrIssuedAt, setQrIssuedAt] = useState<number | null>(null);
  const [qrExpiresInMs, setQrExpiresInMs] = useState<number>(20_000);

  const [bot, setBot] = useState<BotState | null>(null);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);

  const [busy, setBusy] = useState<BridgeContextValue["busy"]>({
    pairing: false,
    disconnecting: false,
    resetting: false,
    togglingMute: false,
    clearingPauses: false,
    refreshingGroups: false,
  });

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  // ---- helpers ----

  const pushActivity = useCallback(
    (e: Omit<ActivityEvent, "id"> & { id?: string }) => {
      setActivity((prev) => {
        const next: ActivityEvent[] = [
          { id: e.id ?? `${e.timestamp}-${Math.random()}`, ...e },
          ...prev,
        ];
        return next.slice(0, ACTIVITY_CAP);
      });
    },
    [],
  );

  const refreshBotState = useCallback(async () => {
    try {
      const next = await bridge.fetchBotState(tenantId, channel);
      setBot(next);
    } catch {
      // bridge unreachable — leave previous state in place
    }
  }, [tenantId]);

  // ---- bridge probe + WS connect ----
  //
  // On mount, ask the bridge for its current diagnostics so we render
  // the right state immediately (instead of "unknown" → flicker →
  // "connected"). If the probe fails, we know the bridge process isn't
  // running on this host.

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const health = await bridge.fetchHealth(channel);
        if (cancelled) return;
        if (health.authRequired) {
          setState("auth_required");
          setReason("Bridge requires a shared token");
          return;
        }
        const diag = await bridge.fetchSessionDiagnostics(tenantId, channel);
        if (cancelled) return;
        // iMessage uses 'ready' to mean live; map to 'connected' so
        // the UI's isLive checks work uniformly across channels.
        if (diag.state) setState(normalizeChannelState(diag.state, channel));
        else setState(diag.connected ? "connected" : "idle");
        if (diag.phoneNumber) setPhoneNumber(diag.phoneNumber);
        if (diag.displayName) setDisplayName(diag.displayName);
        if (typeof diag.startedAt === "number") setConnectedAt(diag.startedAt);
        if (diag.lastError) setReason(diag.lastError);
        // If we're already paired, refresh bot state + open WS
        if (diag.paired || diag.connected) {
          refreshBotState();
        }
      } catch {
        if (cancelled) return;
        setState("bridge_offline");
        setReason("Couldn't reach the WhatsApp bridge on this host.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, refreshBotState]);

  const connectWS = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    const ws = new WebSocket(bridge.bridgeWebSocketUrl(tenantId, channel));
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "connection_state": {
            const raw = msg.data?.state as string | undefined;
            if (raw) {
              setState(normalizeChannelState(raw, channel));
              setReason(msg.data?.reason ?? null);
            }
            break;
          }
          case "qr": {
            setState("qr_ready");
            setQrDataUrl(typeof msg.data === "string" ? msg.data : null);
            setQrIssuedAt(
              typeof msg.issuedAt === "number" ? msg.issuedAt : Date.now(),
            );
            setQrExpiresInMs(
              typeof msg.expiresInMs === "number" ? msg.expiresInMs : 20_000,
            );
            break;
          }
          case "connected": {
            setState("connected");
            setQrDataUrl(null);
            setQrIssuedAt(null);
            setPhoneNumber(msg.data?.phoneNumber ?? null);
            setDisplayName(msg.data?.name ?? null);
            setConnectedAt(
              typeof msg.data?.connectedAt === "number"
                ? msg.data.connectedAt
                : Date.now(),
            );
            void refreshBotState();
            pushActivity({
              kind: "system",
              summary: "Connected to WhatsApp",
              timestamp: Date.now(),
            });
            break;
          }
          case "disconnected": {
            if (msg.data?.loggedOut) {
              setState("logged_out");
              setReason(
                "Your phone unlinked this device. Pair again to continue.",
              );
            } else {
              setState((curr) =>
                curr === "connected" ? "reconnecting" : curr,
              );
            }
            break;
          }
          case "error": {
            setState("error");
            setReason(msg.data?.message ?? "Bridge returned an error");
            break;
          }
          case "message": {
            const text: string = msg.data?.text ?? "";
            const from: string = msg.data?.from ?? "";
            const push: string | undefined = msg.data?.pushName;
            pushActivity({
              kind: "message_in",
              summary: `${push || from.split("@")[0]} → you`,
              detail: text,
              jid: from,
              pushName: push,
              timestamp:
                typeof msg.data?.timestamp === "number"
                  ? msg.data.timestamp * 1000
                  : Date.now(),
            });
            break;
          }
          case "agent_reply": {
            const text: string = msg.data?.text ?? "";
            const to: string = msg.data?.to ?? "";
            pushActivity({
              kind: "agent_reply",
              summary: `Replied to ${to.split("@")[0]}`,
              detail: text,
              jid: to,
              timestamp:
                typeof msg.data?.timestamp === "number"
                  ? msg.data.timestamp
                  : Date.now(),
            });
            break;
          }
          case "activity": {
            const kind = (msg.data?.kind as ActivityKind) ?? "system";
            pushActivity({
              kind,
              summary: msg.data?.summary ?? "Activity",
              detail: msg.data?.detail,
              jid: msg.data?.jid,
              pushName: msg.data?.pushName,
              timestamp: msg.data?.timestamp ?? Date.now(),
            });
            // Bot-state-changing kinds force a refresh.
            if (
              kind === "bot_on" ||
              kind === "bot_off" ||
              kind === "monitor_on" ||
              kind === "monitor_off" ||
              kind === "contact_paused" ||
              kind === "contact_resumed"
            ) {
              void refreshBotState();
            }
            break;
          }
        }
      } catch {
        // ignore malformed events
      }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      // Auto-reconnect after a short backoff so a bridge restart
      // doesn't leave the dashboard stuck on stale state.
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => connectWS(), 3000);
    };
  }, [tenantId, refreshBotState, pushActivity]);

  // Open WS whenever we know the bridge is reachable. We try once when
  // state becomes anything other than 'unknown' or 'bridge_offline'.
  useEffect(() => {
    if (state === "bridge_offline" || state === "unknown") return;
    if (!wsRef.current) connectWS();
    return () => {
      // Note: do NOT close the WS on every effect cleanup; the
      // connectWS call's onclose handler manages reconnects.
    };
  }, [state, connectWS]);

  // Final cleanup on unmount.
  useEffect(() => {
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  // ---- actions ----

  const startPairing = useCallback(async () => {
    setBusy((b) => ({ ...b, pairing: true }));
    try {
      await bridge.startPairing(tenantId, channel);
      setState("starting");
      setReason(null);
      setQrDataUrl(null);
      connectWS();
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Failed to start pairing",
      );
    } finally {
      setBusy((b) => ({ ...b, pairing: false }));
    }
  }, [tenantId, connectWS, toast]);

  const disconnect = useCallback(async () => {
    setBusy((b) => ({ ...b, disconnecting: true }));
    try {
      await bridge.disconnect(tenantId, channel);
      wsRef.current?.close();
      wsRef.current = null;
      setState("idle");
      setQrDataUrl(null);
      setPhoneNumber(null);
      setDisplayName(null);
      setConnectedAt(null);
      setBot(null);
      toast.info("Disconnected from WhatsApp");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    } finally {
      setBusy((b) => ({ ...b, disconnecting: false }));
    }
  }, [tenantId, toast]);

  const reset = useCallback(async () => {
    setBusy((b) => ({ ...b, resetting: true }));
    try {
      await bridge.reset(tenantId, channel);
      wsRef.current?.close();
      wsRef.current = null;
      setState("idle");
      setQrDataUrl(null);
      setPhoneNumber(null);
      setDisplayName(null);
      setConnectedAt(null);
      setBot(null);
      setActivity([]);
      toast.success("Bridge reset — credentials wiped");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy((b) => ({ ...b, resetting: false }));
    }
  }, [tenantId, toast]);

  const toggleMute = useCallback(async () => {
    if (!bot) return;
    setBusy((b) => ({ ...b, togglingMute: true }));
    try {
      const next = bot.muted
        ? await bridge.unmuteBot(tenantId, channel)
        : await bridge.muteBot(tenantId, channel);
      setBot(next);
      toast.success(next.muted ? "Auto-reply paused" : "Auto-reply enabled");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setBusy((b) => ({ ...b, togglingMute: false }));
    }
  }, [tenantId, bot, toast]);

  const clearAllPauses = useCallback(async () => {
    setBusy((b) => ({ ...b, clearingPauses: true }));
    try {
      const next = await bridge.resumeAllPaused(tenantId, channel);
      setBot(next);
      toast.success("Auto-reply resumed for all paused contacts");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Clear pauses failed");
    } finally {
      setBusy((b) => ({ ...b, clearingPauses: false }));
    }
  }, [tenantId, toast]);

  const pauseContact = useCallback(
    async (jid: string) => {
      try {
        const next = await bridge.pauseContact(tenantId, jid, channel);
        setBot(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Pause failed");
      }
    },
    [tenantId, toast],
  );

  const resumeContact = useCallback(
    async (jid: string) => {
      try {
        const next = await bridge.resumeContact(tenantId, jid, channel);
        setBot(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Resume failed");
      }
    },
    [tenantId, toast],
  );

  const monitorGroup = useCallback(
    async (jid: string) => {
      try {
        const next = await bridge.monitorGroup(tenantId, jid, channel);
        setBot(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Monitor failed");
      }
    },
    [tenantId, toast],
  );

  const unmonitorGroup = useCallback(
    async (jid: string) => {
      try {
        const next = await bridge.unmonitorGroup(tenantId, jid, channel);
        setBot(next);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Unmonitor failed");
      }
    },
    [tenantId, toast],
  );

  const refreshGroups = useCallback(async (): Promise<GroupRow[]> => {
    setBusy((b) => ({ ...b, refreshingGroups: true }));
    try {
      const { groups } = await bridge.listGroups(tenantId, channel);
      return groups;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't fetch groups");
      return [];
    } finally {
      setBusy((b) => ({ ...b, refreshingGroups: false }));
    }
  }, [tenantId, toast]);

  const value = useMemo<BridgeContextValue>(
    () => ({
      channel,
      state,
      reason,
      phoneNumber,
      displayName,
      connectedAt,
      qrDataUrl,
      qrIssuedAt,
      qrExpiresInMs,
      bot,
      activity,
      busy,
      startPairing,
      disconnect,
      reset,
      toggleMute,
      clearAllPauses,
      pauseContact,
      resumeContact,
      monitorGroup,
      unmonitorGroup,
      refreshGroups,
    }),
    [
      channel,
      state,
      reason,
      phoneNumber,
      displayName,
      connectedAt,
      qrDataUrl,
      qrIssuedAt,
      qrExpiresInMs,
      bot,
      activity,
      busy,
      startPairing,
      disconnect,
      reset,
      toggleMute,
      clearAllPauses,
      pauseContact,
      resumeContact,
      monitorGroup,
      unmonitorGroup,
      refreshGroups,
    ],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): BridgeContextValue {
  const ctx = useContext(BridgeContext);
  if (!ctx) {
    throw new Error("useBridge must be used inside <BridgeProvider>");
  }
  return ctx;
}

// Each bridge emits its own state vocabulary. We normalize to the
// ConnectionState union the UI uses so isLive checks (`state ===
// "connected"`) work uniformly. iMessage's `ready` = WhatsApp's
// `connected`; iMessage's `permission_required` / `messages_not_running`
// both map to `error` for the banner color, with the original reason
// surfaced separately to the user.
function normalizeChannelState(raw: string, channel: BridgeChannel): ConnectionState {
  if (channel === "imessage") {
    switch (raw) {
      case "ready": return "connected";
      case "starting": return "starting";
      case "permission_required": return "error";
      case "messages_not_running": return "error";
      case "error": return "error";
      default: return "idle";
    }
  }
  // WhatsApp already speaks the UI's vocabulary.
  return raw as ConnectionState;
}
