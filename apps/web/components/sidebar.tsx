"use client";

// Lantern dashboard sidebar.
//
// Information architecture (post-W6):
//   Primary  -- the four daily-driver destinations:
//                 Inbox · Agents · Analytics · Settings
//   Workspace -- expandable section for less-frequent destinations
//                (Runs, Surfaces, Connectors, Deployments, Budgets,
//                Experiments, Eval Suites, Marketplace) that will
//                eventually fold into per-agent tabs.
//
// The Workspace section stays available so deep links + bookmarks keep
// working while individual pages get pulled inside the agent shell. As
// each one migrates, its entry can be removed from this list.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot,
  Inbox,
  Settings,
  User,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Play,
  MessageSquare,
  Plug,
  Cloud,
  Shield,
  FlaskConical,
  BookCheck,
  Store,
  BarChart3,
} from "lucide-react";
import clsx from "clsx";
import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth";

// Primary nav — the four destinations a daily user lives in.
const primaryNav = [
  { href: "/inbox", label: "Inbox", icon: Inbox, shortcut: "1" },
  { href: "/agents", label: "Agents", icon: Bot, shortcut: "2" },
  { href: "/evaluations", label: "Analytics", icon: BarChart3, shortcut: "3" },
  { href: "/settings", label: "Settings", icon: Settings, shortcut: "4" },
] as const;

// Workspace nav — everything that's still real and reachable but no
// longer competes for the daily-driver top slot. Will collapse into
// per-agent tabs over time; for now this is the bridge.
const workspaceNav = [
  { href: "/runs", label: "Runs", icon: Play },
  { href: "/surfaces", label: "Channels", icon: MessageSquare },
  { href: "/connectors", label: "Integrations", icon: Plug },
  { href: "/deployments", label: "Deployments", icon: Cloud },
  { href: "/budgets", label: "Budgets", icon: Shield },
  { href: "/experiments", label: "Experiments", icon: FlaskConical },
  { href: "/eval-suites", label: "Eval Suites", icon: BookCheck },
  { href: "/marketplace", label: "Marketplace", icon: Store },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isDemoMode, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // The Workspace section auto-expands when the user is currently on one
  // of its routes, so we don't strand them inside a closed accordion.
  const [workspaceOpen, setWorkspaceOpen] = useState(() =>
    workspaceNav.some((n) => pathname === n.href || pathname.startsWith(n.href + "/"))
  );
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

  // Keyboard shortcuts: 1-4 for the primary destinations.
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
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const match = primaryNav.find((n) => n.shortcut === e.key);
      if (match) {
        e.preventDefault();
        router.push(match.href);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [router]);

  const navLink = (
    href: string,
    label: string,
    Icon: typeof Bot,
    shortcut?: string
  ) => {
    const isActive = pathname === href || pathname.startsWith(href + "/");
    return (
      <Link
        key={href}
        href={href}
        className={clsx(
          "sidebar-item",
          isActive && "active",
          collapsed && "justify-center px-0",
        )}
        title={collapsed ? label : undefined}
      >
        <Icon className="h-4.5 w-4.5 shrink-0" />
        {!collapsed && (
          <>
            <span className="flex-1">{label}</span>
            {shortcut && (
              <kbd className="hidden xl:inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-zinc-800 bg-surface-2 px-1 text-[10px] font-medium text-zinc-600">
                {shortcut}
              </kbd>
            )}
          </>
        )}
      </Link>
    );
  };

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

      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <div className="space-y-1">
          {primaryNav.map((item) => navLink(item.href, item.label, item.icon, item.shortcut))}
        </div>

        {/* Workspace section — collapsed by default, auto-opens when the
            user is on one of its pages. Hidden entirely in collapsed
            sidebar mode (icon-only) since the section header doesn't
            make sense there. */}
        {!collapsed && (
          <>
            <button
              onClick={() => setWorkspaceOpen((v) => !v)}
              className="mt-5 flex w-full items-center gap-1.5 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600 transition-colors hover:text-zinc-400"
            >
              {workspaceOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              Workspace
            </button>
            {workspaceOpen && (
              <div className="mt-1 space-y-1">
                {workspaceNav.map((item) => navLink(item.href, item.label, item.icon))}
              </div>
            )}
          </>
        )}

        {collapsed &&
          workspaceNav.map((item) => navLink(item.href, item.label, item.icon))}
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
