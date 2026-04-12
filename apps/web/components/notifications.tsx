"use client";

import { useState, useRef, useEffect } from "react";
import { Bell, Check, CheckCheck, Rocket, Play, AlertTriangle, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Notification {
  id: string;
  icon: LucideIcon;
  iconColor: string;
  iconBg: string;
  title: string;
  time: string;
  read: boolean;
}

// ---------------------------------------------------------------------------
// Mock notifications
// ---------------------------------------------------------------------------

const initialNotifications: Notification[] = [
  {
    id: "1",
    icon: Rocket,
    iconColor: "text-emerald-400",
    iconBg: "bg-emerald-500/10",
    title: "Agent research-agent deployed to production",
    time: "2 min ago",
    read: false,
  },
  {
    id: "2",
    icon: Play,
    iconColor: "text-lantern-400",
    iconBg: "bg-lantern-500/10",
    title: "Run run_01hqa completed successfully",
    time: "5 min ago",
    read: false,
  },
  {
    id: "3",
    icon: AlertTriangle,
    iconColor: "text-amber-400",
    iconBg: "bg-amber-500/10",
    title: "Budget alert: 80% of monthly limit reached",
    time: "1 hour ago",
    read: false,
  },
  {
    id: "4",
    icon: Users,
    iconColor: "text-blue-400",
    iconBg: "bg-blue-500/10",
    title: "New team member joined",
    time: "yesterday",
    read: true,
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Notifications() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(initialNotifications);
  const panelRef = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => !n.read).length;

  // Close on click outside
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

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  const markAsRead = (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  };

  const markAllAsRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  };

  return (
    <div ref={panelRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200 focus-ring"
        aria-label="Notifications"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-lantern-500 px-1 text-[10px] font-bold text-white">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="modal-content absolute right-0 top-full mt-2 w-80 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-zinc-200">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllAsRead}
                className="flex items-center gap-1 text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
              >
                <CheckCheck className="h-3 w-3" />
                Mark all read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div className="max-h-[320px] overflow-y-auto">
            {notifications.map((notification) => {
              const Icon = notification.icon;
              return (
                <button
                  key={notification.id}
                  onClick={() => markAsRead(notification.id)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2 ${
                    !notification.read ? "bg-lantern-500/[0.03]" : ""
                  }`}
                >
                  <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${notification.iconBg}`}>
                    <Icon className={`h-3.5 w-3.5 ${notification.iconColor}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs leading-relaxed ${notification.read ? "text-zinc-500" : "text-zinc-300"}`}>
                      {notification.title}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-600">{notification.time}</p>
                  </div>
                  {!notification.read && (
                    <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-lantern-400" />
                  )}
                </button>
              );
            })}
          </div>

          {/* Footer */}
          <div className="border-t border-zinc-800 px-4 py-2.5">
            <button
              onClick={() => {}}
              className="w-full text-center text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            >
              View all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
