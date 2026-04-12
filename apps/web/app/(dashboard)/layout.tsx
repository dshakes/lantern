"use client";

import { Sidebar } from "@/components/sidebar";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { Notifications } from "@/components/notifications";
import { CommandPalette } from "@/components/command-palette";
import { User, Search, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useModels } from "@/lib/model-context";
import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const { isConfigured, loading: modelsLoading } = useModels();

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
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

            {/* User avatar */}
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3">
              <User className="h-3.5 w-3.5 text-zinc-400" />
            </div>
          </div>
        </header>

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
    </div>
  );
}
