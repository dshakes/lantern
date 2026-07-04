"use client";

// MobileNav — bottom nav bar that replaces the sidebar under md.
// Four primary tabs + a "More" sheet that reaches EVERY other destination, so
// nothing in the desktop sidebar (Runtime, Automations, Personal, Channels, …)
// is unreachable on a phone.
//
// Why bottom not top: a phone user's thumb. Bottom feels native.

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bot, Inbox, Plus, Menu, Settings, Server, Zap, Smartphone, MessageSquare,
  Plug, BarChart3, Store, Rocket, DollarSign, X,
} from "lucide-react";
import clsx from "clsx";

const PRIMARY = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/inbox", label: "Activity", icon: Inbox },
  { href: "/agents/create", label: "New", icon: Plus },
] as const;

// Everything else, reachable from the More sheet.
const MORE = [
  { href: "/personal", label: "Personal", icon: Smartphone },
  { href: "/automations", label: "Automations", icon: Zap },
  { href: "/runtime", label: "Runtime", icon: Server },
  { href: "/surfaces", label: "Channels", icon: MessageSquare },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/evaluations", label: "Analytics", icon: BarChart3 },
  { href: "/deployments", label: "Deployments", icon: Rocket },
  { href: "/budgets", label: "Budgets", icon: DollarSign },
  { href: "/marketplace", label: "Marketplace", icon: Store },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);

  // Close the sheet on route change + lock body scroll while open.
  useEffect(() => { setMoreOpen(false); }, [pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [moreOpen]);

  const tap = (href: string) => {
    if ("vibrate" in navigator) navigator.vibrate?.(8);
    router.prefetch(href);
  };

  const moreActive = MORE.some((m) => pathname === m.href || pathname.startsWith(m.href + "/"));

  return (
    <>
      {/* More sheet */}
      {moreOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="More destinations">
          <button
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-safe:animate-[fadeIn_.15s_ease]"
            onClick={() => setMoreOpen(false)}
          />
          <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-zinc-800 bg-surface-1 pb-[env(safe-area-inset-bottom)] motion-safe:animate-[slideUp_.2s_ease]">
            <div className="flex items-center justify-between px-5 pb-2 pt-3">
              <span className="text-sm font-semibold text-zinc-100">Go to</span>
              <button onClick={() => setMoreOpen(false)} className="rounded-md p-1.5 text-zinc-500 active:text-zinc-200" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1 px-3 pb-5">
              {MORE.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(item.href + "/");
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => tap(item.href)}
                    aria-current={active ? "page" : undefined}
                    className={clsx(
                      "flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-xl p-2 text-center transition-colors",
                      active ? "bg-lantern-500/10 text-lantern-300" : "text-zinc-400 active:bg-surface-2",
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="text-[11px] font-medium leading-tight">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-surface-1/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
      >
        <div className="flex h-14 items-stretch justify-around">
          {PRIMARY.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => tap(item.href)}
                aria-current={isActive ? "page" : undefined}
                className={clsx(
                  "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
                  isActive ? "text-lantern-300" : "text-zinc-500 active:text-zinc-200",
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{item.label}</span>
                {isActive && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-lantern-400" />}
              </Link>
            );
          })}
          <button
            onClick={() => { if ("vibrate" in navigator) navigator.vibrate?.(8); setMoreOpen(true); }}
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            className={clsx(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
              moreActive || moreOpen ? "text-lantern-300" : "text-zinc-500 active:text-zinc-200",
            )}
          >
            <Menu className="h-5 w-5" />
            <span className="text-[10px] font-medium">More</span>
            {moreActive && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-lantern-400" />}
          </button>
        </div>
      </nav>
    </>
  );
}
