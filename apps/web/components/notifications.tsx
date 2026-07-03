"use client";

import { useState, useRef, useEffect } from "react";
import { Bell } from "lucide-react";

// ponytail: no notifications backend exists yet (no /v1/notifications or
// equivalent feed) — rather than fabricate mock alerts, this renders an
// honest empty state. Wire this up once a real source lands.
export function Notifications() {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200 focus-ring"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
      </button>

      {open && (
        <div className="modal-content absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 shadow-2xl">
          <div className="border-b border-zinc-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-zinc-200">Notifications</h3>
          </div>
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <Bell className="h-5 w-5 text-zinc-600" />
            <p className="text-xs text-zinc-500">No notifications</p>
          </div>
        </div>
      )}
    </div>
  );
}
