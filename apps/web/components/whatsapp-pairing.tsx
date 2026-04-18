"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import clsx from "clsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PairingStatus =
  | "idle"
  | "starting"
  | "waiting_qr"
  | "connected"
  | "disconnected"
  | "error";

interface WhatsAppPairingProps {
  tenantId: string;
  bridgeUrl?: string;
  onConnected?: (info: { phoneNumber: string; name: string }) => void;
  onDisconnected?: () => void;
}

// ---------------------------------------------------------------------------
// WhatsAppPairing component
// ---------------------------------------------------------------------------

export function WhatsAppPairing({
  tenantId,
  bridgeUrl = "http://localhost:3100",
  onConnected,
  onDisconnected,
}: WhatsAppPairingProps) {
  const [status, setStatus] = useState<PairingStatus>("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState<boolean | null>(null);
  const [botMuted, setBotMuted] = useState<boolean | null>(null);
  const [pausedCount, setPausedCount] = useState(0);
  const [togglingMute, setTogglingMute] = useState(false);
  const [clearingPauses, setClearingPauses] = useState(false);
  const [monitoredGroups, setMonitoredGroups] = useState<string[]>([]);
  const [unmonitoring, setUnmonitoring] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const refreshBotState = useCallback(async () => {
    try {
      const res = await fetch(`${bridgeUrl}/session/${tenantId}/bot`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        muted: boolean;
        paused: Record<string, number>;
        monitoredGroups?: string[];
      };
      setBotMuted(data.muted);
      setPausedCount(Object.keys(data.paused ?? {}).length);
      setMonitoredGroups(data.monitoredGroups ?? []);
    } catch {
      // Bridge unreachable — leave state as is
    }
  }, [bridgeUrl, tenantId]);

  const unmonitorGroup = async (jid: string) => {
    setUnmonitoring(jid);
    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/bot/group/unmonitor`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jid }),
        }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          muted: boolean;
          paused: Record<string, number>;
          monitoredGroups?: string[];
        };
        setBotMuted(data.muted);
        setPausedCount(Object.keys(data.paused ?? {}).length);
        setMonitoredGroups(data.monitoredGroups ?? []);
      }
    } catch {
      // Best effort
    }
    setUnmonitoring(null);
  };

  const clearAllPauses = async () => {
    if (pausedCount === 0) return;
    setClearingPauses(true);
    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/bot/resume-all`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          muted: boolean;
          paused: Record<string, number>;
          monitoredGroups?: string[];
        };
        setBotMuted(data.muted);
        setPausedCount(Object.keys(data.paused ?? {}).length);
        setMonitoredGroups(data.monitoredGroups ?? []);
      }
    } catch {
      // Best effort; stale state will recover on next refresh
    }
    setClearingPauses(false);
  };

  const toggleMute = async () => {
    if (botMuted === null) return;
    setTogglingMute(true);
    const path = botMuted ? "unmute" : "mute";
    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/bot/${path}`,
        { method: "POST" }
      );
      if (res.ok) {
        const data = (await res.json()) as {
          muted: boolean;
          paused: Record<string, number>;
          monitoredGroups?: string[];
        };
        setBotMuted(data.muted);
        setPausedCount(Object.keys(data.paused ?? {}).length);
        setMonitoredGroups(data.monitoredGroups ?? []);
      }
    } catch {
      // Show nothing; user will see stale state and can retry
    }
    setTogglingMute(false);
  };

  // Check if bridge service is running; if already paired, restore the
  // connected view so the user doesn't have to re-scan on reload.
  const checkBridge = useCallback(async () => {
    try {
      const res = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        setBridgeAvailable(true);
        try {
          const statusRes = await fetch(
            `${bridgeUrl}/session/${tenantId}/status`,
            { signal: AbortSignal.timeout(3000) }
          );
          if (statusRes.ok) {
            const s = (await statusRes.json()) as {
              status: string;
              paired: boolean;
              phoneNumber?: string | null;
              name?: string | null;
            };
            if (s.paired && s.status === "connected") {
              setStatus("connected");
              setPhoneNumber(s.phoneNumber ?? null);
              setDisplayName(s.name ?? null);
              refreshBotState();
            }
          }
        } catch {
          // Bridge reachable but status probe failed — leave idle
        }
        return true;
      }
    } catch {
      // Bridge not running
    }
    setBridgeAvailable(false);
    return false;
  }, [bridgeUrl, tenantId, refreshBotState]);

  useEffect(() => {
    checkBridge();
  }, [checkBridge]);

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const connectWebSocket = useCallback(() => {
    const wsUrl = bridgeUrl.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/ws?tenantId=${tenantId}`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        switch (msg.type) {
          case "qr":
            setStatus("waiting_qr");
            setQrDataUrl(msg.data);
            break;

          case "connected":
            setStatus("connected");
            setQrDataUrl(null);
            setPhoneNumber(msg.data.phoneNumber);
            setDisplayName(msg.data.name);
            refreshBotState();
            onConnected?.(msg.data);
            break;

          case "disconnected":
            setStatus("disconnected");
            setQrDataUrl(null);
            onDisconnected?.();
            break;

          case "error":
            setStatus("error");
            setErrorMessage(msg.data.message);
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setErrorMessage("WebSocket connection failed");
    };

    ws.onclose = () => {
      // Only set disconnected if we were previously connected
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
    };
  }, [bridgeUrl, tenantId, onConnected, onDisconnected]);

  const startPairing = async () => {
    setStatus("starting");
    setErrorMessage(null);
    setQrDataUrl(null);

    try {
      const res = await fetch(
        `${bridgeUrl}/session/${tenantId}/start`,
        { method: "POST" }
      );
      if (!res.ok) {
        throw new Error(`Bridge returned ${res.status}`);
      }

      // Connect WebSocket to receive QR and events
      connectWebSocket();
    } catch (err) {
      setStatus("error");
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to start session"
      );
    }
  };

  const handleDisconnect = async () => {
    try {
      await fetch(`${bridgeUrl}/session/${tenantId}/disconnect`, {
        method: "POST",
      });
    } catch {
      // Best effort
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setStatus("disconnected");
    setQrDataUrl(null);
    setPhoneNumber(null);
    setDisplayName(null);
    onDisconnected?.();
  };

  const handleRetry = () => {
    setStatus("idle");
    setErrorMessage(null);
    startPairing();
  };

  // Bridge not available
  if (bridgeAvailable === false) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
          <WifiOff className="h-4 w-4 shrink-0 text-amber-400" />
          <div>
            <p className="text-xs font-medium text-amber-300">
              WhatsApp bridge not running
            </p>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Start it with:{" "}
              <code className="rounded bg-surface-2 px-1 text-zinc-400">
                make run-whatsapp-bridge
              </code>
            </p>
          </div>
        </div>
        <button
          onClick={checkBridge}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <RefreshCw className="h-3 w-3" />
          Check again
        </button>
      </div>
    );
  }

  // Still checking
  if (bridgeAvailable === null) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        <span className="text-xs text-zinc-500">
          Checking WhatsApp bridge...
        </span>
      </div>
    );
  }

  // Connected state
  if (status === "connected") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
          <div>
            <p className="text-sm font-medium text-emerald-300">
              Connected to WhatsApp
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              {displayName ? `${displayName} ` : ""}
              {phoneNumber ? `+${phoneNumber}` : ""}
            </p>
          </div>
        </div>

        {/* Bot auto-reply toggle */}
        {botMuted !== null && (
          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-surface-2 p-3">
            <div className="min-w-0 pr-3">
              <p className="text-xs font-medium text-zinc-200">
                Auto-reply{" "}
                <span
                  className={clsx(
                    "ml-1 rounded px-1.5 py-0.5 text-[10px] font-semibold",
                    botMuted
                      ? "bg-zinc-500/10 text-zinc-400"
                      : "bg-emerald-500/10 text-emerald-400"
                  )}
                >
                  {botMuted ? "OFF" : "ON"}
                </span>
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {botMuted
                  ? "Bot is silent for every contact."
                  : pausedCount > 0
                    ? `Bot is replying — paused for ${pausedCount} contact${pausedCount === 1 ? "" : "s"}.`
                    : "Bot replies to every inbound DM."}
              </p>
              {pausedCount > 0 && (
                <button
                  onClick={clearAllPauses}
                  disabled={clearingPauses}
                  className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
                >
                  {clearingPauses ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : null}
                  Resume all {pausedCount} paused
                </button>
              )}
            </div>
            <button
              onClick={toggleMute}
              disabled={togglingMute}
              className={clsx(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50",
                botMuted ? "bg-zinc-700" : "bg-emerald-500"
              )}
              title={botMuted ? "Turn auto-reply on" : "Turn auto-reply off"}
            >
              <span
                className={clsx(
                  "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                  botMuted ? "translate-x-1" : "translate-x-6"
                )}
              />
            </button>
          </div>
        )}

        {/* Monitored groups */}
        <div className="rounded-lg border border-zinc-800 bg-surface-2 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-200">
              Monitored groups
              <span className="ml-2 rounded bg-zinc-700/50 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                {monitoredGroups.length}
              </span>
            </p>
          </div>
          {monitoredGroups.length === 0 ? (
            <p className="mt-1 text-[11px] text-zinc-500">
              Groups are off by default. Send{" "}
              <code className="rounded bg-surface-3 px-1 text-zinc-300">/bot monitor on</code>{" "}
              inside any group from your phone to enable it.
            </p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {monitoredGroups.map((jid) => (
                <li
                  key={jid}
                  className="flex items-center justify-between gap-2 rounded-md bg-surface-3 px-2 py-1.5"
                >
                  <code className="truncate text-[11px] text-zinc-300">
                    {jid.split("@")[0]}
                  </code>
                  <button
                    onClick={() => unmonitorGroup(jid)}
                    disabled={unmonitoring === jid}
                    className="shrink-0 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    {unmonitoring === jid ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      "Remove"
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-zinc-500 leading-relaxed">
            In monitored groups: urgent messages DM you; auto-replies fire only
            when you&apos;re @mentioned or quoted.
          </p>
        </div>

        <div className="rounded-lg border border-zinc-800 bg-surface-0 p-3 text-[11px] text-zinc-500 leading-relaxed">
          <p className="font-medium text-zinc-400 mb-1">Quick commands</p>
          <p>
            From your phone&apos;s WhatsApp:
            <br />• In <b>Message Yourself</b>:{" "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot off</code>
            {" / "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot on</code>
            {" / "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot status</code>{" "}
            — global toggle.
            <br />• In any friend&apos;s thread:{" "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot off</code>
            {" / "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot on</code>{" "}
            — per-contact (command auto-deleted). Typing any reply auto-pauses
            the bot for that contact for 60 min.
            <br />• In any group:{" "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot monitor on</code>
            {" / "}
            <code className="rounded bg-surface-2 px-1 text-zinc-300">/bot monitor off</code>{" "}
            — opt the group in/out (command auto-deleted).
          </p>
        </div>

        <button
          onClick={handleDisconnect}
          className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10"
        >
          Disconnect
        </button>
      </div>
    );
  }

  // Error state
  if (status === "error") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          <div>
            <p className="text-xs font-medium text-red-300">
              Connection failed
            </p>
            {errorMessage && (
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {errorMessage}
              </p>
            )}
          </div>
        </div>
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <RefreshCw className="h-3 w-3" />
          Try again
        </button>
      </div>
    );
  }

  // Disconnected state (after being connected)
  if (status === "disconnected") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-surface-2 p-3">
          <WifiOff className="h-4 w-4 shrink-0 text-zinc-500" />
          <p className="text-xs text-zinc-400">Disconnected from WhatsApp</p>
        </div>
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400"
        >
          <RefreshCw className="h-3 w-3" />
          Reconnect
        </button>
      </div>
    );
  }

  // Waiting for QR / Scanning
  if (status === "waiting_qr" && qrDataUrl) {
    return (
      <div className="flex flex-col items-center space-y-3">
        <div className="rounded-2xl border border-zinc-800 bg-surface-0 p-4">
          <img
            src={qrDataUrl}
            alt="WhatsApp QR Code"
            width={256}
            height={256}
            className="rounded-lg"
          />
        </div>
        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
          <Smartphone className="h-3.5 w-3.5" />
          <span>Open WhatsApp on your phone and scan this code</span>
        </div>
        <p className="max-w-[260px] text-center text-[11px] text-zinc-600 leading-relaxed">
          Go to Settings &gt; Linked Devices &gt; Link a Device, then point your camera at this QR code.
        </p>
      </div>
    );
  }

  // Starting state
  if (status === "starting") {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <Loader2 className="h-6 w-6 animate-spin text-lantern-400" />
        <p className="text-xs text-zinc-500">Starting WhatsApp session...</p>
      </div>
    );
  }

  // Idle state -- show start button
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-surface-0 p-3">
        <Wifi className="h-4 w-4 shrink-0 text-green-400" />
        <div>
          <p className="text-xs font-medium text-zinc-300">
            Bridge service running
          </p>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Click below to generate a QR code and pair your WhatsApp
          </p>
        </div>
      </div>
      <button
        onClick={startPairing}
        className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-green-500"
      >
        <Smartphone className="h-3.5 w-3.5" />
        Pair with QR Code
      </button>
    </div>
  );
}
