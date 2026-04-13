"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  BookOpen,
  Rocket,
  Bot,
  Plug,
  MessageSquare,
  Brain,
  Clock,
  Shield,
  Cloud,
  Code,
  FileCode,
} from "lucide-react";

const navItems = [
  { href: "/", label: "Getting Started", icon: BookOpen },
  { href: "/quickstart", label: "Quick Start", icon: Rocket },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/connectors", label: "Connectors", icon: Plug },
  { href: "/surfaces", label: "Surfaces", icon: MessageSquare },
  { href: "/models", label: "Models", icon: Brain },
  { href: "/scheduling", label: "Scheduling", icon: Clock },
  { href: "/security", label: "Security", icon: Shield },
  { href: "/deployment", label: "Deployment", icon: Cloud },
  { href: "/api", label: "API Reference", icon: Code },
  { href: "/sdk", label: "SDK Reference", icon: FileCode },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <html lang="en" className="dark">
      <head>
        <title>Lantern Docs</title>
        <meta
          name="description"
          content="Documentation for the Lantern serverless AI agent platform."
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <div className="flex min-h-screen">
          {/* Sidebar */}
          <aside className="fixed top-0 left-0 w-56 h-screen border-r border-zinc-800 bg-surface-0 flex flex-col overflow-y-auto z-40">
            <div className="px-4 py-5 border-b border-zinc-800">
              <Link href="/" className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-lantern-400 to-lantern-600">
                  <span className="text-xs font-bold text-white leading-none">
                    L
                  </span>
                </div>
                <span className="text-[15px] font-semibold tracking-[-0.02em] text-white">
                  Lantern Docs
                </span>
              </Link>
            </div>
            <nav className="flex-1 px-3 py-4 space-y-0.5">
              {navItems.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/" && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={clsx("sidebar-link flex items-center gap-2.5", {
                      active: isActive,
                    })}
                  >
                    <item.icon className="w-4 h-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="px-4 py-4 border-t border-zinc-800">
              <p className="text-xs text-zinc-600">Alpha release</p>
            </div>
          </aside>

          {/* Main content */}
          <main className="ml-56 flex-1 min-h-screen">
            <div className="max-w-3xl mx-auto px-8 py-12">
              <article className="prose">{children}</article>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
