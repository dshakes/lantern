"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";
import clsx from "clsx";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
}

const SIZES = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
  xl: "max-w-4xl",
} as const;

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Escape + scroll-lock.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  // Focus trap: move focus in on open, restore it on close, keep Tab inside.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const node = contentRef.current;
    const focusables = () =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
    const first = focusables()[0];
    (first ?? node)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !node) return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={contentRef}
        className={clsx(
          "modal-content w-full rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl",
          SIZES[size],
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-zinc-800 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                {description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
  onCancel: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}

// Shared replacement for native confirm()/prompt() dialogs — same
// Escape/focus-trap/scroll-lock behavior as Modal, consistent styling.
export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  onCancel,
  onConfirm,
  confirming = false,
}: ConfirmModalProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            className={clsx(
              "rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50",
              tone === "danger" ? "bg-rose-500 hover:bg-rose-400" : "bg-lantern-500 hover:bg-lantern-400",
            )}
          >
            {confirming ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {null}
    </Modal>
  );
}

export function ModalField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-zinc-400">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-zinc-600">{hint}</p>}
    </div>
  );
}
