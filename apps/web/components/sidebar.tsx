"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  Play,
  MessageSquare,
  Plug,
  Cloud,
  BarChart3,
  Settings,
  User,
  ChevronsUpDown,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Store,
} from "lucide-react";
import clsx from "clsx";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";

const navItems = [
  { href: "/agents", label: "Agents", icon: Bot, shortcut: "1" },
  { href: "/runs", label: "Runs", icon: Play, shortcut: "2" },
  { href: "/surfaces", label: "Surfaces", icon: MessageSquare, shortcut: "3" },
  { href: "/connectors", label: "Connectors", icon: Plug, shortcut: "4" },
  { href: "/deployments", label: "Deployments", icon: Cloud, shortcut: "5" },
  { href: "/marketplace", label: "Marketplace", icon: Store, shortcut: "6" },
  { href: "/evaluations", label: "Evaluations", icon: BarChart3, shortcut: "7" },
  { href: "/settings", label: "Settings", icon: Settings, shortcut: "8" },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isDemoMode, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside handler for user dropdown
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showMenu]);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  // Keyboard shortcuts: press 1-7 to navigate (when not in an input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      // Don't trigger if modifier keys are held
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const index = parseInt(e.key, 10);
      if (index >= 1 && index <= navItems.length) {
        e.preventDefault();
        router.push(navItems[index - 1].href);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router]);

  return (
    <aside
      className={clsx(
        "flex h-screen flex-col border-r border-zinc-800 bg-surface-1 transition-all duration-200",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className={clsx("flex items-center px-5 py-5", collapsed ? "justify-center" : "gap-3")}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-lg shadow-lantern-500/20">
          <span className="text-base font-bold text-white leading-none">L</span>
        </div>
        {!collapsed && (
          <>
            <span className="text-lg font-semibold tracking-[-0.02em] text-white">Lantern</span>
            {isDemoMode && (
              <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-[10px] font-medium text-lantern-400">
                demo
              </span>
            )}
          </>
        )}
      </div>

      {/* Collapse toggle */}
      <div className={clsx("px-3 mb-1", collapsed && "flex justify-center")}>
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex items-center justify-center rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <PanelLeftClose className="h-4 w-4" />
          )}
        </button>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx(
                "sidebar-item",
                isActive && "active",
                collapsed && "justify-center px-0",
              )}
              title={collapsed ? item.label : undefined}
            >
              <item.icon className="h-4.5 w-4.5 shrink-0" />
              {!collapsed && (
                <>
                  <span className="flex-1">{item.label}</span>
                  <kbd className="hidden xl:inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-zinc-800 bg-surface-2 px-1 text-[10px] font-medium text-zinc-600">
                    {item.shortcut}
                  </kbd>
                </>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="relative border-t border-zinc-800 px-3 py-3" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className={clsx(
            "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200",
            collapsed && "justify-center px-0",
          )}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3">
            <User className="h-4 w-4 text-zinc-400" />
          </div>
          {!collapsed && (
            <>
              <div className="flex flex-1 flex-col items-start">
                <span className="text-xs font-medium text-zinc-300 truncate max-w-[120px]">
                  {user?.name ?? "User"}
                </span>
                <span className="text-[11px] text-zinc-500 truncate max-w-[120px]">
                  {user?.email ?? "user@lantern.dev"}
                </span>
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-500" />
            </>
          )}
        </button>

        {/* Dropdown menu */}
        {showMenu && (
          <div className="modal-content absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-zinc-800 bg-surface-2 shadow-xl">
            <div className="px-3 py-2.5">
              <p className="text-xs font-medium text-zinc-300">
                {user?.email ?? "demo@lantern.dev"}
              </p>
              <p className="text-[11px] text-zinc-500">
                {user?.role ?? "owner"}
              </p>
            </div>
            <div className="border-t border-zinc-800">
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
