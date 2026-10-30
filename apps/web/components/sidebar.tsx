"use client";
// Dashboard sidebar — two home spaces behind one switch.
//
// ┌──────────────────────┐
// │ ◎ PAL      [⇤]       │
// │ [ ● pal | ● Runtime ]│  ← mode switch (re-skins the accent)
// │ [✨ Ask PAL…   ⌘K]   │
// │ Today / Holds / …    │  ← nav for the active mode (lib/workspace-nav)
// │ Recent agents        │  ← Runtime only
// ├──────────────────────┤
// │ ⚙ Settings           │
// │ [avatar] name   ⇅    │
// └──────────────────────┘
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronsUpDown, LogOut, PanelLeft, PanelLeftClose, Plus, Settings, Sparkles, BookOpen } from "lucide-react";
import { PalMark } from "@/components/pal-mark";
import { ModeSwitch } from "@/components/mode-switch";
import { navIcon } from "@/components/nav-icon";
import { AgentAvatar } from "@/components/agent-avatar";
import { useAuth } from "@/lib/auth";
import { useAgents } from "@/lib/hooks";
import { openAsk } from "@/lib/ask-events";
import { NAV, allNavItems, isNavActive } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

const COLLAPSE_KEY = "pal-sidebar-collapsed";
const RECENT_AGENTS = 5;

export function Sidebar() {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { user, isDemoMode, logout } = useAuth();
  const { mode } = useWorkspaceMode();
  const [collapsed, setCollapsed] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleCollapsed = (v: boolean) => {
    setCollapsed(v);
    try {
      localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!showMenu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setShowMenu(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [showMenu]);

  const items = allNavItems(mode);

  return (
    <aside
      aria-label="Sidebar"
      className={clsx(
        "flex h-screen flex-col border-r border-zinc-800 bg-surface-1 transition-[width] duration-150",
        collapsed ? "w-16" : "w-64",
      )}
    >
      {/* Brand + collapse */}
      <div className={clsx("flex px-4 pt-4", collapsed ? "flex-col items-center gap-2" : "items-center gap-3")}>
        <Link href="/" aria-label="Home" className="group -mx-1 flex items-center gap-2.5 rounded-lg px-1 py-0.5 hover:bg-surface-3/60">
          <PalMark className="h-7 w-7 shrink-0" />
          {!collapsed && (
            <span className="flex flex-col leading-tight">
              <span className="text-base font-[680] tracking-[-0.02em] text-zinc-50">PAL</span>
              <span className="mc-micro-label">{user?.name ? `${user.name.split(" ")[0]}'s workspace` : "workspace"}</span>
            </span>
          )}
        </Link>
        {!collapsed && <span className="flex-1" />}
        {!collapsed && isDemoMode && (
          <span className="rounded-full bg-pal-500/10 px-2 py-0.5 text-[12px] font-medium text-pal-300">demo</span>
        )}
        <button
          onClick={() => toggleCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pal-400/50"
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-2 px-4 pt-4">
          <ModeSwitch />
          <button
            type="button"
            onClick={() => openAsk()}
            className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-surface-0 px-2.5 py-1.5 text-left text-[12px] text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300"
          >
            <Sparkles className="h-3.5 w-3.5 text-pal-400" />
            <span className="flex-1">Ask PAL…</span>
            <kbd className="rounded border border-zinc-700 bg-surface-2 px-1 font-mono text-[11px] text-zinc-500">⌘K</kbd>
          </button>
        </div>
      )}

      <nav aria-label={mode === "pal" ? "pal navigation" : "Runtime navigation"} className="mt-3 flex-1 overflow-y-auto px-2 pb-2">
        {NAV[mode].map((section, si) => (
          <div key={si} className={clsx(si > 0 && "mt-4")}>
            {section.title && !collapsed && (
              <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">{section.title}</p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.href}>
                  <NavLink
                    href={item.href}
                    label={item.label}
                    Icon={navIcon(item.icon)}
                    active={isNavActive(item, pathname, items)}
                    collapsed={collapsed}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {mode === "runtime" && <RecentAgents collapsed={collapsed} pathname={pathname} />}
      </nav>

      <div className="border-t border-zinc-800 px-2 py-2">
        <NavLink
          href="/settings"
          label="Settings"
          Icon={Settings}
          active={pathname === "/settings" || pathname.startsWith("/settings/")}
          collapsed={collapsed}
        />
      </div>

      {/* User chip */}
      <div className="relative border-t border-zinc-800 px-3 py-2.5" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          aria-haspopup="menu"
          aria-expanded={showMenu}
          aria-label="Account menu"
          className={clsx(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-100",
            collapsed && "justify-center px-0",
          )}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-zinc-300">
            {(user?.name ?? user?.email ?? "U").slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && (
            <>
              <span className="flex flex-1 flex-col items-start overflow-hidden">
                <span className="w-full truncate text-left text-[12px] font-medium text-zinc-200">{user?.name ?? "Signed in"}</span>
                <span className="w-full truncate text-left text-[12px] text-zinc-500">{user?.email ?? ""}</span>
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-600" />
            </>
          )}
        </button>
        {showMenu && (
          <div role="menu" className="modal-content absolute bottom-full left-3 right-3 z-50 mb-1 min-w-[200px] overflow-hidden rounded-lg border border-zinc-800 bg-surface-2 shadow-xl">
            <div className="px-3 py-2.5">
              <p className="truncate text-[12px] font-medium text-zinc-200">{user?.email}</p>
              <p className="text-[12px] text-zinc-500">{user?.role ?? "member"}</p>
            </div>
            <div className="border-t border-zinc-800">
              <a
                role="menuitem"
                href="https://github.com/dshakes/pal#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-surface-3"
              >
                <BookOpen className="h-3.5 w-3.5 text-zinc-500" /> Documentation
              </a>
            </div>
            <div className="border-t border-zinc-800">
              <button
                role="menuitem"
                onClick={async () => {
                  setShowMenu(false);
                  await logout();
                  router.replace("/login");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-500/10"
              >
                <LogOut className="h-3.5 w-3.5" /> Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function NavLink({
  href, label, Icon, active, collapsed,
}: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={clsx(
        "relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pal-400/50",
        active ? "bg-surface-3 text-zinc-50" : "text-zinc-400 hover:bg-surface-3/60 hover:text-zinc-100",
        collapsed && "justify-center px-0",
      )}
    >
      {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-pal-400" />}
      <Icon className={clsx("h-4 w-4 shrink-0", active && "text-pal-400")} />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

function RecentAgents({ collapsed, pathname }: { collapsed: boolean; pathname: string }) {
  const { agents, loading } = useAgents();
  const recent = useMemo(
    () => [...agents].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, RECENT_AGENTS),
    [agents],
  );
  if (collapsed || loading) return null;
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between px-2 pb-1">
        <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-600">Recent agents</p>
        <Link href="/agents/create" aria-label="New agent" className="rounded p-0.5 text-zinc-500 hover:bg-surface-3 hover:text-zinc-200">
          <Plus className="h-3.5 w-3.5" />
        </Link>
      </div>
      {recent.length === 0 ? (
        <p className="px-2 py-1 text-[12px] text-zinc-500">
          No agents yet.{" "}
          <Link href="/agents/create" className="text-pal-400 hover:text-pal-300">
            Create one
          </Link>
        </p>
      ) : (
        <ul className="space-y-0.5">
          {recent.map((a) => {
            const href = `/agents/${encodeURIComponent(a.name)}`;
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <li key={a.id}>
                <Link
                  href={href}
                  className={clsx(
                    "flex items-center gap-2 rounded-lg px-2 py-1 text-xs transition-colors",
                    active ? "bg-surface-3 text-zinc-50" : "text-zinc-400 hover:bg-surface-3/60 hover:text-zinc-100",
                  )}
                >
                  <AgentAvatar name={a.name} status={a.status === "active" ? "succeeded" : undefined} size="sm" />
                  <span className="truncate">{a.name}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
