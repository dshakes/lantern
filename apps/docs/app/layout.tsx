"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import {
  BookOpen, Rocket, Bot, Plug, MessageSquare, Brain,
  Clock, Shield, Cloud, Code, FileCode, ExternalLink,
  Store, BarChart3, Server, Download,
} from "lucide-react";

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
                        <div key={item.href}>
                          <Link href={item.href}
                            className={clsx(
                              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                              isActive
                                ? "bg-lantern-500/10 text-lantern-400 font-medium"
                                : "text-zinc-400 hover:bg-surface-1 hover:text-zinc-200"
                            )}>
                            <item.icon className="w-3.5 h-3.5 shrink-0" />
                            {item.label}
                          </Link>
                          {/* Sub-items — shown when page is active */}
                          {isActive && item.subs && item.subs.length > 0 && (
                            <div className="ml-6 mt-0.5 mb-1 space-y-0.5 border-l border-zinc-800 pl-3">
                              {item.subs.map((sub) => (
                                <a key={sub.href} href={sub.href}
                                  className="block py-1 text-[11px] text-zinc-500 transition-colors hover:text-lantern-400">
                                  {sub.label}
                                </a>
                              ))}
                            </div>
                          )}
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
