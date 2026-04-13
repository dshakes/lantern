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
  const wsRef = useRef<WebSocket | null>(null);

  // Check if bridge service is running
  const checkBridge = useCallback(async () => {
    try {
      const res = await fetch(`${bridgeUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        setBridgeAvailable(true);
        return true;
      }
    } catch {
      // Bridge not running
    }
    setBridgeAvailable(false);
    return false;
  }, [bridgeUrl]);

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
