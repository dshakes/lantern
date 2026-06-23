"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import clsx from "clsx";
import { CodeEnhancer } from "./_components/CodeEnhancer";
import { Toc } from "./_components/Toc";
import {
  BookOpen, Rocket, Bot, Plug, MessageSquare, Brain,
  Clock, Shield, Cloud, Code, FileCode, ExternalLink,
  Store, BarChart3, Server, Download, Menu, X, Flame,
} from "lucide-react";

// The Lantern brand mark — a warm amber "lantern glow".
function LanternMark() {
  return (
    <div className="relative flex h-7 w-7 items-center justify-center rounded-[9px] bg-gradient-to-br from-amber-300 via-amber-400 to-amber-600 shadow-[0_0_16px_-3px_rgba(245,158,11,0.7)]">
      <Flame className="h-4 w-4 text-amber-950" fill="currentColor" />
    </div>
  );
}

interface NavItem { href: string; label: string; icon: typeof BookOpen; subs?: { href: string; label: string }[] }
interface NavSection { label: string; items: NavItem[] }

const sections: NavSection[] = [
  { label: "Overview", items: [
    { href: "/", label: "Getting Started", icon: BookOpen, subs: [
      { href: "/#what", label: "What is Lantern?" }, { href: "/#who", label: "Who is it for?" }, { href: "/#concepts", label: "Core concepts" },
    ]},
    { href: "/installation", label: "Installation", icon: Download, subs: [
      { href: "/installation#prerequisites", label: "Prerequisites" }, { href: "/installation#clone", label: "Clone" }, { href: "/installation#one-command", label: "One-command stack" }, { href: "/installation#credentials", label: "Dev credentials" }, { href: "/installation#ports", label: "Service ports" },
    ]},
    { href: "/quickstart", label: "Quickstart", icon: Rocket, subs: [
      { href: "/quickstart#prerequisites", label: "Prerequisites" }, { href: "/quickstart#step1", label: "Start the stack" }, { href: "/quickstart#step3", label: "Create an agent" }, { href: "/quickstart#step4", label: "Run the agent" }, { href: "/quickstart#step5", label: "Stream events" },
    ]},
  ]},
  { label: "Build", items: [
    { href: "/agents", label: "Agents", icon: Bot, subs: [
      { href: "/agents#create", label: "Creating agents" }, { href: "/agents#instructions", label: "Instructions & prompts" }, { href: "/agents#testing", label: "Testing" }, { href: "/agents#chat", label: "Conversations" }, { href: "/agents#visual", label: "Visual editor" },
    ]},
    { href: "/connectors", label: "Connectors", icon: Plug, subs: [
      { href: "/connectors#gmail", label: "Gmail" }, { href: "/connectors#slack", label: "Slack" }, { href: "/connectors#github", label: "GitHub" }, { href: "/connectors#per-agent", label: "Per-agent assignment" },
    ]},
    { href: "/surfaces", label: "Surfaces", icon: MessageSquare, subs: [
      { href: "/surfaces#whatsapp", label: "WhatsApp" }, { href: "/surfaces#slack", label: "Slack" }, { href: "/surfaces#telegram", label: "Telegram" }, { href: "/surfaces#webchat", label: "Web Chat" },
    ]},
    { href: "/models", label: "Models", icon: Brain, subs: [
      { href: "/models#providers", label: "Providers" }, { href: "/models#routing", label: "Capability routing" }, { href: "/models#auto", label: "Auto mode" }, { href: "/models#keys", label: "API keys" },
    ]},
    { href: "/scheduling", label: "Scheduling", icon: Clock, subs: [
      { href: "/scheduling#cron", label: "Cron expressions" }, { href: "/scheduling#ai", label: "AI-assisted cron" }, { href: "/scheduling#email", label: "Email delivery" }, { href: "/scheduling#webhooks", label: "Webhooks" },
    ]},
  ]},
  { label: "Runtime", items: [
    { href: "/runtime", label: "Overview", icon: Server, subs: [
      { href: "/runtime#model", label: "The model" }, { href: "/runtime#principles", label: "What's different" }, { href: "/runtime#guides", label: "In this section" },
    ]},
    { href: "/runtime/quickstart", label: "Headless Quickstart", icon: Rocket, subs: [
      { href: "/runtime/quickstart#write", label: "Write the spec" }, { href: "/runtime/quickstart#pick", label: "Pick isolation" }, { href: "/runtime/quickstart#run", label: "Run it" }, { href: "/runtime/quickstart#watch", label: "Logs, traces & cost" }, { href: "/runtime/quickstart#terminate", label: "Terminate" },
    ]},
    { href: "/runtime/isolation", label: "Isolation Classes", icon: Shield, subs: [
      { href: "/runtime/isolation#decision", label: "Decision tree" }, { href: "/runtime/isolation#classes", label: "The classes" }, { href: "/runtime/isolation#fail-closed", label: "Fail-closed gate" },
    ]},
    { href: "/runtime/durable-execution", label: "Durable Execution", icon: Clock, subs: [
      { href: "/runtime/durable-execution#journal", label: "Journal" }, { href: "/runtime/durable-execution#resume", label: "Resume" }, { href: "/runtime/durable-execution#idempotency", label: "Idempotency keys" }, { href: "/runtime/durable-execution#recovery", label: "Recovery watchdog" },
    ]},
    { href: "/runtime/observability", label: "Observability", icon: BarChart3, subs: [
      { href: "/runtime/observability#trace", label: "One trace per spawn" }, { href: "/runtime/observability#enable", label: "Enabling OTel" }, { href: "/runtime/observability#semconv", label: "GenAI semconv" }, { href: "/runtime/observability#metrics", label: "Metrics endpoint" },
    ]},
    { href: "/runtime/identity", label: "Identity & Secrets", icon: Code, subs: [
      { href: "/runtime/identity#identity", label: "Per-instance identity" }, { href: "/runtime/identity#vending", label: "Secret vending" }, { href: "/runtime/identity#ref-form", label: "Ref form" },
    ]},
    { href: "/runtime/receipts", label: "Verifiable Receipts", icon: FileCode, subs: [
      { href: "/runtime/receipts#what", label: "What it attests" }, { href: "/runtime/receipts#issue", label: "Issuing" }, { href: "/runtime/receipts#verify", label: "Verifying offline" },
    ]},
  ]},
  { label: "Platform", items: [
    { href: "/security", label: "Security", icon: Shield, subs: [
      { href: "/security#privacy", label: "Privacy levels" }, { href: "/security#guardrails", label: "Guardrails" }, { href: "/security#encryption", label: "Encryption" }, { href: "/security#audit", label: "Audit logging" },
    ]},
    { href: "/deployment", label: "Deployment", icon: Cloud, subs: [
      { href: "/deployment#architecture", label: "CP/DP split" }, { href: "/deployment#helm", label: "Helm charts" }, { href: "/deployment#terraform", label: "Terraform" }, { href: "/deployment#docker", label: "Docker Compose" },
    ]},
    { href: "/marketplace", label: "Marketplace", icon: Store, subs: [
      { href: "/marketplace#what", label: "What is the Marketplace" }, { href: "/marketplace#a2a", label: "A2A Agent Cards" }, { href: "/marketplace#publishing", label: "Publishing agents" }, { href: "/marketplace#discovering", label: "Discovering & forking" }, { href: "/marketplace#interop", label: "Cross-platform interop" },
    ]},
    { href: "/evaluations", label: "Evaluations", icon: BarChart3, subs: [
      { href: "/evaluations#metrics", label: "Performance metrics" }, { href: "/evaluations#cost", label: "Cost attribution" }, { href: "/evaluations#model-usage", label: "Model usage" }, { href: "/evaluations#quality", label: "Quality signals" }, { href: "/evaluations#alerts", label: "Alerts (future)" },
    ]},
  ]},
  { label: "Reference", items: [
    { href: "/api", label: "API Reference", icon: Code, subs: [
      { href: "/api#auth", label: "Authentication" }, { href: "/api#agents", label: "Agents" }, { href: "/api#runs", label: "Runs" }, { href: "/api#connectors", label: "Connectors" },
    ]},
    { href: "/sdk", label: "SDK Reference", icon: FileCode, subs: [
      { href: "/sdk#typescript", label: "TypeScript" }, { href: "/sdk#python", label: "Python" },
    ]},
  ]},
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <html lang="en" className="dark">
      <head>
        <title>Lantern Docs</title>
        <meta name="description" content="Documentation for the Lantern AI agent platform." />
        {/* Critical for mobile: without this the page renders at desktop width
            and shrinks to unreadable. (App-Router client layouts don't get
            Next's auto-injected viewport, so we set it explicitly.) */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <CodeEnhancer />
        {/* Mobile top bar (hidden on lg+) */}
        <header className="lg:hidden sticky top-0 z-50 flex h-14 items-center justify-between border-b border-zinc-800 bg-surface-0/95 px-4 backdrop-blur">
          <Link href="/" className="flex items-center gap-2.5">
            <LanternMark />
            <span className="text-sm font-semibold text-white">Lantern</span>
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">DOCS</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            className="-mr-2 rounded-lg p-2 text-zinc-300 hover:bg-surface-1"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </header>

        {/* Backdrop when the drawer is open on mobile */}
        {open && (
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            aria-hidden="true"
          />
        )}

        <div className="flex min-h-screen">
          {/* Sidebar: a slide-in drawer on mobile, a fixed rail on lg+ */}
          <aside
            className={clsx(
              "fixed top-0 left-0 z-50 flex h-screen w-72 max-w-[82vw] flex-col overflow-y-auto border-r border-zinc-800 bg-surface-0 transition-transform duration-200 ease-out lg:w-60 lg:translate-x-0",
              open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
            )}
          >
            {/* Logo */}
            <div className="px-5 py-4 border-b border-zinc-800">
              <Link href="/" className="flex items-center gap-2.5">
                <LanternMark />
                <div>
                  <span className="text-sm font-semibold text-white">Lantern</span>
                  <span className="ml-1.5 rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">DOCS</span>
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
                        <div key={item.href}>
                          <Link href={item.href}
                            className={clsx(
                              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                              isActive
                                ? "bg-lantern-500/10 text-lantern-400 font-medium"
                                : "text-zinc-400 hover:bg-surface-1 hover:text-zinc-200"
                            )}>
                            <item.icon className="w-4 h-4 shrink-0" />
                            {item.label}
                          </Link>
                        </div>
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

          {/* Main content + right-hand "On this page" rail */}
          <main className="min-h-screen flex-1 lg:ml-60">
            <div className="mx-auto flex max-w-6xl gap-12 px-5 py-8 sm:px-8 lg:px-10 lg:py-12">
              <article className="prose w-full min-w-0 max-w-3xl">{children}</article>
              <Toc />
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
