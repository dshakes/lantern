"use client";

// Lantern dashboard sidebar — Claude-desktop minimalism.
//
// The unit of work is the agent. So the sidebar IS the agent list,
// the way Claude's sidebar IS the conversation list. There are no
// per-feature top-level destinations anymore (Runs / Channels /
// Budgets / etc.) — those live inside each agent's workspace under
// the AgentTabsBar.
//
// Layout:
//   ┌─────────────────────┐
//   │ Lantern        [⇇] │
//   │                     │
//   │ [+ New agent]       │
//   │ [⌕ Search    /]    │
//   │ ──────────────────  │
//   │ ● WA whatsapp…      │
//   │ ○ PA personal…      │
//   │ ● AA ai-recruiter…  │
//   │ ● ED email-digest…  │
//   │                     │
//   ├─────────────────────┤
//   │ ⓘ Activity          │
//   │ ⚙ Settings          │
//   ├─────────────────────┤
//   │ [avatar] admin…  ⇅ │
//   └─────────────────────┘

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Inbox,
  Settings,
  User,
  ChevronsUpDown,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Plug,
  MessageSquare,
  Search,
  Server,
  Smartphone,
  Zap,
} from "lucide-react";
import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { useAgents } from "@/lib/hooks";
import { AgentAvatar } from "@/components/agent-avatar";

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isDemoMode, logout } = useAuth();
  const { agents, loading } = useAgents();
  const [showMenu, setShowMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Sort agents most-recently-touched first so the active ones cluster at
  // top — same pattern Claude uses for recent conversations.
  const sortedAgents = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...agents]
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [agents, search]);

  // Scale gate: when NOT searching, the rail shows only the most-recent few —
  // the full roster is the /agents grid. Searching reveals every match.
  const AGENT_CAP = 7;
  const isSearching = search.trim().length > 0;
  const shownAgents = isSearching ? sortedAgents : sortedAgents.slice(0, AGENT_CAP);
  const hiddenCount = isSearching ? 0 : Math.max(0, sortedAgents.length - AGENT_CAP);

  // Click-outside for user menu.
  useEffect(() => {
    if (!showMenu) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [showMenu]);

  // `/` focuses the sidebar search when not in another input.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <aside
      className={clsx(
        "flex h-screen flex-col border-r border-zinc-800 bg-surface-1 transition-all duration-150",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Brand + collapse — the logo links straight to /agents (the workspace
          home). Standard webapp pattern: clicking the logo goes home. */}
      <div className={clsx("flex items-center px-4 pt-4", collapsed ? "justify-center" : "gap-3")}>
        <Link
          href="/agents"
          className={clsx(
            "group flex items-center gap-3 rounded-lg -mx-1 px-1 py-0.5 transition-colors duration-150 hover:bg-surface-3/60",
            collapsed && "mx-0 px-0"
          )}
          aria-label="Home"
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_4px_14px_-6px_rgba(56,189,248,0.5)] transition-transform duration-150 group-hover:scale-105">
            <svg width="18" height="18" viewBox="0 0 26 26" fill="none" aria-hidden="true">
              <defs>
                <linearGradient id="lantern-mark" x1="3" y1="3" x2="23" y2="23" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#2dd4bf" />
                  <stop offset="0.5" stopColor="#38bdf8" />
                  <stop offset="1" stopColor="#818cf8" />
                </linearGradient>
              </defs>
              <rect x="6.5" y="6.5" width="13" height="13" rx="3" transform="rotate(45 13 13)" fill="url(#lantern-mark)" />
              <rect x="10.5" y="10.5" width="5" height="5" rx="1.5" transform="rotate(45 13 13)" fill="#0d0d12" opacity="0.85" />
            </svg>
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="font-[680] text-base tracking-[-0.02em] text-zinc-50">Lantern</span>
              <span className="mc-micro-label">
                {user?.name ? `${user.name.split(" ")[0]}'s workspace` : "workspace"}
              </span>
            </div>
          )}
        </Link>
        {!collapsed && (
          <>
            <span className="flex-1" />
            {isDemoMode && (
              <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-[11px] font-medium text-lantern-300">
                demo
              </span>
            )}
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-md p-1 text-zinc-500 transition-colors duration-150 hover:bg-surface-3 hover:text-zinc-300"
              title="Collapse"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="absolute left-4 top-14 rounded-md p-1 text-zinc-500 transition-colors duration-150 hover:bg-surface-3 hover:text-zinc-300"
            title="Expand"
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {/* New agent — primary action, always visible. */}
          <div className="px-4 pt-4">
            <Link
              href="/agents/create"
              className="group flex w-full items-center gap-2 rounded-xl bg-[linear-gradient(135deg,#2dd4bf,#38bdf8_50%,#818cf8)] px-3 py-2 text-xs font-semibold text-[#04121a] shadow-[0_6px_20px_-8px_rgba(56,189,248,0.55)] transition-transform duration-150 hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1"
            >
              <Plus className="h-4 w-4 transition-transform duration-150 group-hover:rotate-90" />
              New agent
            </Link>
          </div>

          {/* Search */}
          <div className="px-4 pt-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agents…"
                className="w-full rounded-lg border border-zinc-800 bg-surface-0 py-1.5 pl-8 pr-7 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none transition-colors duration-150 focus:border-lantern-500/40"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-zinc-700 bg-surface-2 px-1 font-mono text-[11px] text-zinc-500">
                /
              </kbd>
            </div>
          </div>
        </>
      )}

      {/* Agent list — the primary nav. */}
      <nav className={clsx("mt-3 flex-1 overflow-y-auto", collapsed ? "px-2" : "px-2")}>
        {!collapsed && (
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-600">
            Agents
            {agents.length > 0 && <span className="ml-2 text-zinc-700">{agents.length}</span>}
          </p>
        )}
        {loading ? (
          <div className="space-y-1 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-2/50" />
            ))}
          </div>
        ) : sortedAgents.length === 0 ? (
          !collapsed && (
            <p className="px-2 py-1 text-[11px] text-zinc-500">
              No agents yet. <Link href="/agents/create" className="text-lantern-400 hover:text-lantern-300">Create one →</Link>
            </p>
          )
        ) : (
          <ul className="space-y-0.5">
            {shownAgents.map((agent) => {
              const href = `/agents/${encodeURIComponent(agent.name)}`;
              const isActive = pathname === href || pathname.startsWith(href + "/");
              return (
                <li key={agent.id}>
                  <Link
                    href={href}
                    className={clsx(
                      "group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
                      isActive
                        ? "bg-surface-3 text-zinc-100"
                        : "text-zinc-400 hover:bg-surface-3/60 hover:text-zinc-100",
                      collapsed && "justify-center px-0"
                    )}
                    title={collapsed ? agent.name : undefined}
                  >
                    <AgentAvatar
                      name={agent.name}
                      status={agent.status === "active" ? "succeeded" : undefined}
                      size="sm"
                    />
                    {!collapsed && (
                      <span className="truncate text-xs font-medium">
                        {agent.name}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
            {/* Scale gate: the sidebar shows recent agents only; the full,
                searchable roster lives on /agents. Keeps the rail usable at 50+. */}
            {!collapsed && hiddenCount > 0 && (
              <li>
                <Link
                  href="/agents"
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs font-medium text-lantern-400 transition-colors hover:bg-surface-3/60 hover:text-lantern-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-md border border-lantern-500/30 text-[10px] tabular-nums">+{hiddenCount}</span>
                  View all {agents.length} agents
                </Link>
              </li>
            )}
          </ul>
        )}
      </nav>

      {/* Secondary destinations. Connectors is workspace-level — connect
          once, every agent can use them — so it sits alongside Activity
          and Settings rather than buried in a menu. */}
      <div className="border-t border-zinc-800 px-2 py-2">
        <SecondaryLink
          href="/inbox"
          icon={Inbox}
          label="Activity"
          collapsed={collapsed}
          active={pathname === "/inbox"}
        />
        {/* Personal — WhatsApp-personal-assistant mode. Distinct product
            surface from Agents (scheduled automation) and Channels (agent
            delivery targets). The mental model: Personal is "you on
            WhatsApp", with voice/auto-reply/groups/contacts as the
            tunables. */}
        <SecondaryLink
          href="/personal"
          icon={Smartphone}
          label="Personal"
          collapsed={collapsed}
          active={pathname === "/personal" || pathname.startsWith("/personal/")}
        />
        <SecondaryLink
          href="/automations"
          icon={Zap}
          label="Automations"
          collapsed={collapsed}
          active={pathname === "/automations" || pathname.startsWith("/automations/")}
        />
        <SecondaryLink
          href="/runtime"
          icon={Server}
          label="Runtime"
          collapsed={collapsed}
          active={pathname === "/runtime" || pathname.startsWith("/runtime/")}
        />
        <SecondaryLink
          href="/surfaces"
          icon={MessageSquare}
          label="Channels"
          collapsed={collapsed}
          active={pathname === "/surfaces" || pathname.startsWith("/surfaces/")}
        />
        <SecondaryLink
          href="/connectors"
          icon={Plug}
          label="Connectors"
          collapsed={collapsed}
          active={pathname === "/connectors" || pathname.startsWith("/connectors/")}
        />
        <SecondaryLink
          href="/settings"
          icon={Settings}
          label="Settings"
          collapsed={collapsed}
          active={pathname === "/settings" || pathname.startsWith("/settings/")}
        />
      </div>

      {/* User chip */}
      <div className="relative border-t border-zinc-800 px-3 py-2.5" ref={menuRef}>
        <button
          onClick={() => setShowMenu(!showMenu)}
          className={clsx(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs text-zinc-400 transition-colors duration-150 hover:bg-surface-3 hover:text-zinc-100",
            collapsed && "justify-center px-0"
          )}
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-zinc-300">
            {(user?.name ?? "U").slice(0, 1).toUpperCase()}
          </div>
          {!collapsed && (
            <>
              <div className="flex flex-1 flex-col items-start overflow-hidden">
                <span className="truncate text-[11px] font-medium text-zinc-200">
                  {user?.name ?? "User"}
                </span>
                <span className="truncate text-[11px] text-zinc-500">
                  {user?.email ?? "user@lantern.dev"}
                </span>
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-600" />
            </>
          )}
        </button>

        {showMenu && (
          <div className="modal-content absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-zinc-800 bg-surface-2 shadow-xl">
            <div className="px-3 py-2.5">
              <p className="text-[11px] font-medium text-zinc-200">{user?.email ?? "user@lantern.dev"}</p>
              <p className="text-[11px] text-zinc-500">{user?.role ?? "owner"}</p>
            </div>
            <div className="border-t border-zinc-800">
              <Link
                href="/evaluations"
                onClick={() => setShowMenu(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-300 transition-colors duration-150 hover:bg-surface-3"
              >
                Analytics
              </Link>
              <Link
                href="/marketplace"
                onClick={() => setShowMenu(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-300 transition-colors duration-150 hover:bg-surface-3"
              >
                Templates
              </Link>
            </div>
            <div className="border-t border-zinc-800">
              <button
                onClick={() => {
                  logout();
                  router.push("/login");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-400 transition-colors duration-150 hover:bg-red-500/10"
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

function SecondaryLink({
  href,
  icon: Icon,
  label,
  active,
  collapsed,
}: {
  href: string;
  icon: typeof Inbox;
  label: string;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lantern-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-1",
        active
          ? "bg-surface-3 text-zinc-100"
          : "text-zinc-400 hover:bg-surface-3/60 hover:text-zinc-100",
        collapsed && "justify-center px-0"
      )}
      title={collapsed ? label : undefined}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span>{label}</span>}
    </Link>
  );
}
