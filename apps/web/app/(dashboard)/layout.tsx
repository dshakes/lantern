"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Notifications } from "@/components/notifications";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandPalette } from "@/components/command-palette";
import { DemoModeBanner } from "@/components/demo-mode-banner";
import { MobileNav } from "@/components/mobile-nav";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { User, Search, AlertTriangle, Settings, LogOut, HelpCircle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const { user, logout, isDemoMode } = useAuth();
  const { isConfigured, loading: modelsLoading } = useModels();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showUserMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowUserMenu(false); };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("mousedown", handleClick); document.removeEventListener("keydown", handleKey); };
  }, [showUserMenu]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar — hidden on mobile in favor of bottom nav. */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <div className="flex flex-1 flex-col overflow-hidden pb-14 md:pb-0">
        {/* Top bar — command bar: search left, notifications + user chip right.
            `mc-glass` gives the faint top-highlight gradient line the mock calls for. */}
        <header className="mc-glass relative flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 bg-surface-1 px-4 md:px-6">
          {/* Mobile: Lantern wordmark → home (sidebar is hidden under md). */}
          <Link href="/agents" aria-label="Lantern — home" className="flex items-center gap-2 md:hidden">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-lantern-500 text-[13px] font-bold text-white">L</span>
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">Lantern</span>
          </Link>

          {/* Global search — opens the existing command palette. CommandPalette
              listens for its own Cmd+K keydown, so we just replay that event
              rather than adding a second "open" mechanism. Collapses to an
              icon-only square under md (no room next to the mobile wordmark). */}
          <button
            onClick={() => {
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
              );
            }}
            aria-label="Search agents, runs, actions"
            className="flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-surface-2 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300 md:w-full md:max-w-[440px] md:flex-1 md:justify-start md:px-3"
          >
            <Search className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden truncate text-xs md:inline">Search agents, runs, actions…</span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-zinc-700 bg-surface-3 px-1 text-[10px] font-medium md:inline-block">
              &#8984;K
            </kbd>
          </button>

          {/* Right: Notifications, user chip.
              `ml-auto` keeps this pinned to the right. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Theme toggle */}
            <ThemeToggle />
            {/* Notifications */}
            <Notifications />

            {/* User chip + dropdown */}
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-surface-2 py-1 pl-1 pr-2.5 transition-colors hover:border-zinc-700"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[linear-gradient(135deg,#2dd4bf,#38bdf8_50%,#818cf8)] text-[10px] font-bold text-zinc-950">
                  {user?.name ? user.name.charAt(0).toUpperCase() : <User className="h-3 w-3" />}
                </span>
                <span className="hidden flex-col items-start leading-tight sm:flex">
                  <span className="max-w-[140px] truncate text-[11px] font-medium text-zinc-200">
                    {user?.name || "User"}
                  </span>
                  <span className="max-w-[140px] truncate text-[11px] text-zinc-500">
                    {user?.email || "user@lantern.dev"}
                  </span>
                </span>
              </button>
              {showUserMenu && (
                <div className="modal-content absolute right-0 top-full mt-2 w-56 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 shadow-2xl z-50">
                  <div className="border-b border-zinc-800 px-4 py-3">
                    <p className="text-sm font-medium text-zinc-200 truncate">{user?.name || "User"}</p>
                    <p className="text-xs text-zinc-500 truncate">{user?.email || "user@lantern.dev"}</p>
                    {isDemoMode && (
                      <span className="mt-1 inline-block rounded-full bg-lantern-500/10 px-2 py-0.5 text-[10px] text-lantern-400">demo mode</span>
                    )}
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { setShowUserMenu(false); router.push("/settings"); }}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-surface-3"
                    >
                      <Settings className="h-3.5 w-3.5 text-zinc-500" />
                      Settings
                    </button>
                    <a
                      href="https://github.com/dshakes/lantern"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-surface-3"
                    >
                      <HelpCircle className="h-3.5 w-3.5 text-zinc-500" />
                      Documentation
                    </a>
                  </div>
                  <div className="border-t border-zinc-800 py-1">
                    <button
                      onClick={() => { logout(); router.push("/login"); }}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                    >
                      <LogOut className="h-3.5 w-3.5" />
                      Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* "Some data is simulated" banner — fires when api.ts catches fall
            back to mock data so the dashboard never silently lies. */}
        <DemoModeBanner />

        {/* LLM Provider banner */}
        {!modelsLoading && !isConfigured && (
          <div className="flex items-center gap-3 border-b border-amber-500/20 bg-amber-500/5 px-6 py-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-sm text-amber-300">
              Configure an LLM provider to unlock AI features.
            </p>
            <Link
              href="/settings"
              className="ml-auto shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
            >
              Go to Settings
            </Link>
          </div>
        )}

        {/* Main content with page transition */}
        <main className="flex flex-1 flex-col overflow-hidden">
          <div className="page-enter flex flex-1 flex-col overflow-hidden">
            {children}
          </div>
        </main>
      </div>

      {/* Command palette (rendered at root) */}
      <CommandPalette />

      {/* Mobile bottom nav — only visible <md. */}
      <MobileNav />

      {/* Global keyboard shortcuts: `g <key>` go-to combos, `?` cheat sheet. */}
      <KeyboardShortcuts />
    </div>
  );
}
