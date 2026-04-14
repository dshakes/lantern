"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  BookOpen, Rocket, Bot, Plug, MessageSquare, Brain,
  Clock, Shield, Cloud, Code, FileCode, ExternalLink,
} from "lucide-react";

const sections = [
  { label: "Overview", items: [
    { href: "/", label: "Getting Started", icon: BookOpen },
    { href: "/quickstart", label: "Quick Start", icon: Rocket },
  ]},
  { label: "Build", items: [
    { href: "/agents", label: "Agents", icon: Bot },
    { href: "/connectors", label: "Connectors", icon: Plug },
    { href: "/surfaces", label: "Surfaces", icon: MessageSquare },
    { href: "/models", label: "Models", icon: Brain },
    { href: "/scheduling", label: "Scheduling", icon: Clock },
  ]},
  { label: "Platform", items: [
    { href: "/security", label: "Security", icon: Shield },
    { href: "/deployment", label: "Deployment", icon: Cloud },
  ]},
  { label: "Reference", items: [
    { href: "/api", label: "API Reference", icon: Code },
    { href: "/sdk", label: "SDK Reference", icon: FileCode },
  ]},
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <html lang="en" className="dark">
      <head>
        <title>Lantern Docs</title>
        <meta name="description" content="Documentation for the Lantern AI agent platform." />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <div className="flex min-h-screen">
          {/* Fixed sidebar */}
          <aside className="fixed top-0 left-0 w-60 h-screen border-r border-zinc-800 bg-surface-0 flex flex-col overflow-y-auto z-40">
            {/* Logo */}
            <div className="px-5 py-4 border-b border-zinc-800">
              <Link href="/" className="flex items-center gap-2.5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-lantern-400 to-lantern-600">
                  <span className="text-xs font-bold text-white">L</span>
                </div>
                <div>
                  <span className="text-sm font-semibold text-white">Lantern</span>
                  <span className="ml-1.5 rounded bg-lantern-500/10 px-1.5 py-0.5 text-[9px] font-medium text-lantern-400">DOCS</span>
                </div>
              </Link>
            </div>

            {/* Grouped navigation */}
            <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
              {sections.map((section) => (
                <div key={section.label}>
                  <p className="px-2 mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">{section.label}</p>
                  <div className="space-y-0.5">
                    {section.items.map((item) => {
                      const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                      return (
                        <Link key={item.href} href={item.href}
                          className={clsx(
                            "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                            isActive
                              ? "bg-lantern-500/10 text-lantern-400 font-medium"
                              : "text-zinc-400 hover:bg-surface-1 hover:text-zinc-200"
                          )}>
                          <item.icon className="w-3.5 h-3.5 shrink-0" />
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-zinc-800 space-y-2">
              <a href="https://github.com/dshakes/lantern" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                <ExternalLink className="h-3 w-3" /> GitHub
              </a>
              <p className="text-[10px] text-zinc-700">Alpha release · v0.1.0</p>
            </div>
          </aside>

          {/* Main content with proper prose width */}
          <main className="ml-60 flex-1 min-h-screen">
            <div className="max-w-3xl mx-auto px-10 py-12">
              <article className="prose">{children}</article>
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
