"use client";

import { motion, useInView } from "framer-motion";
import {
  Zap,
  Shield,
  Globe,
  Brain,
  Workflow,
  Eye,
  Smartphone,
  Plug,
  Cpu,
  ArrowRight,
  Check,
  Terminal,
  Layers,
  Lock,
  Gauge,
  Flame,
} from "lucide-react";
import { useRef } from "react";

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
  const isInView = useInView(ref, { once: true, margin: "-80px" });

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

function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#09090b]/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="w-6 h-6 text-lantern-500" />
          <span className="text-lg font-bold tracking-tight">Lantern</span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
          <a href="#features" className="hover:text-white transition-colors">
            Features
          </a>
          <a href="#how-it-works" className="hover:text-white transition-colors">
            How it works
          </a>
          <a href="#pricing" className="hover:text-white transition-colors">
            Pricing
          </a>
          <a href="https://docs.lantern.run" className="hover:text-white transition-colors">
            Docs
          </a>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="https://app.lantern.run"
            className="text-sm text-zinc-400 hover:text-white transition-colors hidden sm:block"
          >
            Sign in
          </a>
          <a
            href="https://app.lantern.run/signup"
            className="text-sm font-medium px-4 py-2 rounded-lg bg-lantern-600 hover:bg-lantern-500 text-white transition-all hover:shadow-lg hover:shadow-lantern-600/20"
          >
            Get started
          </a>
        </div>
      </div>
    </nav>
  );
}

function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden noise-bg grid-bg">
      {/* Radial glow behind hero */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] rounded-full bg-lantern-600/10 blur-[160px] pointer-events-none" />
      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-full h-[400px] bg-gradient-to-t from-[#09090b] to-transparent pointer-events-none z-10" />

      <div className="relative z-20 max-w-5xl mx-auto px-6 text-center">
        <FadeIn>
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-lantern-700/40 bg-lantern-900/20 text-lantern-400 text-sm mb-8">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-lantern-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-lantern-500" />
            </span>
            Now in public beta
          </div>
        </FadeIn>

        <FadeIn delay={0.1}>
          <h1 className="text-5xl sm:text-7xl lg:text-8xl font-black tracking-tight leading-[0.9] mb-6">
            <span className="gradient-text glow-text">Serverless agents,</span>
            <br />
            <span className="text-white">production grade.</span>
          </h1>
        </FadeIn>

        <FadeIn delay={0.2}>
          <p className="text-lg sm:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Ship an AI agent in 60 seconds. Run it on global infrastructure with
            durable execution, microVM isolation, smart model routing, and zero
            ops. Any model. Any scale. Your phone as the remote.
          </p>
        </FadeIn>

        <FadeIn delay={0.3}>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <a
              href="https://app.lantern.run/signup"
              className="group flex items-center gap-2 px-8 py-3.5 rounded-xl bg-lantern-600 hover:bg-lantern-500 text-white font-semibold text-base transition-all hover:shadow-xl hover:shadow-lantern-600/25 hover:-translate-y-0.5"
            >
              Start building free
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
            </a>
            <a
              href="https://docs.lantern.run"
              className="flex items-center gap-2 px-8 py-3.5 rounded-xl border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white font-medium text-base transition-all"
            >
              <Terminal className="w-4 h-4" />
              Read the docs
            </a>
          </div>
        </FadeIn>

        <FadeIn delay={0.4}>
          <div className="code-block glow-amber p-1 max-w-3xl mx-auto">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
              </div>
              <span className="text-xs text-zinc-500 font-mono ml-2">
                terminal
              </span>
            </div>
            <pre className="p-6 text-sm sm:text-base font-mono text-left overflow-x-auto leading-relaxed">
              <code>
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span> init
                my-agent --template research{"\n"}
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span> deploy{"\n"}
                <span className="text-emerald-400">
                  {"  "}✓ built{" "}
                </span>
                <span className="text-zinc-400">
                  lantern.run/acme/research-agent@v1
                </span>
                {"\n"}
                <span className="text-emerald-400">
                  {"  "}✓ snapshot{" "}
                </span>
                <span className="text-zinc-400">
                  412 MB → 18 MB compressed
                </span>
                {"\n"}
                <span className="text-emerald-400">
                  {"  "}✓ live{" "}
                </span>
                <span className="text-blue-400">
                  https://acme.lantern.run/research-agent
                </span>
                {"\n\n"}
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span> run
                research-agent --input &quot;Compare Postgres vs ScyllaDB&quot;
                {"\n"}
                <span className="text-lantern-400">
                  {"  "}▸ streaming{" "}
                </span>
                <span className="text-blue-400">
                  https://app.lantern.run/runs/r_01HXY2...
                </span>
              </code>
            </pre>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

const features = [
  {
    icon: Workflow,
    title: "Durable execution",
    description:
      "Every step is journaled. Every restart resumes. Crash-safe workflows with parallel fan-out, signals, sagas, and human-in-the-loop approvals.",
  },
  {
    icon: Brain,
    title: "Smart model routing",
    description:
      "The Spectrum picks the right model per step — edge, open-source, or frontier — based on cost, latency, and accuracy. Learns from outcomes.",
  },
  {
    icon: Shield,
    title: "MicroVM isolation",
    description:
      "Untrusted agent code runs in Firecracker microVMs with 150ms cold starts. Seccomp, egress filtering, and signed bundles.",
  },
  {
    icon: Zap,
    title: "Streaming end-to-end",
    description:
      "Tokens flow runtime → gateway → SDK → dashboard with zero buffering. SSE, WebSocket, gRPC. First byte in < 200ms.",
  },
  {
    icon: Smartphone,
    title: "Control from anywhere",
    description:
      "Start agents from your phone, Slack, Telegram, voice, or email. Two-way chat with running agents. Approve from iMessage.",
  },
  {
    icon: Plug,
    title: "30+ connectors",
    description:
      "Gmail, Calendar, Slack, Notion, GitHub, Linear, HubSpot, Stripe, and more. OAuth-first. Zero-config. Triggers and actions.",
  },
  {
    icon: Eye,
    title: "Full observability",
    description:
      "OTel traces of every LLM call, tool call, and step. Live run inspector. Replay any failed run from any step.",
  },
  {
    icon: Globe,
    title: "MCP + A2A native",
    description:
      "Every agent is an MCP server and an A2A peer. Connect to Claude Code, Cursor, or any MCP client. Cross-platform agent collaboration.",
  },
  {
    icon: Layers,
    title: "Visual builder",
    description:
      "Non-technical users build workflows on a drag-and-drop canvas. Same engine, same durability. Canvas compiles to the same code the SDK produces.",
  },
  {
    icon: Lock,
    title: "E2E encrypted personal mode",
    description:
      "Your credentials, your key. Even we can't read your tokens. Personal automations with zero-knowledge security.",
  },
  {
    icon: Cpu,
    title: "Self-hostable day one",
    description:
      "One Helm chart deploys the full stack on any Kubernetes cluster. Your cloud, your data, your rules.",
  },
  {
    icon: Gauge,
    title: "Context intelligence",
    description:
      "Token budgeter, hierarchical summarization, prompt cache reuse. Cut LLM costs 3-10x without sacrificing accuracy.",
  },
];

function Features() {
  return (
    <section id="features" className="relative py-32 px-6">
      <div className="max-w-7xl mx-auto">
        <FadeIn>
          <div className="text-center mb-20">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Everything agents need.{" "}
              <span className="gradient-text">Nothing they don&apos;t.</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              We studied the top 10 agent platforms and built the best of each into one coherent system.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((feature, i) => (
            <FadeIn key={feature.title} delay={i * 0.05}>
              <div className="feature-card p-6 h-full">
                <feature.icon className="w-8 h-8 text-lantern-500 mb-4" />
                <h3 className="text-lg font-bold mb-2">{feature.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

function CodeDemo() {
  return (
    <section id="how-it-works" className="relative py-32 px-6">
      <div className="max-w-6xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Ship your first agent in{" "}
              <span className="gradient-text">60 seconds</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              Declarative TypeScript. Durable steps. Smart model routing. All
              the hard parts handled.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="code-block glow-amber p-1">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
                <div className="w-3 h-3 rounded-full bg-zinc-700" />
              </div>
              <span className="text-xs text-zinc-500 font-mono ml-2">
                agent.ts
              </span>
            </div>
            <pre className="p-6 text-sm sm:text-[15px] font-mono overflow-x-auto leading-relaxed">
              <code>{`import { agent, step } from "@lantern/sdk";

export default agent({
  name: "research-agent",
  model: "auto",       // Lantern picks the right model per step
  tools: [tool.web, tool.python],

  async run({ input, ctx }) {
    // Step 1: Plan (durable — survives crashes)
    const plan = await step("plan", async () =>
      ctx.llm.json({
        capability: "reasoning-large",
        schema: PlanSchema,
        prompt: \`Plan research for: \${input.query}\`,
      })
    );

    // Step 2: Parallel fan-out across workers
    const findings = await step.map("search", plan.queries, async (q) =>
      ctx.tools.web.search(q), { concurrency: 8 }
    );

    // Step 3: Ask user if the cost is high
    if (ctx.cost.estimateUsd() > 0.50) {
      await ctx.approval.request({
        reason: \`Synthesis will cost ~$\${ctx.cost.estimateUsd().toFixed(2)}\`,
      });
    }

    // Step 4: Synthesize (auto-routes to cheapest model that works)
    return await step("synthesize", async () =>
      ctx.llm.stream({
        capability: "auto",
        optimize: "balanced",
        prompt: synthesisPrompt(findings),
      })
    );
  },
});`}</code>
            </pre>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function Architecture() {
  return (
    <section className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Built for the{" "}
              <span className="gradient-text">real problems</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              The hard parts of agents aren&apos;t the agent loop. They&apos;re
              durable execution, isolation, model routing, context management,
              and operational correctness across failure.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="code-block p-8 sm:p-12 overflow-x-auto">
            <pre className="text-xs sm:text-sm font-mono text-zinc-400 leading-relaxed whitespace-pre">
              {`                          ┌─────────────────┐
                          │   Dashboard     │  Next.js 15 / RSC
                          │   + Mobile      │  Live runs, voice, chat
                          └────────┬────────┘
                                   │ HTTPS + WS + Push
              ┌────────────────────▼─────────────────────┐
              │           API Gateway (Rust/Axum)        │
              │  Auth · streaming proxy · rate limits     │
              └────┬─────────────────────────────────┬───┘
                   │                                 │
       ┌───────────▼──────────┐         ┌────────────▼──────────────┐
       │  Control Plane (Go)  │         │  The Spectrum (Rust)      │
       │  agents / runs /     │         │  Multi-LLM · edge→frontier│
       │  workflows / RBAC    │         │  cache · failover · learn │
       └───────┬──────────────┘         └───────────────────────────┘
               │
       ┌───────▼──────────────┐         ┌───────────────────────────┐
       │  Workflow Engine (Go)│         │  Connector Hub            │
       │  durable · event-    │◀───────▶│  30+ integrations         │
       │  sourced · replay    │         │  Gmail · Slack · GitHub …  │
       └───────┬──────────────┘         └───────────────────────────┘
               │
       ┌───────▼──────────────────────────────────────────────┐
       │            Runtime Manager (Rust)                    │
       │  K8s · Firecracker · Kata · Wasmtime · DevContainer  │
       │  snapshot/restore · 150ms cold start · sandboxing    │
       └─────────────────────────────────────────────────────┘`}
            </pre>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-12">
          {[
            {
              stat: "150ms",
              label: "Warm cold start via Firecracker snapshot/restore",
            },
            {
              stat: "3-10x",
              label: "Token cost reduction via smart routing + context mgmt",
            },
            {
              stat: "< 20ms",
              label: "Streaming overhead end-to-end through the full stack",
            },
          ].map((item, i) => (
            <FadeIn key={item.stat} delay={0.1 * i}>
              <div className="text-center p-6">
                <div className="text-4xl font-black gradient-text mb-2">
                  {item.stat}
                </div>
                <div className="text-sm text-zinc-500">{item.label}</div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

const pricingTiers = [
  {
    name: "Personal",
    price: "Free",
    period: "",
    description: "For individuals automating their day-to-day",
    features: [
      "100 runs / month",
      "50k tokens / month",
      "5 connectors",
      "Mobile app + chat surfaces",
      "E2E encrypted vault",
      "30-day history",
    ],
    cta: "Start free",
    highlighted: false,
  },
  {
    name: "Personal Plus",
    price: "$20",
    period: "/mo",
    description: "Unlimited automation for power users",
    features: [
      "5,000 runs / month",
      "5M tokens / month",
      "Unlimited connectors",
      "Voice surface",
      "1-year history",
      "Visual workflow builder",
    ],
    cta: "Start building",
    highlighted: true,
  },
  {
    name: "Team",
    price: "$25",
    period: "/seat/mo",
    description: "Collaborate on production agents",
    features: [
      "Everything in Plus",
      "Unlimited collaborators",
      "Custom connectors",
      "SSO (Google / GitHub)",
      "Dashboard + RBAC",
      "Priority support",
    ],
    cta: "Start your team",
    highlighted: false,
  },
];

function Pricing() {
  return (
    <section id="pricing" className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-5xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Cheaper than{" "}
              <span className="gradient-text">doing it yourself</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-xl mx-auto">
              Start free. Scale as you grow. Enterprise pricing for teams that
              need SLAs and compliance.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {pricingTiers.map((tier, i) => (
            <FadeIn key={tier.name} delay={i * 0.1}>
              <div
                className={`relative feature-card p-8 flex flex-col h-full ${
                  tier.highlighted
                    ? "border-lantern-600/50 shadow-lg shadow-lantern-600/10"
                    : ""
                }`}
              >
                {tier.highlighted && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-lantern-600 text-xs font-bold text-white">
                    Most popular
                  </div>
                )}
                <h3 className="text-xl font-bold mb-1">{tier.name}</h3>
                <div className="flex items-baseline gap-1 mb-2">
                  <span className="text-4xl font-black">{tier.price}</span>
                  <span className="text-zinc-500 text-sm">{tier.period}</span>
                </div>
                <p className="text-sm text-zinc-500 mb-6">
                  {tier.description}
                </p>
                <ul className="space-y-3 mb-8 flex-1">
                  {tier.features.map((f) => (
                    <li
                      key={f}
                      className="flex items-center gap-2 text-sm text-zinc-300"
                    >
                      <Check className="w-4 h-4 text-lantern-500 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
                <a
                  href="https://app.lantern.run/signup"
                  className={`block text-center py-3 rounded-lg font-semibold text-sm transition-all ${
                    tier.highlighted
                      ? "bg-lantern-600 hover:bg-lantern-500 text-white hover:shadow-lg hover:shadow-lantern-600/20"
                      : "border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white"
                  }`}
                >
                  {tier.cta}
                </a>
              </div>
            </FadeIn>
          ))}
        </div>

        <FadeIn delay={0.3}>
          <p className="text-center text-sm text-zinc-600 mt-8">
            Enterprise with SAML, SCIM, BYOK, 99.95% SLA, and dedicated
            support?{" "}
            <a href="mailto:sales@lantern.run" className="text-lantern-500 hover:text-lantern-400">
              Talk to us
            </a>
          </p>
        </FadeIn>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="relative py-32 px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-lantern-900/10 to-transparent pointer-events-none" />
      <div className="relative max-w-3xl mx-auto text-center">
        <FadeIn>
          <Flame className="w-12 h-12 text-lantern-500 mx-auto mb-6 animate-[float_4s_ease-in-out_infinite]" />
          <h2 className="text-4xl sm:text-6xl font-black tracking-tight mb-6">
            Light a lantern.
            <br />
            <span className="gradient-text">Watch it work.</span>
          </h2>
          <p className="text-zinc-400 text-lg mb-10 max-w-xl mx-auto">
            Your first agent is free. Deploy in 60 seconds. Monitor from your
            phone. Scale to a million runs without ops.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://app.lantern.run/signup"
              className="group flex items-center gap-2 px-10 py-4 rounded-xl bg-lantern-600 hover:bg-lantern-500 text-white font-bold text-lg transition-all hover:shadow-2xl hover:shadow-lantern-600/30 hover:-translate-y-0.5"
            >
              Get started free
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </a>
            <a
              href="https://github.com/dshakes/lantern"
              className="flex items-center gap-2 px-10 py-4 rounded-xl border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white font-medium text-lg transition-all"
            >
              View on GitHub
            </a>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/5 py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-12">
          <div className="col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <Flame className="w-5 h-5 text-lantern-500" />
              <span className="text-lg font-bold">Lantern</span>
            </div>
            <p className="text-sm text-zinc-500 max-w-xs">
              The serverless platform for production AI agents. Any model. Any
              scale. Zero ops.
            </p>
          </div>
          {[
            {
              title: "Product",
              links: ["Features", "Pricing", "Changelog", "Roadmap", "Status"],
            },
            {
              title: "Resources",
              links: [
                "Documentation",
                "API Reference",
                "Quickstart",
                "Templates",
                "Blog",
              ],
            },
            {
              title: "Company",
              links: ["About", "Careers", "Security", "Privacy", "Terms"],
            },
          ].map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold mb-4">{col.title}</h4>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link}>
                    <a
                      href="#"
                      className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {link}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-white/5 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-zinc-600">
            &copy; {new Date().getFullYear()} Lantern. All rights reserved.
          </p>
          <div className="flex items-center gap-4">
            <a href="#" className="text-xs text-zinc-600 hover:text-zinc-400">
              Twitter
            </a>
            <a href="#" className="text-xs text-zinc-600 hover:text-zinc-400">
              GitHub
            </a>
            <a href="#" className="text-xs text-zinc-600 hover:text-zinc-400">
              Discord
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <main className="relative">
      <Navbar />
      <Hero />
      <Features />
      <CodeDemo />
      <Architecture />
      <Pricing />
      <CTA />
      <Footer />
    </main>
  );
}
