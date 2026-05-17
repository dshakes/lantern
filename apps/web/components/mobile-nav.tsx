"use client";

// MobileNav — bottom nav bar that replaces the sidebar under md (640px).
// Renders only the four primary destinations; everything else is reached
// via in-page links or the command palette.
//
// Why bottom not top: a phone user's thumb. Top tabs on mobile feel like
// "this is a desktop site we shrunk." Bottom feels native.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bot, Inbox, Plus, Settings } from "lucide-react";
import clsx from "clsx";

// Four destinations on mobile, mirroring the desktop sidebar's
// minimalist structure: Agents (the unit), New (primary action),
// Activity (Inbox), Settings.
const PRIMARY = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/agents/create", label: "New", icon: Plus },
  { href: "/inbox", label: "Activity", icon: Inbox },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <nav
      aria-label="Primary navigation"
      className={clsx(
        // md:hidden hides this entirely on >=640px so the desktop sidebar takes over.
        "fixed inset-x-0 bottom-0 z-40 md:hidden",
        // Safe-area on iOS notch phones.
        "pb-[env(safe-area-inset-bottom)]",
        "border-t border-zinc-800 bg-surface-1/95 backdrop-blur-md"
      )}
    >
      <div className="flex h-14 items-stretch justify-around">
        {PRIMARY.map((item) => {
          const Icon = item.icon;
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => {
                // Haptic on supported devices — cheap, ignored elsewhere.
                if ("vibrate" in navigator) navigator.vibrate?.(8);
                router.prefetch(item.href);
              }}
              aria-current={isActive ? "page" : undefined}
              className={clsx(
                "relative flex flex-1 flex-col items-center justify-center gap-0.5 transition-colors duration-150",
                isActive ? "text-lantern-300" : "text-zinc-500 active:text-zinc-200"
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
              {isActive && (
                <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-lantern-400" />
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
