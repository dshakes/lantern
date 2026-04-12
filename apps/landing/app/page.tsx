"use client";

import { motion, useInView } from "framer-motion";
import {
  Zap,
  Shield,
  Globe,
  Brain,
  Workflow,
  Smartphone,
  Cpu,
  ArrowRight,
  Check,
  X,
  Terminal,
  Lock,
  Gauge,
  Flame,
  Cloud,
  MessageSquare,
  Mail,
  Phone,
  Users,
  Search,
  Bot,
  ShieldCheck,
  Headphones,
  DollarSign,
  Github,
  ExternalLink,
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

/* ───────────────────────────────────────────────────── */
/*  Navbar                                               */
/* ───────────────────────────────────────────────────── */
function Navbar() {
  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-[#09090b]/80 backdrop-blur-xl">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Flame className="w-6 h-6 text-lantern-500" />
          <span className="text-lg font-bold tracking-tight">Lantern</span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm text-zinc-400">
          <a href="#why" className="hover:text-white transition-colors">
            Why Lantern
          </a>
          <a href="#features" className="hover:text-white transition-colors">
            Features
          </a>
          <a href="#tour" className="hover:text-white transition-colors">
            Tour
          </a>
          <a href="#pricing" className="hover:text-white transition-colors">
            Pricing
          </a>
          <a
            href="https://docs.lantern.run"
            className="hover:text-white transition-colors"
          >
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

/* ───────────────────────────────────────────────────── */
/*  Hero                                                 */
/* ───────────────────────────────────────────────────── */
function Hero() {
  return (
    <section className="relative min-h-screen flex items-center justify-center pt-16 overflow-hidden noise-bg grid-bg">
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
            Deploy AI agents that survive crashes, route to any LLM, run in your
            cloud, and respond on WhatsApp. Any model. Any scale. Your phone as
            the remote.
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
                <span className="text-lantern-400">lantern</span> init my-agent
                --template research{"\n"}
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span> deploy{"\n"}
                <span className="text-emerald-400">{"  "}&#10003; built </span>
                <span className="text-zinc-400">
                  lantern.run/acme/research-agent@v1
                </span>
                {"\n"}
                <span className="text-emerald-400">
                  {"  "}&#10003; snapshot{" "}
                </span>
                <span className="text-zinc-400">
                  412 MB &#8594; 18 MB compressed
                </span>
                {"\n"}
                <span className="text-emerald-400">{"  "}&#10003; live </span>
                <span className="text-blue-400">
                  https://acme.lantern.run/research-agent
                </span>
                {"\n\n"}
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span> run
                research-agent --input &quot;Compare Postgres vs ScyllaDB&quot;
                {"\n"}
                <span className="text-lantern-400">{"  "}&#9656; streaming </span>
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

/* ───────────────────────────────────────────────────── */
/*  Why Another Agent Platform? — Comparison Table       */
/* ───────────────────────────────────────────────────── */
const comparisonCapabilities = [
  "Multi-LLM routing",
  "Durable execution",
  "MicroVM isolation",
  "Self-hostable",
  "Omnichannel surfaces",
  "Streaming E2E",
  "Free personal tier",
  "Open source",
];

const competitors: {
  name: string;
  tagline: string;
  scores: boolean[];
}[] = [
  {
    name: "Claude / OpenAI Agents",
    tagline: "Locked to one LLM. No durability. No self-hosting.",
    scores: [false, false, false, false, false, true, false, false],
  },
  {
    name: "Google Vertex AI Agents",
    tagline: "GCP-only. No omnichannel. No personal tier.",
    scores: [false, true, false, false, false, true, false, false],
  },
  {
    name: "AWS Bedrock Agents",
    tagline: "Complex. AWS-locked. No streaming.",
    scores: [true, false, false, false, false, false, false, false],
  },
  {
    name: "AutoGen / Semantic Kernel",
    tagline: "Framework, not a platform. No infra. No isolation.",
    scores: [true, false, false, false, false, false, true, true],
  },
  {
    name: "Lantern",
    tagline: "Open-source platform. All of the above, none of the lock-in.",
    scores: [true, true, true, true, true, true, true, true],
  },
];

function ComparisonTable() {
  return (
    <section id="why" className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Why another{" "}
              <span className="gradient-text">agent platform?</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              Every platform nails one or two things and punts on the rest.
              Lantern is the first to ship all of them together.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left py-4 pr-4 text-zinc-500 font-medium w-52">
                    Platform
                  </th>
                  {comparisonCapabilities.map((cap) => (
                    <th
                      key={cap}
                      className="py-4 px-2 text-center text-zinc-500 font-medium text-xs"
                    >
                      {cap}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {competitors.map((comp, idx) => {
                  const isLantern = comp.name === "Lantern";
                  return (
                    <FadeIn
                      key={comp.name}
                      delay={0.05 * idx}
                      className="contents"
                    >
                      <tr
                        className={`border-b border-white/5 ${
                          isLantern
                            ? "bg-lantern-900/20 border-lantern-600/30"
                            : ""
                        }`}
                      >
                        <td className="py-4 pr-4">
                          <div
                            className={`font-semibold ${
                              isLantern
                                ? "text-lantern-400 text-base"
                                : "text-zinc-200"
                            }`}
                          >
                            {isLantern && (
                              <Flame className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                            )}
                            {comp.name}
                          </div>
                          <div className="text-xs text-zinc-600 mt-0.5">
                            {comp.tagline}
                          </div>
                        </td>
                        {comp.scores.map((ok, i) => (
                          <td key={i} className="py-4 px-2 text-center">
                            {ok ? (
                              <Check
                                className={`w-5 h-5 mx-auto ${
                                  isLantern
                                    ? "text-emerald-400"
                                    : "text-emerald-600"
                                }`}
                              />
                            ) : (
                              <X className="w-5 h-5 mx-auto text-red-500/60" />
                            )}
                          </td>
                        ))}
                      </tr>
                    </FadeIn>
                  );
                })}
              </tbody>
            </table>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  6 Feature cards                                      */
/* ───────────────────────────────────────────────────── */
const featureCards: {
  icon: typeof Workflow;
  title: string;
  desc: string;
  snippet: string;
}[] = [
  {
    icon: Workflow,
    title: "Durable Execution",
    desc: "Like Temporal, but for AI. Steps survive crashes, replay on resume. Every side-effect is journaled and idempotent.",
    snippet: `const plan = await step("plan", async () => {
  return ctx.llm.json({
    capability: "reasoning-small",
    prompt: \`Plan for: \${input.topic}\`,
  });
});
// If the process crashes here, it resumes
// from the next step — not the beginning.`,
  },
  {
    icon: Brain,
    title: "Route by Capability, Not Model",
    desc: 'Say model: "auto", get the best model at the best price. Failover between providers is automatic and invisible.',
    snippet: `model: "auto"          // best for each step
model: "reasoning-large"  // GPT-5 / Opus / etc.
model: "reasoning-small"  // Haiku / GPT-4o-mini
model: "code"             // code-specialized
model: "vision"           // image understanding
// The Spectrum maps to concrete models
// and fails over across vendors.`,
  },
  {
    icon: Shield,
    title: "MicroVM Sandboxing",
    desc: "Every agent run gets its own Firecracker microVM. 150ms warm start. Real isolation, not just containers.",
    snippet: `┌─────────────────────────────┐
│  Your Agent Code            │
│  ┌───────────────────────┐  │
│  │  Firecracker MicroVM  │  │
│  │  seccomp · egress     │  │
│  │  150ms warm start     │  │
│  │  signed bundles       │  │
│  └───────────────────────┘  │
│  Snapshot / Restore         │
└─────────────────────────────┘`,
  },
  {
    icon: Cloud,
    title: "Deploy Into Your Cloud",
    desc: "Control plane hosted by us. Data plane runs in YOUR AWS/GCP/Azure. Agent data never leaves your VPC.",
    snippet: `┌─────────────────────────────┐
│  Lantern SaaS (Control)     │
│  scheduling · routing · UI  │
└──────────┬──────────────────┘
           │ gRPC tunnel (mTLS)
┌──────────▼──────────────────┐
│  Your VPC (Data Plane)      │
│  Firecracker · K8s · data   │
│  ← secrets never leave here │
└─────────────────────────────┘`,
  },
  {
    icon: MessageSquare,
    title: "Drive Agents from Anywhere",
    desc: "WhatsApp. iMessage. Slack. Discord. Voice calls. Email. SMS. Telegram. Web. CLI. API. First-class, not bolted on.",
    snippet: `// 11 built-in surfaces
WhatsApp  iMessage  Slack
Discord   Telegram  Email
SMS       Voice     Web
CLI       REST API
// Two-way — agents reply in the
// same channel you messaged from.`,
  },
  {
    icon: Gauge,
    title: "Cost Intelligence",
    desc: "Routes cheap prompts to small models. Escalates only when needed. Customers save 60% on LLM costs versus fixed-model.",
    snippet: `// Before Lantern:
//   All prompts → GPT-4   $0.42/run

// After Lantern (auto routing):
//   Triage    → Haiku     $0.002
//   Search    → GPT-4o-m  $0.01
//   Synthesis → Opus      $0.08
//   Total:                $0.092
//   Savings:              -78%`,
  },
];

function Features() {
  return (
    <section id="features" className="relative py-32 px-6">
      <div className="max-w-7xl mx-auto">
        <FadeIn>
          <div className="text-center mb-20">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              What makes Lantern{" "}
              <span className="gradient-text">different</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              Six capabilities that no other platform ships together. Each one is
              production-grade, not a checkbox.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {featureCards.map((card, i) => (
            <FadeIn key={card.title} delay={i * 0.08}>
              <div className="feature-card p-6 h-full flex flex-col">
                <div className="flex items-center gap-3 mb-3">
                  <card.icon className="w-7 h-7 text-lantern-500 shrink-0" />
                  <h3 className="text-lg font-bold">{card.title}</h3>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed mb-4">
                  {card.desc}
                </p>
                <div className="code-block p-4 mt-auto">
                  <pre className="text-xs sm:text-[13px] font-mono text-zinc-400 overflow-x-auto leading-relaxed whitespace-pre">
                    {card.snippet}
                  </pre>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  60-Second Tour — annotated code block                */
/* ───────────────────────────────────────────────────── */
function CodeTour() {
  return (
    <section id="tour" className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              60-second{" "}
              <span className="gradient-text">tour</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              A complete production agent in 30 lines. Durable steps. Smart
              routing. Parallel fan-out. Human-in-the-loop. All built in.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="code-block glow-amber p-1 max-w-4xl mx-auto">
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
              <code>
                <span className="text-purple-400">import</span>
                <span className="text-zinc-300">
                  {" "}
                  {"{"} agent, step {"}"}{" "}
                </span>
                <span className="text-purple-400">from</span>
                <span className="text-emerald-400">
                  {" "}
                  &quot;@lantern/sdk&quot;
                </span>
                <span className="text-zinc-500">;</span>
                {"\n\n"}
                <span className="text-purple-400">export default</span>
                <span className="text-blue-400"> agent</span>
                <span className="text-zinc-300">({"{"}</span>
                {"\n"}
                <span className="text-zinc-300">{"  "}name: </span>
                <span className="text-emerald-400">
                  &quot;research-agent&quot;
                </span>
                <span className="text-zinc-500">,</span>
                {"\n"}
                <span className="text-zinc-300">{"  "}model: </span>
                <span className="text-emerald-400">&quot;auto&quot;</span>
                <span className="text-zinc-500">,</span>
                <span className="text-zinc-600">
                  {"        "}
                  {"// "}&#8592; routes to best model for each task
                </span>
                {"\n\n"}
                <span className="text-zinc-300">{"  "}</span>
                <span className="text-purple-400">async</span>
                <span className="text-blue-400"> run</span>
                <span className="text-zinc-300">
                  ({"{"} input, ctx {"}"}) {"{"}
                </span>
                {"\n"}
                <span className="text-zinc-600">
                  {"    "}
                  {"// Step 1: Generate search queries (survives crashes!)"}
                </span>
                {"\n"}
                <span className="text-purple-400">{"    "}const</span>
                <span className="text-zinc-300"> queries = </span>
                <span className="text-purple-400">await</span>
                <span className="text-blue-400"> step</span>
                <span className="text-zinc-300">(</span>
                <span className="text-emerald-400">&quot;plan&quot;</span>
                <span className="text-zinc-300">, </span>
                <span className="text-purple-400">async</span>
                <span className="text-zinc-300"> () =&gt; {"{"}</span>
                {"\n"}
                <span className="text-zinc-300">
                  {"      "}
                  <span className="text-purple-400">return</span> ctx.llm.
                  <span className="text-blue-400">json</span>({"{"})
                </span>
                {"\n"}
                <span className="text-zinc-300">{"        "}prompt: </span>
                <span className="text-emerald-400">
                  {"`"}Research queries for: {"${"}input.topic{"}"}{"`"}
                </span>
                <span className="text-zinc-500">,</span>
                {"\n"}
                <span className="text-zinc-300">
                  {"        "}capability:{" "}
                </span>
                <span className="text-emerald-400">
                  &quot;reasoning-small&quot;
                </span>
                <span className="text-zinc-500">,</span>
                <span className="text-zinc-600">
                  {" "}
                  {"// "}&#8592; cheap model is fine here
                </span>
                {"\n"}
                <span className="text-zinc-300">{"      "}{"}"});</span>
                {"\n"}
                <span className="text-zinc-300">{"    "}{"}"});</span>
                {"\n\n"}
                <span className="text-zinc-600">
                  {"    "}
                  {"// Step 2: Search in parallel (fan-out)"}
                </span>
                {"\n"}
                <span className="text-purple-400">{"    "}const</span>
                <span className="text-zinc-300"> results = </span>
                <span className="text-purple-400">await</span>
                <span className="text-zinc-300"> step.</span>
                <span className="text-blue-400">map</span>
                <span className="text-zinc-300">(</span>
                <span className="text-emerald-400">&quot;search&quot;</span>
                <span className="text-zinc-300">, queries, </span>
                <span className="text-purple-400">async</span>
                <span className="text-zinc-300"> (q) =&gt; {"{"}</span>
                {"\n"}
                <span className="text-zinc-300">
                  {"      "}
                  <span className="text-purple-400">return</span> ctx.tools.web.
                  <span className="text-blue-400">search</span>(q);
                </span>
                {"\n"}
                <span className="text-zinc-300">{"    "}{"}"});</span>
                <span className="text-zinc-600">
                  {"       "}
                  {"// "}&#8592; each search is its own durable step
                </span>
                {"\n\n"}
                <span className="text-zinc-600">
                  {"    "}
                  {"// Step 3: Synthesize with the big guns"}
                </span>
                {"\n"}
                <span className="text-zinc-300">{"    "}</span>
                <span className="text-purple-400">return</span>
                <span className="text-blue-400"> step</span>
                <span className="text-zinc-300">(</span>
                <span className="text-emerald-400">
                  &quot;synthesize&quot;
                </span>
                <span className="text-zinc-300">, </span>
                <span className="text-purple-400">async</span>
                <span className="text-zinc-300"> () =&gt; {"{"}</span>
                {"\n"}
                <span className="text-zinc-300">
                  {"      "}
                  <span className="text-purple-400">return</span> ctx.llm.
                  <span className="text-blue-400">complete</span>({"{"})
                </span>
                {"\n"}
                <span className="text-zinc-300">
                  {"        "}messages: [{"{"} role:{" "}
                </span>
                <span className="text-emerald-400">&quot;user&quot;</span>
                <span className="text-zinc-300">, content: </span>
                <span className="text-blue-400">formatResults</span>
                <span className="text-zinc-300">(results) {"}"}],</span>
                {"\n"}
                <span className="text-zinc-300">
                  {"        "}capability:{" "}
                </span>
                <span className="text-emerald-400">
                  &quot;reasoning-large&quot;
                </span>
                <span className="text-zinc-500">,</span>
                <span className="text-zinc-600">
                  {" "}
                  {"// "}&#8592; heavy model for synthesis
                </span>
                {"\n"}
                <span className="text-zinc-300">{"      "}{"}"});</span>
                {"\n"}
                <span className="text-zinc-300">{"    "}{"}"});</span>
                {"\n"}
                <span className="text-zinc-300">{"  "}{"}"}</span>
                {"\n"}
                <span className="text-zinc-300">{"}"});</span>
              </code>
            </pre>
          </div>
        </FadeIn>

        {/* Annotation callouts */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-10 max-w-4xl mx-auto">
          {[
            {
              label: "Durable steps",
              detail:
                "Each step() is journaled. If the process crashes mid-run, it resumes from the last completed step.",
            },
            {
              label: "Capability routing",
              detail:
                '"reasoning-small" and "reasoning-large" map to the best available model at runtime. No vendor lock-in.',
            },
            {
              label: "Parallel fan-out",
              detail:
                "step.map() runs N tasks concurrently, each tracked as its own durable step with independent retries.",
            },
          ].map((a, i) => (
            <FadeIn key={a.label} delay={0.1 * i}>
              <div className="text-center p-4">
                <div className="text-sm font-bold text-lantern-400 mb-1">
                  {a.label}
                </div>
                <div className="text-xs text-zinc-500 leading-relaxed">
                  {a.detail}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Architecture Diagram                                 */
/* ───────────────────────────────────────────────────── */
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
              Control plane in our cloud. Data plane in yours. Agents stream
              end-to-end through the full stack.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="code-block p-8 sm:p-12 overflow-x-auto">
            <pre className="text-xs sm:text-sm font-mono text-zinc-400 leading-relaxed whitespace-pre">
              {`  WhatsApp / Slack / Voice / iMessage / Email / Web / CLI
                                  │
                                  ▼
                    ┌──────────────────────────┐
                    │      Surface Gateway      │  Unified ingress
                    └────────────┬─────────────┘
                                 │ HTTPS + WS
                    ┌────────────▼─────────────┐
                    │   Control Plane           │  Lantern SaaS
                    │   scheduling · routing    │
                    │   workflows · dashboard   │
                    └────────────┬─────────────┘
                                 │ gRPC tunnel (mTLS)
                    ┌────────────▼─────────────┐
                    │   Data Plane (Your VPC)   │  AWS / GCP / Azure
                    │                           │
                    │   ┌───────────────────┐   │
                    │   │ Firecracker       │   │
                    │   │ MicroVMs          │   │  150ms warm start
                    │   │ ┌─────┐ ┌─────┐  │   │  Real isolation
                    │   │ │Run 1│ │Run 2│  │   │  Secrets stay here
                    │   │ └─────┘ └─────┘  │   │
                    │   └───────────────────┘   │
                    │                           │
                    │   K8s Jobs / Kata Pods    │
                    └───────────────────────────┘`}
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
              label:
                "Token cost reduction via smart routing + context management",
            },
            {
              stat: "< 20ms",
              label:
                "Streaming overhead end-to-end through the full stack",
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

/* ───────────────────────────────────────────────────── */
/*  Deploy in 3 Commands                                 */
/* ───────────────────────────────────────────────────── */
function DeployCommands() {
  return (
    <section className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-4xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Deploy in{" "}
              <span className="gradient-text">3 commands</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-xl mx-auto">
              From zero to production agent running in your cloud. No YAML. No
              Terraform. No Docker.
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.15}>
          <div className="space-y-4 max-w-3xl mx-auto">
            {/* Command 1 */}
            <div className="code-block p-1">
              <div className="flex items-center gap-3 px-5 py-1.5 border-b border-white/5">
                <div className="w-6 h-6 rounded-full bg-lantern-600/20 text-lantern-400 text-xs font-bold flex items-center justify-center">
                  1
                </div>
                <span className="text-xs text-zinc-500">
                  Scaffold from a template
                </span>
              </div>
              <pre className="px-5 py-4 text-sm sm:text-base font-mono overflow-x-auto">
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span>{" "}
                <span className="text-zinc-300">
                  init my-agent --template research
                </span>
              </pre>
            </div>

            {/* Command 2 */}
            <div className="code-block p-1">
              <div className="flex items-center gap-3 px-5 py-1.5 border-b border-white/5">
                <div className="w-6 h-6 rounded-full bg-lantern-600/20 text-lantern-400 text-xs font-bold flex items-center justify-center">
                  2
                </div>
                <span className="text-xs text-zinc-500">
                  Test locally with live streaming
                </span>
              </div>
              <pre className="px-5 py-4 text-sm sm:text-base font-mono overflow-x-auto">
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span>{" "}
                <span className="text-zinc-300">
                  run my-agent --input &apos;{"{"}
                  &quot;topic&quot;: &quot;quantum computing&quot;{"}"}
                  &apos;
                </span>
              </pre>
            </div>

            {/* Command 3 */}
            <div className="code-block p-1">
              <div className="flex items-center gap-3 px-5 py-1.5 border-b border-white/5">
                <div className="w-6 h-6 rounded-full bg-lantern-600/20 text-lantern-400 text-xs font-bold flex items-center justify-center">
                  3
                </div>
                <span className="text-xs text-zinc-500">
                  Ship to your cloud in one line
                </span>
              </div>
              <pre className="px-5 py-4 text-sm sm:text-base font-mono overflow-x-auto">
                <span className="text-zinc-500">$</span>{" "}
                <span className="text-lantern-400">lantern</span>{" "}
                <span className="text-zinc-300">
                  deploy --cloud aws --region us-east-1
                </span>
                {"\n"}
                <span className="text-emerald-400">
                  {"  "}&#10003; deployed{" "}
                </span>
                <span className="text-blue-400">
                  https://acme.lantern.run/my-agent
                </span>
              </pre>
            </div>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Pricing                                              */
/* ───────────────────────────────────────────────────── */
const pricingTiers = [
  {
    name: "Personal",
    price: "Free",
    period: "",
    description: "Mobile-first. E2E encrypted. For individuals automating their day-to-day.",
    features: [
      "1,000 runs / month",
      "E2E encrypted vault",
      "Mobile app + chat surfaces",
      "5 connectors",
      "Community support",
      "30-day history",
    ],
    cta: "Start free",
    highlighted: false,
  },
  {
    name: "Team",
    price: "$29",
    period: "/seat/mo",
    description: "Dashboard. Collaboration. For teams shipping agents to production.",
    features: [
      "10,000 runs / month",
      "Everything in Personal",
      "Dashboard + RBAC",
      "Slack / Discord surfaces",
      "Custom connectors",
      "Priority support",
    ],
    cta: "Start your team",
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "Self-hosted or hybrid. Data plane in your VPC. SSO/SCIM.",
    features: [
      "Unlimited runs",
      "Everything in Team",
      "Self-hosted data plane",
      "SAML SSO + SCIM",
      "BYOK encryption",
      "99.95% SLA + dedicated support",
    ],
    cta: "Talk to sales",
    highlighted: false,
  },
];

function Pricing() {
  return (
    <section
      id="pricing"
      className="relative py-32 px-6 border-t border-white/5"
    >
      <div className="max-w-5xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Cheaper than{" "}
              <span className="gradient-text">doing it yourself</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-xl mx-auto">
              Start free. Scale as you grow. Bring your own cloud at Enterprise.
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
                  href={
                    tier.name === "Enterprise"
                      ? "mailto:sales@lantern.run"
                      : "https://app.lantern.run/signup"
                  }
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
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Use Case Showcase                                    */
/* ───────────────────────────────────────────────────── */
const useCases: {
  icon: typeof Search;
  title: string;
  desc: string;
}[] = [
  {
    icon: Search,
    title: "AI Talent Search",
    desc: "Find and engage top AI candidates across LinkedIn, GitHub, and academic papers. Durable workflows that run for days without losing state.",
  },
  {
    icon: Smartphone,
    title: "Personal WhatsApp Assistant",
    desc: "Manage your calendar, email, and tasks from WhatsApp. E2E encrypted. Runs on your phone as the remote.",
  },
  {
    icon: ShieldCheck,
    title: "CI/CD Guardian",
    desc: "Analyze every deploy for risk. Auto-approve safe changes. Block and notify on risky ones. Human-in-the-loop built in.",
  },
  {
    icon: Headphones,
    title: "Customer Support",
    desc: "Handle tickets with memory, approval gates, and human-in-the-loop escalation. Resolves 70% autonomously, escalates the rest.",
  },
];

function UseCases() {
  return (
    <section className="relative py-32 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <FadeIn>
          <div className="text-center mb-16">
            <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">
              Built for the{" "}
              <span className="gradient-text">real world</span>
            </h2>
            <p className="text-zinc-400 text-lg max-w-2xl mx-auto">
              Not toy demos. These are agents that companies run in production
              today.
            </p>
          </div>
        </FadeIn>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          {useCases.map((uc, i) => (
            <FadeIn key={uc.title} delay={i * 0.08}>
              <div className="feature-card p-8 h-full">
                <uc.icon className="w-8 h-8 text-lantern-500 mb-4" />
                <h3 className="text-lg font-bold mb-2">{uc.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {uc.desc}
                </p>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Social Proof                                         */
/* ───────────────────────────────────────────────────── */
function SocialProof() {
  const companies = [
    "Stripe",
    "Notion",
    "Linear",
    "Vercel",
    "Supabase",
    "Replit",
    "Raycast",
    "Resend",
  ];

  return (
    <section className="relative py-20 px-6 border-t border-white/5">
      <div className="max-w-5xl mx-auto">
        <FadeIn>
          <p className="text-center text-sm text-zinc-600 uppercase tracking-widest mb-10">
            Trusted by engineers at
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
            {companies.map((name) => (
              <span
                key={name}
                className="text-xl sm:text-2xl font-bold text-zinc-700 hover:text-zinc-500 transition-colors cursor-default"
              >
                {name}
              </span>
            ))}
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  CTA                                                  */
/* ───────────────────────────────────────────────────── */
function CTA() {
  return (
    <section className="relative py-32 px-6 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-lantern-900/10 to-transparent pointer-events-none" />
      <div className="relative max-w-3xl mx-auto text-center">
        <FadeIn>
          <Flame className="w-12 h-12 text-lantern-500 mx-auto mb-6 animate-[float_4s_ease-in-out_infinite]" />
          <h2 className="text-4xl sm:text-6xl font-black tracking-tight mb-6">
            Start building in
            <br />
            <span className="gradient-text">60 seconds.</span>
          </h2>
          <p className="text-zinc-400 text-lg mb-10 max-w-xl mx-auto">
            Your first agent is free. Deploy in three commands. Monitor from your
            phone. Scale to a million runs without ops.
          </p>

          {/* Sign-up form */}
          <div className="max-w-md mx-auto mb-8">
            <form
              action="https://app.lantern.run/signup"
              className="flex flex-col sm:flex-row gap-3"
            >
              <input
                type="email"
                placeholder="you@company.com"
                className="flex-1 px-5 py-3.5 rounded-xl bg-surface-1 border border-zinc-800 text-white placeholder:text-zinc-600 text-sm focus:outline-none focus:border-lantern-600 focus:ring-1 focus:ring-lantern-600/50 transition-all"
              />
              <button
                type="submit"
                className="group flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl bg-lantern-600 hover:bg-lantern-500 text-white font-semibold text-sm transition-all hover:shadow-xl hover:shadow-lantern-600/25 hover:-translate-y-0.5 shrink-0"
              >
                Get started
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </button>
            </form>
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <a
              href="https://github.com/dshakes/lantern"
              className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <Github className="w-4 h-4" />
              View on GitHub
            </a>
            <span className="hidden sm:inline text-zinc-700">|</span>
            <a
              href="https://docs.lantern.run/quickstart"
              className="flex items-center gap-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Quickstart guide
            </a>
          </div>
        </FadeIn>
      </div>
    </section>
  );
}

/* ───────────────────────────────────────────────────── */
/*  Footer                                               */
/* ───────────────────────────────────────────────────── */
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
              links: [
                { label: "Features", href: "#features" },
                { label: "Pricing", href: "#pricing" },
                { label: "Changelog", href: "#" },
                { label: "Roadmap", href: "#" },
                { label: "Status", href: "#" },
              ],
            },
            {
              title: "Resources",
              links: [
                {
                  label: "Docs",
                  href: "https://docs.lantern.run",
                },
                { label: "API Reference", href: "#" },
                { label: "Quickstart", href: "#" },
                {
                  label: "GitHub",
                  href: "https://github.com/dshakes/lantern",
                },
                { label: "Blog", href: "#" },
              ],
            },
            {
              title: "Company",
              links: [
                { label: "About", href: "#" },
                { label: "Careers", href: "#" },
                { label: "Contact", href: "mailto:hello@lantern.run" },
                { label: "Discord", href: "#" },
                { label: "Privacy", href: "#" },
              ],
            },
          ].map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold mb-4">{col.title}</h4>
              <ul className="space-y-2">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      {link.label}
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
            <a
              href="https://github.com/dshakes/lantern"
              className="text-xs text-zinc-600 hover:text-zinc-400"
            >
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

/* ───────────────────────────────────────────────────── */
/*  Page                                                 */
/* ───────────────────────────────────────────────────── */
export default function LandingPage() {
  return (
    <main className="relative">
      <Navbar />
      <Hero />
      <ComparisonTable />
      <Features />
      <CodeTour />
      <Architecture />
      <DeployCommands />
      <Pricing />
      <UseCases />
      <SocialProof />
      <CTA />
      <Footer />
    </main>
  );
}
