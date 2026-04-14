"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { Route, Shield, Zap, Workflow, Eye, Globe } from "lucide-react";

function FadeIn({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.5 }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

const features = [
  { icon: Route, title: "Smart Model Routing", desc: "Address models by capability, not name. The router picks Claude, GPT, or Gemini based on cost, latency, and task." },
  { icon: Workflow, title: "Durable Execution", desc: "Every LLM call is a replayable step. Agents survive crashes, redeploys, and network failures automatically." },
  { icon: Shield, title: "MicroVM Isolation", desc: "Untrusted code runs in Firecracker microVMs. Sub-second cold starts with full sandboxing." },
  { icon: Zap, title: "Streaming-First", desc: "Token streams flow end-to-end with zero buffering. From runtime to gateway to SDK to dashboard." },
  { icon: Eye, title: "Full Observability", desc: "OpenTelemetry traces on every run with tenant, agent, and step-level granularity. Built in, not bolted on." },
  { icon: Globe, title: "Deploy Anywhere", desc: "Your cloud, our cloud, or self-hosted on Kubernetes. Single binary CLI, no vendor lock-in." },
];

const steps = [
  { num: "01", title: "Define", desc: "Write your agent in TypeScript. Declare steps, models, and connectors.", code: `import { agent } from "@lantern/sdk"\n\nexport default agent({\n  name: "research-bot",\n  model: "auto",\n})` },
  { num: "02", title: "Test", desc: "Run locally with real LLM calls. Step-by-step traces in your terminal.", code: `$ lantern dev\n\n▸ research-bot running\n▸ step/fetch    1.2s  ✓\n▸ step/analyze  2.8s  ✓\n▸ done          4.0s` },
  { num: "03", title: "Deploy", desc: "One command to production. Zero-downtime deploys with automatic rollback.", code: `$ lantern deploy --prod\n\n✓ Built in 3.2s\n✓ Deployed to us-east-1\n✓ https://research-bot.lantern.run` },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full bg-[#09090b]/80 backdrop-blur-lg border-b border-white/[0.06]">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-6">
          <a href="/" className="text-lg font-semibold text-white">Lantern</a>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-[#a1a1aa] transition-colors hover:text-white">Features</a>
            <a href="https://docs.lantern.run" className="text-sm text-[#a1a1aa] transition-colors hover:text-white">Docs</a>
            <a href="https://github.com/lantern-run/lantern" className="text-sm text-[#a1a1aa] transition-colors hover:text-white">GitHub</a>
            <a href="https://docs.lantern.run/quickstart" className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-opacity hover:opacity-90">Get started</a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="hero-glow pt-32 pb-20">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <FadeIn>
            <h1 className="text-[56px] font-bold leading-[1.1] tracking-[-0.03em] text-white md:text-[72px]">
              AI agents for production.
            </h1>
          </FadeIn>
          <FadeIn>
            <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-[#a1a1aa]">
              Build, test, and deploy autonomous agents across Claude, GPT, and Gemini. Durable execution. Smart routing. Open source.
            </p>
          </FadeIn>
          <FadeIn>
            <div className="mt-8 flex items-center justify-center gap-4">
              <a href="https://docs.lantern.run/quickstart" className="rounded-lg bg-white px-5 py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90">Get started</a>
              <a href="https://github.com/lantern-run/lantern" className="rounded-lg border border-white/10 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:border-white/20">View on GitHub</a>
            </div>
          </FadeIn>
          <FadeIn>
            <div className="mx-auto mt-14 max-w-2xl overflow-hidden rounded-xl border border-white/[0.06] bg-[#111113] text-left">
              <div className="border-b border-white/[0.06] px-4 py-2.5">
                <span className="font-mono text-xs text-[#71717a]">agent.ts</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed">
                <code>
                  <span className="text-[#818cf8]">import</span>
                  <span className="text-[#e4e4e7]">{" { agent, step } "}</span>
                  <span className="text-[#818cf8]">from</span>
                  <span className="text-[#34d399]">{' "@lantern/sdk"'}</span>
                  <span className="text-[#e4e4e7]">;</span>
                  {"\n\n"}
                  <span className="text-[#818cf8]">export default</span>
                  <span className="text-[#e4e4e7]">{" agent({"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"  name: "}</span>
                  <span className="text-[#34d399]">{'"email-digest"'}</span>
                  <span className="text-[#e4e4e7]">,</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"  model: "}</span>
                  <span className="text-[#34d399]">{'"auto"'}</span>
                  <span className="text-[#e4e4e7]">,</span>
                  {"\n\n"}
                  <span className="text-[#e4e4e7]">{"  "}</span>
                  <span className="text-[#818cf8]">async</span>
                  <span className="text-[#e4e4e7]">{" run({ ctx }) {"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"    "}</span>
                  <span className="text-[#818cf8]">const</span>
                  <span className="text-[#e4e4e7]">{" emails = "}</span>
                  <span className="text-[#818cf8]">await</span>
                  <span className="text-[#e4e4e7]">{" step("}</span>
                  <span className="text-[#34d399]">{'"fetch"'}</span>
                  <span className="text-[#e4e4e7]">{", () =>"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"      ctx.connectors.gmail.listMessages({ limit: 20 })"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"    );"}</span>
                  {"\n\n"}
                  <span className="text-[#e4e4e7]">{"    "}</span>
                  <span className="text-[#818cf8]">return</span>
                  <span className="text-[#e4e4e7]">{" step("}</span>
                  <span className="text-[#34d399]">{'"summarize"'}</span>
                  <span className="text-[#e4e4e7]">{", () =>"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"      ctx.llm.complete({"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"        prompt: "}</span>
                  <span className="text-[#34d399]">{"`Summarize these ${emails.length} emails`"}</span>
                  <span className="text-[#e4e4e7]">,</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"      })"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"    );"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"  },"}</span>
                  {"\n"}
                  <span className="text-[#e4e4e7]">{"});"}</span>
                </code>
              </pre>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-5xl">
          <FadeIn><h2 className="text-center text-4xl font-semibold tracking-[-0.02em] text-white md:text-5xl">Three steps to production.</h2></FadeIn>
          <div className="mt-16 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <FadeIn key={s.num}>
                <div>
                  <span className="font-mono text-sm font-medium text-[#818cf8]">{s.num}</span>
                  <h3 className="mt-3 text-base font-medium text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#a1a1aa]">{s.desc}</p>
                  <pre className="mt-4 overflow-x-auto rounded-lg border border-white/[0.06] bg-[#111113] p-4 font-mono text-xs leading-relaxed text-[#a1a1aa]">{s.code}</pre>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6">
        <div className="mx-auto max-w-5xl">
          <FadeIn><h2 className="text-center text-4xl font-semibold tracking-[-0.02em] text-white md:text-5xl">Built for production.</h2></FadeIn>
          <div className="mt-16 grid gap-6 md:grid-cols-2">
            {features.map((f) => (
              <FadeIn key={f.title}>
                <div className="rounded-xl border border-white/[0.06] bg-[#111113] p-6 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.12]">
                  <f.icon className="h-5 w-5 text-[#818cf8]" />
                  <h3 className="mt-4 text-base font-medium text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[#a1a1aa]">{f.desc}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* Product Preview */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-5xl">
          <FadeIn>
            <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-[#111113]">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-4">
                <span className="font-mono text-sm text-white">email-digest</span>
                <span className="flex items-center gap-2 text-xs text-emerald-400">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Running
                </span>
              </div>
              <div className="px-6 py-5">
                <p className="text-sm leading-relaxed text-[#e4e4e7]">
                  Here&apos;s your daily summary: 12 new emails. 3 require action &mdash; invoice from Acme Corp, PR review request from Sarah, and meeting reschedule from the design team.
                </p>
                <div className="mt-5 flex gap-6 border-t border-white/[0.06] pt-4 font-mono text-xs text-[#71717a]">
                  <span>claude-sonnet</span>
                  <span>847 tokens</span>
                  <span>1.6s</span>
                  <span>3 steps</span>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Pricing */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-5xl">
          <FadeIn><h2 className="text-center text-4xl font-semibold tracking-[-0.02em] text-white md:text-5xl">Simple pricing.</h2></FadeIn>
          <FadeIn>
            <div className="mx-auto mt-16 max-w-2xl divide-y divide-white/[0.06]">
              <div className="flex items-center justify-between py-5">
                <span className="text-sm font-medium text-white">Alpha</span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-white">Free</span>
                  <a href="https://docs.lantern.run/quickstart" className="text-sm font-medium text-[#818cf8] transition-colors hover:text-[#6366f1]">Get started &rarr;</a>
                </div>
              </div>
              <div className="flex items-center justify-between py-5">
                <span className="text-sm font-medium text-white">Team</span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-[#a1a1aa]">$29/seat</span>
                  <span className="text-sm text-[#71717a]">Coming soon</span>
                </div>
              </div>
              <div className="flex items-center justify-between py-5">
                <span className="text-sm font-medium text-white">Enterprise</span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-[#a1a1aa]">Custom</span>
                  <a href="mailto:hello@lantern.run" className="text-sm font-medium text-[#818cf8] transition-colors hover:text-[#6366f1]">Contact &rarr;</a>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-5xl text-center">
          <FadeIn>
            <h2 className="text-4xl font-semibold tracking-[-0.02em] text-white md:text-5xl">Start building.</h2>
            <p className="mt-4 text-lg text-[#a1a1aa]">Free during alpha. No credit card.</p>
            <div className="mt-8">
              <a href="https://docs.lantern.run/quickstart" className="rounded-lg bg-white px-6 py-3 text-sm font-medium text-black transition-opacity hover:opacity-90">Get started</a>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/[0.06] px-6 py-8">
        <div className="mx-auto flex max-w-5xl items-center justify-between">
          <span className="text-sm text-[#71717a]">&copy; 2026 Lantern</span>
          <div className="flex items-center gap-6">
            <a href="https://docs.lantern.run" className="text-sm text-[#71717a] transition-colors hover:text-white">Docs</a>
            <a href="https://github.com/lantern-run/lantern" className="text-sm text-[#71717a] transition-colors hover:text-white">GitHub</a>
            <a href="https://twitter.com/lanternrun" className="text-sm text-[#71717a] transition-colors hover:text-white">Twitter</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
