"use client";

import { motion, useInView } from "framer-motion";
import {
  ArrowRight,
  Zap,
  MessageSquare,
  Plug,
  LayoutGrid,
  Globe,
  Share2,
  Github,
  Twitter,
} from "lucide-react";
import { useRef } from "react";

/* ───────────────────────────────────────────────────── */
/*  FadeIn — scroll-triggered reveal                     */
/* ───────────────────────────────────────────────────── */
function FadeIn({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 24 }}
      animate={isInView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Section wrapper                                      */
/* ───────────────────────────────────────────────────── */
function Section({
  children,
  className = "",
  id,
}: {
  children: React.ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={`px-6 py-16 md:py-20 ${className}`}>
      <div className="mx-auto max-w-5xl">{children}</div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Data                                                 */
/* ───────────────────────────────────────────────────── */
const steps = [
  {
    num: "01",
    title: "Describe",
    desc: "Write what you want in plain language. Lantern scaffolds the agent, tools, and tests.",
    code: `lantern create email-digest \\
  --prompt "Summarize my unread emails
    every morning at 8am"`,
  },
  {
    num: "02",
    title: "Test",
    desc: "Run it instantly in a sandbox. See real LLM output, tool calls, and step traces.",
    code: `lantern test email-digest

✓ fetch_emails    284ms
✓ summarize       1.2s
✓ send_slack      145ms`,
  },
  {
    num: "03",
    title: "Deploy",
    desc: "One command to production. Auto-scaling, durable execution, zero ops.",
    code: `lantern deploy email-digest

✓ Deployed to production
  https://lantern.run/a/email-digest`,
  },
];

const features = [
  {
    icon: Zap,
    title: "Smart Model Routing",
    desc: "Auto-routes to the best model. Claude for reasoning, GPT for speed, Gemini for vision.",
  },
  {
    icon: MessageSquare,
    title: "Managed Sessions",
    desc: "Interactive, durable conversations. Reconnect without losing context.",
  },
  {
    icon: Plug,
    title: "17 Real Connectors",
    desc: "Gmail, Slack, GitHub, Stripe \u2014 real API calls, not stubs.",
  },
  {
    icon: LayoutGrid,
    title: "Visual Workflow Editor",
    desc: "Drag-and-drop for non-technical users. Code for developers.",
  },
  {
    icon: Share2,
    title: "A2A Agent Cards",
    desc: "Your agents are discoverable by other platforms via the Agent-to-Agent protocol.",
  },
  {
    icon: Globe,
    title: "Deploy Anywhere",
    desc: "Your cloud, our cloud, or self-hosted. Runs on Kubernetes.",
  },
];

/* ───────────────────────────────────────────────────── */
/*  Page                                                 */
/* ───────────────────────────────────────────────────── */
export default function LandingPage() {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      {/* ── Nav ──────────────────────────────────────── */}
      <nav className="fixed top-0 z-50 w-full border-b border-[#292524]/60 bg-[#0c0a09]/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <a href="/" className="font-serif text-xl tracking-tight text-[#fafaf9]">
            Lantern
          </a>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-[#a8a29e] hover:text-[#fafaf9] transition-colors">
              Features
            </a>
            <a href="#pricing" className="text-sm text-[#a8a29e] hover:text-[#fafaf9] transition-colors">
              Pricing
            </a>
            <a
              href="https://docs.lantern.run"
              className="text-sm text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
            >
              Docs
            </a>
            <a
              href="https://github.com/lantern-run/lantern"
              className="text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
            >
              <Github size={18} />
            </a>
          </div>
        </div>
      </nav>

      {/* ── Hero ─────────────────────────────────────── */}
      <div className="relative pt-32 pb-16 md:pt-44 md:pb-24">
        <div className="hero-glow pointer-events-none absolute inset-0" />
        <div className="relative mx-auto max-w-5xl px-6 text-center">
          <FadeIn>
            <h1 className="font-serif text-5xl md:text-7xl tracking-[-0.03em] text-[#fafaf9] leading-[1.1]">
              The runtime for AI agents
              <br />
              that actually work.
            </h1>
          </FadeIn>
          <FadeIn delay={0.1}>
            <p className="mx-auto mt-6 max-w-xl text-lg text-[#a8a29e] leading-relaxed">
              Build, test, and deploy autonomous agents across Claude, GPT, and
              Gemini. Open source.
            </p>
          </FadeIn>
          <FadeIn delay={0.2}>
            <div className="mt-10 flex items-center justify-center gap-4">
              <a
                href="https://docs.lantern.run/quickstart"
                className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-6 py-3 text-sm font-semibold text-[#0c0a09] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_24px_rgba(245,158,11,0.25)]"
              >
                Start building
              </a>
              <a
                href="https://docs.lantern.run"
                className="inline-flex items-center gap-1.5 text-sm text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
              >
                Read docs <ArrowRight size={14} />
              </a>
            </div>
          </FadeIn>
          <FadeIn delay={0.3}>
            <div className="terminal-block mx-auto mt-16 max-w-lg overflow-hidden text-left">
              <div className="flex items-center gap-2 border-b border-[#292524] px-4 py-3">
                <span className="h-3 w-3 rounded-full bg-[#292524]" />
                <span className="h-3 w-3 rounded-full bg-[#292524]" />
                <span className="h-3 w-3 rounded-full bg-[#292524]" />
                <span className="ml-2 text-xs text-[#a8a29e]">Terminal</span>
              </div>
              <div className="p-4 font-mono text-sm leading-relaxed">
                <span className="text-[#a8a29e]">$</span>{" "}
                <span className="text-[#fafaf9]">npx create-lantern-agent my-agent</span>
                <br />
                <br />
                <span className="text-[#a8a29e]">Creating agent...</span>
                <br />
                <span className="text-[#22c55e]">&#10003;</span>{" "}
                <span className="text-[#fafaf9]">Scaffolded agent in ./my-agent</span>
                <br />
                <span className="text-[#22c55e]">&#10003;</span>{" "}
                <span className="text-[#fafaf9]">Installed dependencies</span>
                <br />
                <span className="text-[#22c55e]">&#10003;</span>{" "}
                <span className="text-[#fafaf9]">Ready to run</span>
                <br />
                <br />
                <span className="text-[#a8a29e]">$</span>{" "}
                <span className="text-[#fafaf9]">cd my-agent && lantern dev</span>
                <span className="terminal-cursor" />
              </div>
            </div>
          </FadeIn>
        </div>
      </div>

      {/* ── How It Works ─────────────────────────────── */}
      <Section id="how-it-works">
        <FadeIn>
          <h2 className="font-serif text-2xl md:text-4xl tracking-[-0.02em] text-center">
            Three steps. That&apos;s it.
          </h2>
        </FadeIn>
        <div className="mt-16 grid gap-8 md:grid-cols-3">
          {steps.map((step, i) => (
            <FadeIn key={step.num} delay={i * 0.1}>
              <div>
                <span className="text-xs font-mono text-[#f59e0b]">{step.num}</span>
                <h3 className="mt-2 font-serif text-2xl">{step.title}</h3>
                <p className="mt-2 text-sm text-[#a8a29e] leading-relaxed">
                  {step.desc}
                </p>
                <pre className="terminal-block mt-4 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-[#a8a29e]">
                  {step.code}
                </pre>
              </div>
            </FadeIn>
          ))}
        </div>
      </Section>

      {/* ── Features ─────────────────────────────────── */}
      <Section id="features">
        <FadeIn>
          <h2 className="font-serif text-2xl md:text-4xl tracking-[-0.02em] text-center">
            Everything agents need.
          </h2>
          <p className="mt-4 text-center text-[#a8a29e]">
            Built for production from day one.
          </p>
        </FadeIn>
        <div className="mt-10 grid gap-3 md:grid-cols-2">
          {features.map((f, i) => (
            <FadeIn key={f.title} delay={i * 0.06}>
              <div className="feature-card">
                <div className="flex items-start gap-4">
                  <f.icon size={20} className="mt-0.5 shrink-0 text-[#f59e0b]" />
                  <div>
                    <h3 className="font-medium text-[#fafaf9]">{f.title}</h3>
                    <p className="mt-1 text-sm text-[#a8a29e] leading-relaxed">
                      {f.desc}
                    </p>
                  </div>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </Section>

      {/* ── Product Demo ─────────────────────────────── */}
      <Section>
        <FadeIn>
          <h2 className="font-serif text-2xl md:text-4xl tracking-[-0.02em] text-center">
            See it in action.
          </h2>
        </FadeIn>
        <FadeIn delay={0.15}>
          <div className="dashboard-mock mx-auto mt-16 max-w-2xl overflow-hidden">
            <div className="flex items-center gap-2 border-b border-[#292524] px-5 py-3">
              <span className="h-3 w-3 rounded-full bg-[#292524]" />
              <span className="h-3 w-3 rounded-full bg-[#292524]" />
              <span className="h-3 w-3 rounded-full bg-[#292524]" />
              <span className="ml-2 text-xs text-[#a8a29e]">Lantern Dashboard</span>
            </div>
            <div className="p-6">
              {/* Agent header */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs text-[#a8a29e]">Agent</p>
                  <p className="mt-1 font-mono text-lg text-[#fafaf9]">email-digest</p>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[#22c55e]/10 px-3 py-1 text-xs font-medium text-[#22c55e]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
                  Completed
                </span>
              </div>
              {/* Steps */}
              <div className="mt-6 flex flex-wrap gap-2">
                <span className="rounded-full bg-[#f59e0b]/10 px-3 py-1 text-xs text-[#f59e0b]">
                  Fetch emails
                </span>
                <span className="rounded-full bg-[#3b82f6]/10 px-3 py-1 text-xs text-[#3b82f6]">
                  Process
                </span>
                <span className="rounded-full bg-[#22c55e]/10 px-3 py-1 text-xs text-[#22c55e]">
                  Done
                </span>
              </div>
              {/* Output */}
              <div className="mt-6 rounded-lg border border-[#292524] bg-[#0c0a09] p-4">
                <p className="text-xs text-[#a8a29e]">Output</p>
                <p className="mt-2 text-sm text-[#fafaf9] leading-relaxed">
                  Here&apos;s your daily summary: 12 new emails. 3 require action
                  &mdash; invoice from Acme Corp, PR review request from Sarah, and
                  meeting reschedule from the design team. The rest are newsletters
                  and notifications.
                </p>
              </div>
              {/* Meta */}
              <div className="mt-4 flex gap-6 text-xs text-[#a8a29e]">
                <span>Duration: 1.6s</span>
                <span>Model: claude-sonnet</span>
                <span>Steps: 3</span>
              </div>
            </div>
          </div>
        </FadeIn>
      </Section>

      {/* ── Pricing ──────────────────────────────────── */}
      <Section id="pricing">
        <FadeIn>
          <h2 className="font-serif text-2xl md:text-3xl tracking-[-0.02em] text-center">
            Pricing
          </h2>
          <p className="mt-2 text-center text-sm text-[#a8a29e]">Free during alpha. No credit card required.</p>
        </FadeIn>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <FadeIn delay={0}>
            <div className="pricing-card pricing-card-active p-8">
              <p className="text-xs font-mono uppercase tracking-wider text-[#f59e0b]">
                Alpha
              </p>
              <p className="mt-4 font-serif text-4xl">Free</p>
              <p className="mt-2 text-sm text-[#a8a29e]">
                Everything included while we&apos;re in alpha. No limits, no credit
                card.
              </p>
              <a
                href="https://docs.lantern.run/quickstart"
                className="mt-8 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#f59e0b] px-6 py-3 text-sm font-semibold text-[#0c0a09] transition-all hover:bg-[#fbbf24]"
              >
                Start building
              </a>
            </div>
          </FadeIn>
          <FadeIn delay={0.1}>
            <div className="pricing-card p-8">
              <p className="text-xs font-mono uppercase tracking-wider text-[#a8a29e]">
                Team
              </p>
              <p className="mt-4 font-serif text-4xl text-[#a8a29e]">Coming soon</p>
              <p className="mt-2 text-sm text-[#a8a29e]">
                Role-based access, audit logs, shared agent library, and priority
                support.
              </p>
              <button
                disabled
                className="mt-8 inline-flex w-full cursor-not-allowed items-center justify-center rounded-lg border border-[#292524] px-6 py-3 text-sm text-[#a8a29e]"
              >
                Notify me
              </button>
            </div>
          </FadeIn>
          <FadeIn delay={0.2}>
            <div className="pricing-card p-8">
              <p className="text-xs font-mono uppercase tracking-wider text-[#a8a29e]">
                Enterprise
              </p>
              <p className="mt-4 font-serif text-4xl text-[#a8a29e]">Coming soon</p>
              <p className="mt-2 text-sm text-[#a8a29e]">
                Self-hosted, SSO, SLAs, dedicated support, and custom integrations.
              </p>
              <button
                disabled
                className="mt-8 inline-flex w-full cursor-not-allowed items-center justify-center rounded-lg border border-[#292524] px-6 py-3 text-sm text-[#a8a29e]"
              >
                Contact us
              </button>
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* ── CTA ──────────────────────────────────────── */}
      <Section>
        <FadeIn>
          <div className="text-center">
            <h2 className="font-serif text-2xl md:text-4xl tracking-[-0.02em]">
              Ship your first agent today.
            </h2>
            <p className="mt-3 text-sm text-[#a8a29e]">No credit card required. Free during alpha.</p>
            <div className="mt-6">
              <a
                href="https://docs.lantern.run/quickstart"
                className="inline-flex items-center gap-2 rounded-lg bg-[#f59e0b] px-8 py-3.5 text-sm font-semibold text-[#0c0a09] transition-all hover:bg-[#fbbf24] hover:shadow-[0_0_24px_rgba(245,158,11,0.25)]"
              >
                Start building
              </a>
            </div>
            <p className="mt-4 text-sm text-[#a8a29e]">
              No credit card required. Free during alpha.
            </p>
          </div>
        </FadeIn>
      </Section>

      {/* ── Footer ───────────────────────────────────── */}
      <footer className="border-t border-[#292524] px-6 py-12">
        <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-6 md:flex-row">
          <span className="font-serif text-lg text-[#fafaf9]">Lantern</span>
          <div className="flex items-center gap-6">
            <a
              href="https://docs.lantern.run"
              className="text-sm text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
            >
              Docs
            </a>
            <a
              href="https://github.com/lantern-run/lantern"
              className="text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
            >
              <Github size={16} />
            </a>
            <a
              href="https://twitter.com/lanternrun"
              className="text-[#a8a29e] hover:text-[#fafaf9] transition-colors"
            >
              <Twitter size={16} />
            </a>
          </div>
          <span className="text-sm text-[#a8a29e]">&copy; 2026 Lantern</span>
        </div>
      </footer>
    </div>
  );
}
