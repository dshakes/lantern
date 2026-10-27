"use client";

import "./globals.css";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import clsx from "clsx";
import { CodeEnhancer } from "./_components/CodeEnhancer";
import { HeadingAnchors } from "./_components/HeadingAnchors";
import { Toc } from "./_components/Toc";
import {
  BookOpen, Rocket, Bot, Plug, MessageSquare, Brain,
  Clock, Shield, Cloud, Code, FileCode, ExternalLink,
  Store, BarChart3, Server, Download, Menu, X, Smartphone, Sun, Moon, Network,
  Webhook, UserPlus, Laptop, FlaskConical,
} from "lucide-react";

// The Lantern mark: a flame held inside glass (docs/brand).
function LanternMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" aria-hidden="true">
      <path d="M9 3.5h6" stroke="var(--lx-ink-2)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <rect x="5" y="6" width="14" height="15" rx="4" fill="none" stroke="var(--lx-glass)" strokeWidth="1.8" />
      <path d="M12 9.2c1.9 2 3 3.6 3 5.4a3 3 0 0 1-6 0c0-1.2.6-2.1 1.4-2.9.1 1 .6 1.6 1.2 1.8-.4-1.4-.1-2.8.4-4.3Z" fill="var(--lx-flame)" />
    </svg>
  );
}

// Runs before paint so an explicit theme choice never flashes the other theme.
const themeScript = `try{var t=localStorage.getItem("lantern-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setDark(set ? set === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
  }, []);
  return (
    <button
      type="button"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("lantern-theme", next); } catch { /* storage blocked: this page view only */ }
        setDark(!dark);
      }}
      className="rounded-md p-2 text-ink-2 hover:text-ink"
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

interface NavItem { href: string; label: string; icon: typeof BookOpen; subs?: { href: string; label: string }[] }
interface NavSection { label: string; items: NavItem[] }

const sections: NavSection[] = [
  { label: "Overview", items: [
    { href: "/", label: "Getting Started", icon: BookOpen, subs: [
      { href: "/#shape", label: "The shape of the system" }, { href: "/#features", label: "What the runtime gives you" }, { href: "/#new", label: "New since 0.2.0" }, { href: "/#reference", label: "Reference" },
    ]},
    { href: "/installation", label: "Installation", icon: Download, subs: [
      { href: "/installation#prerequisites", label: "Prerequisites" }, { href: "/installation#clone", label: "Clone" }, { href: "/installation#one-command", label: "One-command stack" }, { href: "/installation#credentials", label: "Dev credentials" }, { href: "/installation#ports", label: "Service ports" },
    ]},
    { href: "/quickstart", label: "Get started", icon: Rocket, subs: [
      { href: "/quickstart#prerequisites", label: "Before you start" }, { href: "/quickstart#dashboard", label: "In the dashboard" }, { href: "/quickstart#cli", label: "In the terminal" }, { href: "/quickstart#api", label: "The REST calls" }, { href: "/quickstart#next", label: "What's next" },
    ]},
    { href: "/architecture", label: "Architecture explorer", icon: Network, subs: [
      { href: "/architecture#map", label: "System map" }, { href: "/architecture#sequences", label: "Sequences" }, { href: "/architecture#lifecycle", label: "Sandbox states" },
    ]},
    { href: "/stack", label: "The Stack", icon: Server, subs: [
      { href: "/stack#rule", label: "The rule" }, { href: "/stack#languages", label: "Languages" }, { href: "/stack#glossary", label: "What these things are" }, { href: "/stack#data", label: "Data stores" }, { href: "/stack#e2e", label: "End to end" }, { href: "/stack#invariants", label: "Invariants" }, { href: "/stack#tradeoffs", label: "What it costs" },
    ]},
  ]},
  { label: "Build", items: [
    { href: "/agents", label: "Agents", icon: Bot, subs: [
      { href: "/agents#create", label: "Creating agents" }, { href: "/agents#instructions", label: "Instructions & prompts" }, { href: "/agents#testing", label: "Testing" }, { href: "/agents#chat", label: "Conversations" }, { href: "/agents#visual", label: "Visual editor" }, { href: "/agents#tool-nodes", label: "Workflow tool nodes" },
    ]},
    { href: "/connectors", label: "Connectors", icon: Plug, subs: [
      { href: "/connectors#available", label: "Available connectors" }, { href: "/connectors#new-actions", label: "Newer actions" }, { href: "/connectors#recorded-test-mode", label: "Recorded test mode" }, { href: "/connectors#slack", label: "Setting up a connector" }, { href: "/connectors#per-agent", label: "Per-agent assignment" },
    ]},
    { href: "/triggers", label: "Webhook triggers", icon: Webhook, subs: [
      { href: "/triggers#create", label: "Create a trigger" }, { href: "/triggers#providers", label: "Provider setup" }, { href: "/triggers#responses", label: "Responses" }, { href: "/triggers#idempotency", label: "Duplicate deliveries" }, { href: "/triggers#security", label: "Security notes" },
    ]},
    { href: "/surfaces", label: "Surfaces", icon: MessageSquare, subs: [
      { href: "/surfaces#whatsapp", label: "WhatsApp" }, { href: "/surfaces#slack", label: "Slack" }, { href: "/surfaces#telegram", label: "Telegram" }, { href: "/surfaces#webchat", label: "Web Chat" },
    ]},
    { href: "/personal", label: "Personal harness", icon: Smartphone, subs: [
      { href: "/personal#harness", label: "The harness" }, { href: "/personal#signals", label: "Sense — signals" }, { href: "/personal#memory", label: "Cross-app memory" }, { href: "/personal#reason", label: "Reason" }, { href: "/personal#persona", label: "Sound like you" }, { href: "/personal#actions", label: "Act" }, { href: "/personal#safety", label: "Safety & privacy" },
    ]},
    { href: "/models", label: "Models", icon: Brain, subs: [
      { href: "/models#providers", label: "Providers" }, { href: "/models#capabilities", label: "Capability names" }, { href: "/models#resolution-rules", label: "Resolution rules" }, { href: "/models#auto", label: "Auto mode" }, { href: "/models#failover", label: "Failover" }, { href: "/models#keys", label: "API keys" }, { href: "/models#router", label: "Model-router service" },
    ]},
    { href: "/scheduling", label: "Scheduling", icon: Clock, subs: [
      { href: "/scheduling#cron", label: "Cron expressions" }, { href: "/scheduling#api", label: "Schedule API" }, { href: "/scheduling#timezone", label: "Timezone" },
    ]},
  ]},
  { label: "Runtime", items: [
    { href: "/runtime", label: "Overview", icon: Server, subs: [
      { href: "/runtime#tiers", label: "Two tiers" }, { href: "/runtime#routing", label: "Routing" }, { href: "/runtime#shared", label: "Shared tier" }, { href: "/runtime#microvm", label: "MicroVM tier" }, { href: "/runtime#health-sweep", label: "Health sweep" },
    ]},
    { href: "/runtime/quickstart", label: "Headless Quickstart", icon: Rocket, subs: [
      { href: "/runtime/quickstart#write", label: "Write the spec" }, { href: "/runtime/quickstart#pick", label: "Pick isolation" }, { href: "/runtime/quickstart#run", label: "Run it" }, { href: "/runtime/quickstart#watch", label: "Logs, traces & cost" }, { href: "/runtime/quickstart#terminate", label: "Terminate" },
    ]},
    { href: "/runtime/isolation", label: "Isolation Classes", icon: Shield, subs: [
      { href: "/runtime/isolation#decision", label: "Decision tree" }, { href: "/runtime/isolation#classes", label: "The classes" }, { href: "/runtime/isolation#fail-closed", label: "Fail-closed gate" },
    ]},
    { href: "/runtime/durable-execution", label: "Durable Execution", icon: Clock, subs: [
      { href: "/runtime/durable-execution#journal", label: "Journal" }, { href: "/runtime/durable-execution#completedstep", label: "CompletedStep replay" }, { href: "/runtime/durable-execution#retry", label: "Per-step retry" }, { href: "/runtime/durable-execution#idempotency", label: "Idempotency keys" }, { href: "/runtime/durable-execution#recovery", label: "Recovery sweep" }, { href: "/runtime/durable-execution#microvm-resume", label: "MicroVM resume" },
    ]},
    { href: "/runtime/streaming", label: "Token Streaming", icon: BarChart3, subs: [
      { href: "/runtime/streaming#events", label: "The three events" }, { href: "/runtime/streaming#sdk", label: "SDK streamMessage()" }, { href: "/runtime/streaming#sse", label: "SSE transport" }, { href: "/runtime/streaming#provider", label: "Provider streaming" },
    ]},
    { href: "/runtime/sessions-and-memory", label: "Sessions & Memory", icon: Brain, subs: [
      { href: "/runtime/sessions-and-memory#sessions", label: "Sessions" }, { href: "/runtime/sessions-and-memory#streaming", label: "Token streaming" }, { href: "/runtime/sessions-and-memory#memory", label: "Memory distillates" }, { href: "/runtime/sessions-and-memory#env-vars", label: "Env vars" },
    ]},
    { href: "/runtime/sandbox-lifecycle", label: "Sandbox Lifecycle", icon: BarChart3, subs: [
      { href: "/runtime/sandbox-lifecycle#states", label: "States" }, { href: "/runtime/sandbox-lifecycle#idle", label: "Idle suspend" }, { href: "/runtime/sandbox-lifecycle#snapshots", label: "Snapshots" }, { href: "/runtime/sandbox-lifecycle#rest", label: "Pause / resume / fork" }, { href: "/runtime/sandbox-lifecycle#streaming-exec", label: "Streaming exec" }, { href: "/runtime/sandbox-lifecycle#sdk", label: "SDKs" },
    ]},
    { href: "/runtime/local-microvms", label: "Real microVMs on a Mac", icon: Laptop, subs: [
      { href: "/runtime/local-microvms#requirements", label: "Requirements" }, { href: "/runtime/local-microvms#setup", label: "Setup" }, { href: "/runtime/local-microvms#connect", label: "Point Lantern at it" }, { href: "/runtime/local-microvms#troubleshooting", label: "Troubleshooting" },
    ]},
    { href: "/runtime/egress", label: "Egress & Credentials", icon: Network, subs: [
      { href: "/runtime/egress#flow", label: "The path out" }, { href: "/runtime/egress#allowlist", label: "Allowlist" }, { href: "/runtime/egress#credentials", label: "Credential injection" },
    ]},
    { href: "/runtime/observability", label: "Observability", icon: BarChart3, subs: [
      { href: "/runtime/observability#span-attrs", label: "Span attributes" }, { href: "/runtime/observability#otel-metrics", label: "lantern.run.* metrics" }, { href: "/runtime/observability#enable", label: "Enabling OTel" }, { href: "/runtime/observability#health", label: "Health sweep" }, { href: "/runtime/observability#metrics", label: "VM metrics" },
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
    { href: "/accounts", label: "Accounts & sign-up", icon: UserPlus, subs: [
      { href: "/accounts#modes", label: "Sign-up modes" }, { href: "/accounts#email-verification", label: "Email verification" }, { href: "/accounts#password-reset", label: "Password reset" }, { href: "/accounts#invite-codes", label: "Invite codes" }, { href: "/accounts#rate-limits", label: "Rate limits" }, { href: "/accounts#export", label: "Data export" }, { href: "/accounts#delete", label: "Workspace deletion" }, { href: "/accounts#mailer", label: "Mailer" },
    ]},
    { href: "/deployment", label: "Deployment", icon: Cloud, subs: [
      { href: "/deployment#architecture", label: "CP/DP split" }, { href: "/deployment#helm", label: "Helm charts" }, { href: "/deployment#terraform", label: "Terraform" }, { href: "/deployment#docker", label: "Docker Compose" },
    ]},
    { href: "/marketplace", label: "Marketplace", icon: Store, subs: [
      { href: "/marketplace#what", label: "What is the Marketplace" }, { href: "/marketplace#a2a", label: "A2A Agent Cards" }, { href: "/marketplace#publishing", label: "Publishing agents" }, { href: "/marketplace#discovering", label: "Discovering & forking" }, { href: "/marketplace#interop", label: "Cross-platform interop" },
    ]},
    { href: "/evaluations", label: "Evaluations", icon: BarChart3, subs: [
      { href: "/evaluations#eval-suites", label: "Eval suites" }, { href: "/evaluations#eval-runs", label: "CI gate" }, { href: "/evaluations#baselines", label: "Baselines" }, { href: "/evaluations#experiments", label: "A/B experiments" }, { href: "/evaluations#feedback", label: "Feedback" }, { href: "/evaluations#rehearsals", label: "Rehearsals" },
    ]},
  ]},
  { label: "Reference", items: [
    { href: "/api", label: "API Reference", icon: Code, subs: [
      { href: "/api#auth", label: "Authentication" }, { href: "/api#accounts", label: "Accounts" }, { href: "/api#agents", label: "Agents" }, { href: "/api#runs", label: "Runs" }, { href: "/api#sessions", label: "Sessions" }, { href: "/api#connectors", label: "Connectors" }, { href: "/api#schedules", label: "Schedules" }, { href: "/api#triggers", label: "Triggers" }, { href: "/api#errors", label: "Errors" },
    ]},
    { href: "/sdk", label: "SDK Reference", icon: FileCode, subs: [
      { href: "/sdk#typescript", label: "TypeScript" }, { href: "/sdk#python", label: "Python" }, { href: "/sdk#agent-runtime", label: "Agent runtime" },
    ]},
    { href: "/cli", label: "CLI Reference", icon: Code, subs: [
      { href: "/cli#onboard", label: "onboard" }, { href: "/cli#doctor", label: "doctor" }, { href: "/cli#dev", label: "dev" }, { href: "/cli#agents", label: "agents" }, { href: "/cli#runs", label: "runs" }, { href: "/cli#vm", label: "vm" }, { href: "/cli#deploy", label: "deploy" }, { href: "/cli#auth", label: "login / whoami" },
    ]},
    { href: "/budgets", label: "Budgets", icon: BarChart3, subs: [
      { href: "/budgets#policy", label: "Setting a budget" }, { href: "/budgets#matrix", label: "What is enforced where" }, { href: "/budgets#responses", label: "Blocked responses" }, { href: "/budgets#fail-closed", label: "Fail-closed" }, { href: "/budgets#forecast", label: "Cost forecast" }, { href: "/budgets#not-enforced", label: "Not enforced yet" },
    ]},
    { href: "/testing", label: "End-to-end tests", icon: FlaskConical, subs: [
      { href: "/testing#run", label: "Run it" }, { href: "/testing#spend-policy", label: "Spend policy" }, { href: "/testing#env", label: "Environment variables" }, { href: "/testing#clean", label: "make e2e-clean" },
    ]},
    { href: "/human-in-the-loop", label: "Human-in-the-loop", icon: Shield, subs: [
      { href: "/human-in-the-loop#approval", label: "Approval workflow" }, { href: "/human-in-the-loop#confidence-gate", label: "Confidence gate" },
    ]},
  ]},
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // The most specific nav item wins, so /runtime/egress highlights Egress, not Overview.
  const path = pathname.replace(/\/$/, "") || "/";
  const wide = path === "/architecture";
  const activeHref = sections.flatMap((s) => s.items.map((i) => i.href))
    .filter((h) => path === h || (h !== "/" && path.startsWith(h + "/")))
    .sort((a, b) => b.length - a.length)[0];
  const [open, setOpen] = useState(false);
  // Close the mobile drawer whenever the route changes.
  useEffect(() => { setOpen(false); }, [pathname]);

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Lantern Docs</title>
        <meta name="description" content="Documentation for the Lantern AI agent platform." />
        {/* Critical for mobile: without this the page renders at desktop width
            and shrinks to unreadable. (App-Router client layouts don't get
            Next's auto-injected viewport, so we set it explicitly.) */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600..800&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <CodeEnhancer />
        <HeadingAnchors />
        {/* Mobile top bar (hidden on lg+) */}
        <header className="lg:hidden sticky top-0 z-50 flex h-14 items-center justify-between border-b border-line bg-bg/95 px-4 backdrop-blur">
          <Link href="/" className="flex items-center gap-2.5">
            <LanternMark />
            <span className="text-sm font-semibold text-ink">Lantern</span>
            <span className="text-sm text-ink-3">Docs</span>
          </Link>
          <div className="flex items-center"><ThemeToggle />
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Close menu" : "Open menu"}
            className="-mr-2 rounded-lg p-2 text-ink-2 hover:bg-surface"
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button></div>
        </header>

        {/* Backdrop when the drawer is open on mobile */}
        {open && (
          <div
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 bg-ink/40 lg:hidden"
            aria-hidden="true"
          />
        )}

        <div className="flex min-h-screen">
          {/* Sidebar: a slide-in drawer on mobile, a fixed rail on lg+ */}
          <aside
            className={clsx(
              "fixed top-0 left-0 z-50 flex h-screen w-72 max-w-[82vw] flex-col overflow-y-auto border-r border-line bg-bg transition-transform duration-200 ease-out lg:w-60 lg:translate-x-0",
              open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
            )}
          >
            {/* Logo */}
            <div className="px-5 py-4 border-b border-line">
              <Link href="/" className="flex items-center gap-2.5">
                <LanternMark />
                <div>
                  <span className="text-sm font-semibold text-ink">Lantern</span>
                  <span className="ml-1.5 text-sm text-ink-3">Docs</span>
                </div>
              </Link>
            </div>

            {/* Grouped navigation */}
            <nav className="flex-1 px-3 py-4 space-y-5 overflow-y-auto">
              {sections.map((section) => (
                <div key={section.label}>
                  <p className="px-2 mb-1.5 text-xs font-medium text-ink-3">{section.label}</p>
                  <div className="space-y-0.5">
                    {section.items.map((item) => {
                      const isActive = item.href === activeHref;
                      return (
                        <div key={item.href}>
                          <Link href={item.href}
                            className={clsx(
                              "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                              isActive
                                ? "bg-surface text-ink font-medium shadow-[inset_2px_0_0_var(--lx-flame)]"
                                : "text-ink-2 hover:bg-surface hover:text-ink"
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
            <div className="px-5 py-3 border-t border-line space-y-2">
              <a href="https://github.com/dshakes/lantern" target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-2 text-xs text-ink-2 hover:text-ink">
                <ExternalLink className="h-3 w-3" /> GitHub
              </a>
              <div className="flex items-center justify-between"><p className="text-xs text-ink-3">Apache-2.0</p><ThemeToggle /></div>
            </div>
          </aside>

          {/* Main content + right-hand "On this page" rail */}
          <main className="min-h-screen min-w-0 flex-1 lg:ml-60">
            <div className="mx-auto flex max-w-6xl gap-12 px-5 py-8 sm:px-8 lg:px-10 lg:py-12">
              {/* The architecture explorer needs the full width; its sections are in the sidebar. */}
              <article className={clsx("prose w-full min-w-0", !wide && "max-w-3xl")}>{children}</article>
              {!wide && <Toc />}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
