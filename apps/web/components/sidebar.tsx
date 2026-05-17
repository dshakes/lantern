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
  Search,
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
        "flex h-screen flex-col border-r border-zinc-800 bg-surface-1 transition-all duration-(--motion-fast)",
        collapsed ? "w-16" : "w-64"
      )}
    >
      {/* Brand + collapse — the brand block is a Link to "/", which
          re-routes to the most-recent agent. Standard webapp pattern:
          clicking the logo goes home. */}
      <div className={clsx("flex items-center px-4 pt-4", collapsed ? "justify-center" : "gap-3")}>
        <Link
          href="/"
          className={clsx(
            "group flex items-center gap-3 rounded-(--radius-md) -mx-1 px-1 py-0.5 transition-colors duration-(--motion-fast) hover:bg-surface-3/60",
            collapsed && "mx-0 px-0"
          )}
          aria-label="Home"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-(--elev-2) transition-transform duration-(--motion-fast) group-hover:scale-105">
            <span className="text-(--text-sm) font-bold text-white leading-none">L</span>
          </div>
          {!collapsed && (
            <span className="text-(--text-md) font-semibold tracking-tight text-white">Lantern</span>
          )}
        </Link>
        {!collapsed && (
          <>
            <span className="flex-1" />
            {isDemoMode && (
              <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-(--text-xs) font-medium text-lantern-300">
                demo
              </span>
            )}
            <button
              onClick={() => setCollapsed(true)}
              className="rounded-md p-1 text-zinc-500 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-300"
              title="Collapse"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            className="absolute left-4 top-14 rounded-md p-1 text-zinc-500 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-300"
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
              className="group flex w-full items-center gap-2 rounded-(--radius-md) border border-lantern-500/30 bg-lantern-500/10 px-3 py-2 text-(--text-sm) font-medium text-lantern-200 transition-all duration-(--motion-fast) hover:border-lantern-500/50 hover:bg-lantern-500/15 hover:shadow-(--elev-1)"
            >
              <Plus className="h-4 w-4 transition-transform duration-(--motion-fast) group-hover:rotate-90" />
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
                className="w-full rounded-(--radius-md) border border-zinc-800 bg-surface-0 py-1.5 pl-8 pr-7 text-(--text-xs) text-zinc-200 placeholder:text-zinc-600 outline-none transition-colors duration-(--motion-fast) focus:border-lantern-500/40"
              />
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-(--radius-sm) border border-zinc-700 bg-surface-2 px-1 font-mono text-(--text-xs) text-zinc-500">
                /
              </kbd>
            </div>
          </div>
        </>
      )}

      {/* Agent list — the primary nav. */}
      <nav className={clsx("mt-3 flex-1 overflow-y-auto", collapsed ? "px-2" : "px-2")}>
        {!collapsed && (
          <p className="px-2 pb-1 text-(--text-xs) font-medium uppercase tracking-wider text-zinc-600">
            Agents
            {agents.length > 0 && <span className="ml-2 text-zinc-700">{agents.length}</span>}
          </p>
        )}
        {loading ? (
          <div className="space-y-1 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-9 animate-pulse rounded-(--radius-md) bg-surface-2/50" />
            ))}
          </div>
        ) : sortedAgents.length === 0 ? (
          !collapsed && (
            <p className="px-2 py-1 text-(--text-xs) text-zinc-500">
              No agents yet. <Link href="/agents/create" className="text-lantern-400 hover:text-lantern-300">Create one →</Link>
            </p>
          )
        ) : (
          <ul className="space-y-0.5">
            {sortedAgents.map((agent) => {
              const href = `/agents/${encodeURIComponent(agent.name)}`;
              const isActive = pathname === href || pathname.startsWith(href + "/");
              return (
                <li key={agent.id}>
                  <Link
                    href={href}
                    className={clsx(
                      "group flex items-center gap-2 rounded-(--radius-md) px-2 py-1.5 transition-colors duration-(--motion-fast)",
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
                      <span className="truncate text-(--text-sm) font-medium">
                        {agent.name}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      {/* Secondary destinations — Activity (Inbox) + Settings. */}
      <div className="border-t border-zinc-800 px-2 py-2">
        <SecondaryLink
          href="/inbox"
          icon={Inbox}
          label="Activity"
          collapsed={collapsed}
          active={pathname === "/inbox"}
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
            "flex w-full items-center gap-2.5 rounded-(--radius-md) px-2 py-1.5 text-(--text-sm) text-zinc-400 transition-colors duration-(--motion-fast) hover:bg-surface-3 hover:text-zinc-100",
            collapsed && "justify-center px-0"
          )}
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-(--text-xs) font-semibold text-zinc-300">
            {(user?.name ?? "U").slice(0, 1).toUpperCase()}
          </div>
          {!collapsed && (
            <>
              <div className="flex flex-1 flex-col items-start overflow-hidden">
                <span className="truncate text-(--text-xs) font-medium text-zinc-200">
                  {user?.name ?? "User"}
                </span>
                <span className="truncate text-(--text-xs) text-zinc-500">
                  {user?.email ?? "user@lantern.dev"}
                </span>
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-600" />
            </>
          )}
        </button>

        {showMenu && (
          <div className="modal-content absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-(--radius-md) border border-zinc-800 bg-surface-2 shadow-(--elev-3)">
            <div className="px-3 py-2.5">
              <p className="text-(--text-xs) font-medium text-zinc-200">{user?.email ?? "user@lantern.dev"}</p>
              <p className="text-(--text-xs) text-zinc-500">{user?.role ?? "owner"}</p>
            </div>
            <div className="border-t border-zinc-800">
              <Link
                href="/evaluations"
                onClick={() => setShowMenu(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-(--text-sm) text-zinc-300 transition-colors duration-(--motion-fast) hover:bg-surface-3"
              >
                Analytics
              </Link>
              <Link
                href="/marketplace"
                onClick={() => setShowMenu(false)}
                className="flex w-full items-center gap-2 px-3 py-2 text-(--text-sm) text-zinc-300 transition-colors duration-(--motion-fast) hover:bg-surface-3"
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
                className="flex w-full items-center gap-2 px-3 py-2 text-(--text-sm) text-red-400 transition-colors duration-(--motion-fast) hover:bg-red-500/10"
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
        "flex items-center gap-2.5 rounded-(--radius-md) px-2 py-1.5 text-(--text-sm) font-medium transition-colors duration-(--motion-fast)",
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
