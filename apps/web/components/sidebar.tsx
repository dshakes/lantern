"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bot, Play, Sparkles, MessageSquare, Plug, Cloud, Settings, User, ChevronsUpDown, LogOut } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { useAuth } from "@/lib/auth";

const navItems = [
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/runs", label: "Runs", icon: Play },
  { href: "/playground", label: "Playground", icon: Sparkles },
  { href: "/surfaces", label: "Surfaces", icon: MessageSquare },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/deployments", label: "Deployments", icon: Cloud },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isDemoMode, logout } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  return (
    <aside className="flex h-screen w-64 flex-col border-r border-zinc-800 bg-surface-1">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-lantern-400 to-lantern-600 shadow-lg shadow-lantern-500/20">
          <span className="text-base font-bold text-white leading-none">L</span>
        </div>
        <span className="text-lg font-semibold tracking-[-0.02em] text-white">Lantern</span>
        {isDemoMode && (
          <span className="rounded-full bg-lantern-500/10 px-2 py-0.5 text-[10px] font-medium text-lantern-400">
            demo
          </span>
        )}
      </div>

      <nav className="flex-1 space-y-1 px-3 py-2">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={clsx("sidebar-item", isActive && "active")}
            >
              <item.icon className="h-4.5 w-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="relative border-t border-zinc-800 px-3 py-3">
        <button
          onClick={() => setShowMenu(!showMenu)}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-sm text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-3">
            <User className="h-4 w-4 text-zinc-400" />
          </div>
          <div className="flex flex-1 flex-col items-start">
            <span className="text-xs font-medium text-zinc-300">
              {user?.name ?? "Acme Corp"}
            </span>
            <span className="text-[11px] text-zinc-500">
              {user?.tenantId ?? "t_acme"}
            </span>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 text-zinc-500" />
        </button>

        {/* Dropdown menu */}
        {showMenu && (
          <div className="absolute bottom-full left-3 right-3 mb-1 overflow-hidden rounded-lg border border-zinc-800 bg-surface-2 shadow-xl">
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
