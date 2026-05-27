"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import React from "react";
import { X, CheckCircle2, XCircle, AlertTriangle, Info } from "lucide-react";
import clsx from "clsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToastKind = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastCtx {
  toast: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  warning: (message: string) => void;
  info: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const ToastContext = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

let nextId = 0;

// Hard cap on simultaneously-visible toasts. A bug-driven 401 storm or a
// noisy form-validation flow shouldn't bury the rest of the UI under a
// vertical wall of error pills. Newest toasts stay visible; the oldest
// silently fall off so the viewport stays sane.
const MAX_VISIBLE_TOASTS = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = ++nextId;
    setToasts((prev) => {
      const next = [...prev, { id, message, kind }];
      if (next.length > MAX_VISIBLE_TOASTS) {
        return next.slice(next.length - MAX_VISIBLE_TOASTS);
      }
      return next;
    });
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value: ToastCtx = {
    toast: push,
    success: (m) => push(m, "success"),
    error: (m) => push(m, "error"),
    warning: (m) => push(m, "warning"),
    info: (m) => push(m, "info"),
  };

  return React.createElement(
    ToastContext.Provider,
    { value },
    children,
    React.createElement(ToastContainer, { toasts, dismiss }),
  );
}

// ---------------------------------------------------------------------------
// Toast container + individual toast
// ---------------------------------------------------------------------------

function ToastContainer({
  toasts,
  dismiss,
}: {
  toasts: Toast[];
  dismiss: (id: number) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} dismiss={dismiss} />
      ))}
    </div>
  );
}

const kindStyles: Record<
  ToastKind,
  { bg: string; border: string; icon: typeof CheckCircle2; iconColor: string }
> = {
  success: {
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    icon: CheckCircle2,
    iconColor: "text-emerald-400",
  },
  error: {
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    icon: XCircle,
    iconColor: "text-red-400",
  },
  warning: {
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    icon: AlertTriangle,
    iconColor: "text-amber-400",
  },
  info: {
    bg: "bg-blue-500/10",
    border: "border-blue-500/30",
    icon: Info,
    iconColor: "text-blue-400",
  },
};

function ToastItem({
  toast,
  dismiss,
}: {
  toast: Toast;
  dismiss: (id: number) => void;
}) {
  const style = kindStyles[toast.kind];
  const Icon = style.icon;

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);

  return (
    <div
      className={clsx(
        "pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-3 shadow-lg backdrop-blur-sm",
        "animate-in slide-in-from-right duration-200",
        style.bg,
        style.border,
      )}
    >
      <Icon className={clsx("h-4 w-4 shrink-0", style.iconColor)} />
      <span className="text-sm text-zinc-200">{toast.message}</span>
      <button
        onClick={() => dismiss(toast.id)}
        className="ml-2 shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
