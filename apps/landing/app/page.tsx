"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";

function FadeIn({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 16 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ── Data ─────────────────────────────────────────── */

const features = [
  {
    title: "Smart Routing",
    desc: "Routes to the best model automatically. Claude, GPT, Gemini.",
  },
  {
    title: "Managed Sessions",
    desc: "Interactive, durable conversations that survive reconnects.",
  },
  {
    title: "17 Connectors",
    desc: "Gmail, Slack, GitHub, Stripe — real API calls, not stubs.",
  },
  {
    title: "Visual Editor",
    desc: "Drag-and-drop for non-technical users. Code for developers.",
  },
  {
    title: "A2A Protocol",
    desc: "Your agents are discoverable by other platforms via Agent-to-Agent.",
  },
  {
    title: "Deploy Anywhere",
    desc: "Your cloud, our cloud, or self-hosted. Runs on Kubernetes.",
  },
];

const steps = [
  {
    num: "01",
    title: "Create",
    desc: "Describe your agent in plain language or use a template.",
  },
  {
    num: "02",
    title: "Test",
    desc: "Run it instantly. See real LLM output with step-by-step traces.",
  },
  {
    num: "03",
    title: "Deploy",
    desc: "One command to production. Your cloud or ours.",
  },
];

/* ── Page ─────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full bg-[#000]/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <a href="/" className="text-lg font-bold text-[#ededed]">
            Lantern
          </a>
          <div className="flex items-center gap-6">
            <a
              href="#features"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              Features
            </a>
            <a
              href="https://docs.lantern.run"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              Docs
            </a>
            <a
              href="https://github.com/lantern-run/lantern"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              GitHub
            </a>
            <a
              href="https://docs.lantern.run/quickstart"
              className="rounded-md bg-[#8b5cf6] px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#7c3aed]"
            >
              Get started
            </a>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-28 pb-12 md:pt-36">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <h1 className="text-5xl font-bold leading-[1.1] tracking-tight text-[#ededed] md:text-7xl">
              AI agents for production
            </h1>
          </FadeIn>
          <FadeIn>
            <p className="mt-4 max-w-lg text-lg text-[#888]">
              Build, test, and ship agents across Claude, GPT, and Gemini.
              Open source.
            </p>
          </FadeIn>
          <FadeIn>
            <div className="mt-8 flex items-center gap-4">
              <a
                href="https://docs.lantern.run/quickstart"
                className="rounded-md bg-[#8b5cf6] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#7c3aed]"
              >
                Get started
              </a>
              <a
                href="https://github.com/lantern-run/lantern"
                className="rounded-md border border-[#222] px-5 py-2.5 text-sm font-medium text-[#ededed] transition-colors hover:border-[#444]"
              >
                View on GitHub
              </a>
            </div>
          </FadeIn>

          {/* Code example */}
          <FadeIn>
            <div className="mt-12 overflow-hidden rounded-lg border border-[#222] bg-[#111]">
              <div className="border-b border-[#222] px-4 py-2.5">
                <span className="font-mono text-xs text-[#888]">
                  agent.ts
                </span>
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
                <code>
                  <span className="text-[#8b5cf6]">import</span>
                  <span className="text-[#ededed]">{" { agent, step } "}</span>
                  <span className="text-[#8b5cf6]">from</span>
                  <span className="text-[#22c55e]">
                    {' "@lantern/sdk"'}
                  </span>
                  <span className="text-[#ededed]">;</span>
                  {"\n\n"}
                  <span className="text-[#8b5cf6]">export default</span>
                  <span className="text-[#ededed]">
                    {" agent({"}
                  </span>
                  {"\n"}
                  <span className="text-[#ededed]">{"  name: "}</span>
                  <span className="text-[#22c55e]">{'"email-digest"'}</span>
                  <span className="text-[#ededed]">,</span>
                  {"\n"}
                  <span className="text-[#ededed]">{"  model: "}</span>
                  <span className="text-[#22c55e]">{'"auto"'}</span>
                  <span className="text-[#ededed]">,</span>
                  {"\n\n"}
                  <span className="text-[#ededed]">{"  "}</span>
                  <span className="text-[#8b5cf6]">async</span>
                  <span className="text-[#ededed]">
                    {" run({ ctx }) {"}
                  </span>
                  {"\n"}
                  <span className="text-[#ededed]">{"    "}</span>
                  <span className="text-[#8b5cf6]">const</span>
                  <span className="text-[#ededed]">
                    {" emails = "}
                  </span>
                  <span className="text-[#8b5cf6]">await</span>
                  <span className="text-[#ededed]">
                    {' step('}
                  </span>
                  <span className="text-[#22c55e]">{'"fetch"'}</span>
                  <span className="text-[#ededed]">{", () =>"}</span>
                  {"\n"}
                  <span className="text-[#ededed]">
                    {"      ctx.connectors.gmail.listMessages({ limit: 20 })"}
                  </span>
                  {"\n"}
                  <span className="text-[#ededed]">{"    );"}</span>
                  {"\n\n"}
                  <span className="text-[#ededed]">{"    "}</span>
                  <span className="text-[#8b5cf6]">return</span>
                  <span className="text-[#ededed]">
                    {' step('}
                  </span>
                  <span className="text-[#22c55e]">{'"summarize"'}</span>
                  <span className="text-[#ededed]">{", () =>"}</span>
                  {"\n"}
                  <span className="text-[#ededed]">
                    {"      ctx.llm.complete({"}
                  </span>
                  {"\n"}
                  <span className="text-[#ededed]">{"        prompt: "}</span>
                  <span className="text-[#22c55e]">
                    {"`Summarize these ${emails.length} emails`"}
                  </span>
                  <span className="text-[#ededed]">,</span>
                  {"\n"}
                  <span className="text-[#ededed]">
                    {"        capability: "}
                  </span>
                  <span className="text-[#22c55e]">
                    {'"reasoning-small"'}
                  </span>
                  <span className="text-[#ededed]">,</span>
                  {"\n"}
                  <span className="text-[#ededed]">{"      })"}</span>
                  {"\n"}
                  <span className="text-[#ededed]">{"    );"}</span>
                  {"\n"}
                  <span className="text-[#ededed]">{"  },"}</span>
                  {"\n"}
                  <span className="text-[#ededed]">{"});"}</span>
                </code>
              </pre>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <h2 className="text-2xl font-bold text-[#ededed] md:text-3xl">
              Everything agents need
            </h2>
          </FadeIn>
          <div className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-3">
            {features.map((f) => (
              <FadeIn key={f.title}>
                <div>
                  <h3 className="text-sm font-semibold text-[#ededed]">
                    {f.title}
                  </h3>
                  <p className="mt-1 text-sm text-[#888]">{f.desc}</p>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <h2 className="text-2xl font-bold text-[#ededed] md:text-3xl">
              How it works
            </h2>
          </FadeIn>
          <div className="mt-8 space-y-6">
            {steps.map((s) => (
              <FadeIn key={s.num}>
                <div className="flex gap-6">
                  <span className="font-mono text-sm text-[#8b5cf6]">
                    {s.num}
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold text-[#ededed]">
                      {s.title}
                    </h3>
                    <p className="mt-1 text-sm text-[#888]">{s.desc}</p>
                  </div>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* Product */}
      <section className="px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <div className="overflow-hidden rounded-lg border border-[#222] bg-[#111]">
              <div className="flex items-center justify-between border-b border-[#222] px-5 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-[#ededed]">
                    email-digest
                  </span>
                </div>
                <span className="flex items-center gap-1.5 text-xs text-[#22c55e]">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#22c55e]" />
                  Running
                </span>
              </div>
              <div className="p-5">
                <p className="text-sm leading-relaxed text-[#ededed]">
                  Here&apos;s your daily summary: 12 new emails. 3 require
                  action &mdash; invoice from Acme Corp, PR review request
                  from Sarah, and meeting reschedule from the design team.
                </p>
                <div className="mt-4 flex gap-6 text-xs text-[#888]">
                  <span>1.6s</span>
                  <span>claude-sonnet</span>
                  <span>3 steps</span>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-12">
        <div className="mx-auto max-w-4xl">
          <FadeIn>
            <h2 className="text-2xl font-bold text-[#ededed] md:text-3xl">
              Pricing
            </h2>
          </FadeIn>
          <FadeIn>
            <div className="mt-8 divide-y divide-[#222]">
              <div className="flex items-center justify-between py-4">
                <span className="text-sm font-medium text-[#ededed]">
                  Alpha
                </span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-[#ededed]">Free</span>
                  <a
                    href="https://docs.lantern.run/quickstart"
                    className="text-sm text-[#8b5cf6] transition-colors hover:text-[#a78bfa]"
                  >
                    Get started &rarr;
                  </a>
                </div>
              </div>
              <div className="flex items-center justify-between py-4">
                <span className="text-sm font-medium text-[#ededed]">
                  Team
                </span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-[#888]">$29/seat</span>
                  <span className="text-sm text-[#888]">Coming soon</span>
                </div>
              </div>
              <div className="flex items-center justify-between py-4">
                <span className="text-sm font-medium text-[#ededed]">
                  Enterprise
                </span>
                <div className="flex items-center gap-8">
                  <span className="text-sm text-[#888]">Custom</span>
                  <span className="text-sm text-[#888]">Contact us</span>
                </div>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* CTA */}
      <section className="px-6 py-12">
        <div className="mx-auto max-w-4xl text-center">
          <FadeIn>
            <a
              href="https://docs.lantern.run/quickstart"
              className="rounded-md bg-[#8b5cf6] px-6 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#7c3aed]"
            >
              Start building
            </a>
          </FadeIn>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#222] px-6 py-8">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <span className="text-sm text-[#888]">&copy; 2026 Lantern</span>
          <div className="flex items-center gap-4">
            <a
              href="https://docs.lantern.run"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              Docs
            </a>
            <a
              href="https://github.com/lantern-run/lantern"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              GitHub
            </a>
            <a
              href="https://twitter.com/lanternrun"
              className="text-sm text-[#888] transition-colors hover:text-[#ededed]"
            >
              Twitter
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
