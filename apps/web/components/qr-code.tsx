"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Smartphone } from "lucide-react";

interface QRCodeProps {
  /** The data to encode */
  value: string;
  /** Size in pixels */
  size?: number;
  /** Label shown below the QR code */
  label?: string;
  /** Whether the QR code expires and can be refreshed */
  expiresIn?: number;
  /** Called when refresh is clicked */
  onRefresh?: () => string;
  /** Additional class names */
  className?: string;
}

export function QRCode({
  value,
  size = 200,
  label,
  expiresIn,
  onRefresh,
  className = "",
}: QRCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loading, setLoading] = useState(true);
  const [currentValue, setCurrentValue] = useState(value);
  const [timeLeft, setTimeLeft] = useState(expiresIn ?? 0);
  const [expired, setExpired] = useState(false);

  // Generate QR code on canvas
  useEffect(() => {
    setLoading(true);
    setExpired(false);
    if (expiresIn) setTimeLeft(expiresIn);

    import("qrcode").then((QRCodeLib) => {
      if (!canvasRef.current) return;
      QRCodeLib.toCanvas(
        canvasRef.current,
        currentValue,
        {
          width: size,
          margin: 2,
          color: {
            dark: "#e4e4e7",
            light: "#09090b",
          },
          errorCorrectionLevel: "M",
        },
        (err) => {
          if (err) console.error("QR generation failed:", err);
          setLoading(false);
        }
      );
    });
  }, [currentValue, size, expiresIn]);

  // Countdown timer
  useEffect(() => {
    if (!expiresIn || expired) return;
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setExpired(true);
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresIn, expired, currentValue]);

  const handleRefresh = () => {
    if (onRefresh) {
      const newValue = onRefresh();
      setCurrentValue(newValue);
    } else {
      setCurrentValue(value + "&t=" + Date.now());
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className={`flex flex-col items-center ${className}`}>
      {/* QR code container */}
      <div className="relative rounded-2xl border border-zinc-800 bg-surface-0 p-4">
        {loading && (
          <div
            className="flex items-center justify-center"
            style={{ width: size, height: size }}
          >
            <Loader2 className="h-6 w-6 animate-spin text-zinc-500" />
          </div>
        )}

        <canvas
          ref={canvasRef}
          className={`rounded-lg ${loading ? "hidden" : ""} ${expired ? "opacity-20 blur-sm" : ""}`}
        />

        {/* Expired overlay */}
        {expired && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <p className="mb-2 text-sm font-medium text-zinc-300">Code expired</p>
            <button
              onClick={handleRefresh}
              className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-lantern-400"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        )}

        {/* Center icon overlay */}
        {!loading && !expired && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-0 border border-zinc-800 shadow-lg">
              <Smartphone className="h-5 w-5 text-lantern-400" />
            </div>
          </div>
        )}
      </div>

      {/* Timer */}
      {expiresIn && !expired && !loading && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
          <span>Expires in</span>
          <span className={`font-mono ${timeLeft < 30 ? "text-amber-400" : ""}`}>
            {formatTime(timeLeft)}
          </span>
        </div>
      )}

      {/* Refresh button (when not expired and refreshable) */}
      {onRefresh && !expired && !loading && (
        <button
          onClick={handleRefresh}
          className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <RefreshCw className="h-2.5 w-2.5" />
          Generate new code
        </button>
      )}

      {/* Label */}
      {label && (
        <p className="mt-3 max-w-[220px] text-center text-xs text-zinc-500 leading-relaxed">
          {label}
        </p>
      )}
    </div>
  );
}

/**
 * Generates a unique pairing token for QR-based device linking.
 */
export function generatePairingToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

/**
 * Builds a deep link URL for QR scanning.
 */
export function buildQRLink(params: {
  type: "pair" | "whatsapp" | "telegram";
  token?: string;
  botUsername?: string;
  phoneNumber?: string;
}): string {
  const base = typeof window !== "undefined" ? window.location.origin : "https://app.lantern.run";

  switch (params.type) {
    case "pair":
      return `${base}/pair?token=${params.token ?? generatePairingToken()}`;
    case "whatsapp":
      return `https://wa.me/${params.phoneNumber ?? ""}?text=${encodeURIComponent("Connect to Lantern")}`;
    case "telegram":
      return `https://t.me/${params.botUsername ?? "LanternBot"}?start=connect`;
    default:
      return `${base}/pair?token=${generatePairingToken()}`;
  }
}
