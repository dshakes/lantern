"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Notifications } from "@/components/notifications";
import { CommandPalette } from "@/components/command-palette";
import { DemoModeBanner } from "@/components/demo-mode-banner";
import { MobileNav } from "@/components/mobile-nav";
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
        {/* Top bar */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-800 bg-surface-1 px-6">
          {/* Left: Breadcrumbs */}
          <Breadcrumbs />

          {/* Right: Search hint, Notifications, User avatar */}
          <div className="flex items-center gap-2">
            {/* Search shortcut hint */}
            <button
              onClick={() => {
                // Trigger Cmd+K programmatically
                window.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "k",
                    metaKey: true,
                    bubbles: true,
                  }),
                );
              }}
              className="hidden sm:flex items-center gap-2 rounded-lg border border-zinc-800 bg-surface-2 px-2.5 py-1 text-xs text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-400"
            >
              <Search className="h-3 w-3" />
              <span>Search</span>
              <kbd className="ml-1 rounded border border-zinc-700 bg-surface-3 px-1 text-[10px] font-medium">
                &#8984;K
              </kbd>
            </button>

            {/* Notifications */}
            <Notifications />

            {/* User avatar + dropdown */}
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3 transition-colors hover:bg-surface-4"
              >
                {user?.name ? (
                  <span className="text-[10px] font-semibold text-zinc-300 uppercase">
                    {user.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                  </span>
                ) : (
                  <User className="h-3.5 w-3.5 text-zinc-400" />
                )}
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
    </div>
  );
}
