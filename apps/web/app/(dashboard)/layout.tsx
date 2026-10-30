"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import clsx from "clsx";
import { AlertTriangle, BookOpen, LogOut, Settings, Sparkles, User } from "lucide-react";
import { Sidebar } from "@/components/sidebar";
import { Notifications } from "@/components/notifications";
import { ThemeToggle } from "@/components/theme-toggle";
import { CommandPalette } from "@/components/command-palette";
import { DemoModeBanner } from "@/components/demo-mode-banner";
import { KioskTour, useKioskSession } from "@/components/kiosk-tour";
import { MobileNav } from "@/components/mobile-nav";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { PalMark } from "@/components/pal-mark";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import { openAsk } from "@/lib/ask-events";
import { MODE_HOME, MODE_LABEL } from "@/lib/workspace-nav";
import { useWorkspaceMode } from "@/lib/use-workspace-mode";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, logout, isDemoMode } = useAuth();
  const { isConfigured, loading: modelsLoading } = useModels();
  const { mode } = useWorkspaceMode();
  const kiosk = useKioskSession();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showUserMenu) return;
    const onClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowUserMenu(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [showUserMenu]);

  const signOut = async () => {
    setShowUserMenu(false);
    await logout();
    router.replace("/login");
  };

  return (
    // Runtime mode re-points the accent scale at indigo→cyan (globals.css
    // .theme-runtime) — one class flips every pal-* utility below it.
    <div data-mode={mode} className={clsx("flex h-screen overflow-hidden bg-surface-0", mode === "runtime" && "theme-runtime")}>
      <div className="hidden md:flex">
        <Sidebar />
      </div>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden pb-14 md:pb-0">
        <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 bg-surface-1 px-4 md:px-6">
          {/* Mobile: wordmark → this mode's home (sidebar is hidden under md). */}
          <Link href={MODE_HOME[mode]} aria-label="PAL home" className="flex items-center gap-2 md:hidden">
            <PalMark className="h-6 w-6" />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-50">PAL</span>
            <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-pal-400">{MODE_LABEL[mode]}</span>
          </Link>

          {/* Global command bar — opens ⌘K. Natural language welcome. */}
          <button
            type="button"
            onClick={() => openAsk()}
            aria-label="Ask PAL or search"
            className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-surface-2 text-zinc-500 transition-colors hover:border-zinc-700 hover:text-zinc-300 md:ml-0 md:w-full md:max-w-[480px] md:flex-1 md:justify-start md:px-3"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-pal-400" />
            <span className="hidden truncate text-xs md:inline">
              {mode === "pal" ? "Ask PAL — “what needs me today?”" : "Ask PAL — “why did my last run fail?”"}
            </span>
            <kbd className="ml-auto hidden shrink-0 rounded border border-zinc-700 bg-surface-3 px-1 text-[11px] font-medium md:inline-block">⌘K</kbd>
          </button>

          <div className="flex shrink-0 items-center gap-2 md:ml-auto">
            <ThemeToggle />
            <Notifications />
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label="Account"
                aria-haspopup="menu"
                aria-expanded={showUserMenu}
                className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-surface-2 p-1 transition-colors hover:border-zinc-700 lg:pr-2.5"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-pal-400 text-[11px] font-bold text-on-flame">
                  {user?.name ? user.name.charAt(0).toUpperCase() : <User className="h-3 w-3" />}
                </span>
                <span className="hidden max-w-[140px] truncate text-[12px] font-medium text-zinc-200 lg:inline">
                  {user?.name || user?.email || "Account"}
                </span>
              </button>
              {showUserMenu && (
                <div role="menu" className="modal-content absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-800 bg-surface-1 shadow-2xl">
                  <div className="border-b border-zinc-800 px-4 py-3">
                    <p className="truncate text-sm font-medium text-zinc-200">{user?.name || "Signed in"}</p>
                    <p className="truncate text-xs text-zinc-500">{user?.email}</p>
                    {isDemoMode && (
                      <span className="mt-1 inline-block rounded-full bg-pal-500/10 px-2 py-0.5 text-[11px] text-pal-400">demo mode</span>
                    )}
                  </div>
                  <div className="py-1">
                    <button
                      role="menuitem"
                      onClick={() => { setShowUserMenu(false); router.push("/settings"); }}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-zinc-300 hover:bg-surface-3"
                    >
                      <Settings className="h-3.5 w-3.5 text-zinc-500" /> Settings
                    </button>
                    <a
                      role="menuitem"
                      href="https://github.com/dshakes/pal#readme"
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setShowUserMenu(false)}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-zinc-300 hover:bg-surface-3"
                    >
                      <BookOpen className="h-3.5 w-3.5 text-zinc-500" /> Documentation
                    </a>
                  </div>
                  <div className="border-t border-zinc-800 py-1">
                    <button
                      role="menuitem"
                      onClick={signOut}
                      className="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-red-400 hover:bg-red-500/10"
                    >
                      <LogOut className="h-3.5 w-3.5" /> Sign out
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        <DemoModeBanner />
        <KioskTour />

        {!kiosk && !modelsLoading && !isConfigured && (
          <div className="flex items-center gap-3 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2.5 md:px-6">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-sm text-amber-300">Add a model provider key to turn on PAL’s AI features.</p>
            <Link
              href="/settings?tab=providers"
              className="ml-auto shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/20"
            >
              Add key
            </Link>
          </div>
        )}

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="page-enter flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
        </main>
      </div>

      <CommandPalette />
      <MobileNav />
      <KeyboardShortcuts />
    </div>
  );
}
