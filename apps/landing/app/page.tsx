"use client";

import { motion } from "framer-motion";
import {
  Shield,
  Gauge,
  GitBranch,
  Terminal,
  Github,
  ArrowRight,
  Sparkles,
  Server,
  Lock,
  Zap,
  Check,
  BookOpen,
} from "lucide-react";
import Link from "next/link";

// -----------------------------------------------------------------------------
// Landing page — wedge is predictable cost, eval-in-CI, and VPC-local data plane.
// No marketing fluff. Three pillars, one ten-line example each, and exit.
// -----------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#060609] text-[#f0f0f5] grain">
      <Nav />
      <Hero />
      <TrustRow />
      <Pillars />
      <CodeStory />
      <CostForecastDemo />
      <EvalCIDemo />
      <VPCDemo />
      <Stack />
      <Compare />
      <OSS />
      <CTA />
      <Footer />
    </div>
  );
}

// ─── Nav ────────────────────────────────────────────────────────────────────
function Nav() {
  return (
    <header className="fixed top-0 inset-x-0 z-40 backdrop-blur-md border-b border-white/5 bg-[#060609]/60">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="text-glow text-xl">◆</span>
          <span className="text-[15px]">lantern</span>
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm text-[#9898a8]">
          <a href="#pillars" className="nav-pill px-3 py-1.5 rounded-md">Product</a>
          <Link href="/runtime" className="nav-pill px-3 py-1.5 rounded-md">Runtime</Link>
          <a href="#stack" className="nav-pill px-3 py-1.5 rounded-md">Stack</a>
          <a href="#compare" className="nav-pill px-3 py-1.5 rounded-md">vs alternatives</a>
          <a href="https://github.com/dshakes/lantern" className="nav-pill px-3 py-1.5 rounded-md">GitHub</a>
          <a href="https://docs.lantern.dev" className="nav-pill px-3 py-1.5 rounded-md">Docs</a>
        </nav>
        <div className="flex items-center gap-2">
          <a href="https://app.lantern.run" className="hidden md:inline-flex text-sm text-[#9898a8] hover:text-white nav-pill px-3 py-1.5 rounded-md">Sign in</a>
          <a href="https://app.lantern.run/signup" className="btn-primary text-sm font-medium px-3.5 py-1.5 rounded-md text-white inline-flex items-center gap-1.5">
            Start free <ArrowRight className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────
function Hero() {
  return (
    <section className="mesh-bg relative pt-36 pb-20 px-6">
      <div className="max-w-5xl mx-auto relative z-10 text-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-teal-400/20 bg-teal-400/5 text-xs text-teal-300 mb-6"
        >
          <Sparkles className="w-3 h-3" /> Apache 2.0 · v0.4 shipping · agents that don't blow your budget
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.05]"
        >
          Agents that ship to
          <br />
          <span className="text-glow">real channels.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-6 text-lg md:text-xl text-[#9898a8] max-w-2xl mx-auto leading-relaxed"
        >
          Pair your WhatsApp, embed a webchat widget, plug in a voice number — your agent talks on the surfaces your users already use. Cost-forecasted, eval-gated, signed-receipted, deployed in your VPC. One command to boot, open-source under Apache 2.0.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <a href="https://app.lantern.run/signup" className="btn-primary px-5 py-3 rounded-lg font-semibold text-white inline-flex items-center gap-2">
            Start free <ArrowRight className="w-4 h-4" />
          </a>
          <a href="https://github.com/dshakes/lantern" className="px-5 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
            <Github className="w-4 h-4" /> View source
          </a>
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="mt-10 inline-flex items-center gap-3 px-4 py-2 rounded-full border border-white/5 bg-[#0d0d12] text-xs text-[#55556a] font-mono"
        >
          <span className="text-emerald-400">$</span> lantern dev <span className="text-[#3a3a47]"># boots the entire stack with hot reload</span>
        </motion.div>
      </div>
    </section>
  );
}

function TrustRow() {
  return (
    <section className="py-10 border-y border-white/5 bg-[#08080d]/60">
      <div className="max-w-6xl mx-auto px-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs uppercase tracking-[0.2em] text-[#55556a]">
        <span>WhatsApp</span>
        <span>·</span>
        <span>Slack</span>
        <span>·</span>
        <span>Webchat</span>
        <span>·</span>
        <span>Voice</span>
        <span>·</span>
        <span>Email</span>
        <span>·</span>
        <span>Apache 2.0</span>
        <span>·</span>
        <span>Your VPC, your data</span>
      </div>
    </section>
  );
}

// ─── Four pillars ──────────────────────────────────────────────────────────
const PILLARS = [
  {
    icon: Zap,
    tag: "Reach",
    title: "Real channels, not just chat.",
    body: "Pair your WhatsApp by scanning a QR. Embed a one-line webchat widget. Plug in a voice number. The natural communication layer paces replies, mirrors thumbs to acks, splits long answers into burst messages, and refuses to sound like ChatGPT. Your friends will not know.",
    ringFrom: "#22d3ee",
    ringTo: "#a78bfa",
  },
  {
    icon: Gauge,
    tag: "Cost",
    title: "Forecast before you dispatch.",
    body: "Every agent framework tells you what a run cost afterwards. Lantern tells you before. A single POST returns estimated tokens, dollars, and confidence — grounded in your own 30-day run history. Hard-fail the run if it would blow your budget.",
    ringFrom: "#2dd4bf",
    ringTo: "#38bdf8",
  },
  {
    icon: GitBranch,
    tag: "Quality",
    title: "Eval-in-CI + replay past failures.",
    body: "Define eval suites declaratively, pin a baseline per branch, run `lantern test --against=last-green` in CI. If the score drops, the build fails. Rehearsals replay the exact production failures that broke the previous version against the candidate. Agents stop silently getting worse.",
    ringFrom: "#818cf8",
    ringTo: "#ec4899",
  },
  {
    icon: Shield,
    tag: "Trust",
    title: "Signed receipts. Your VPC.",
    body: "Every run can issue an HMAC-signed receipt over the journal-event hash — any third party verifies at /proof. Prompts and customer data stay in your EKS/GKE/AKS. Firecracker microVM isolation. Outbound-only mTLS tunnel. SOC2-friendly by architecture.",
    ringFrom: "#fb923c",
    ringTo: "#f472b6",
  },
];

function Pillars() {
  return (
    <section id="pillars" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-14 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Why Lantern</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Four things other frameworks hand-wave.</h2>
        </header>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          {PILLARS.map((p) => (
            <div key={p.tag} className="card-glow rounded-2xl p-7 group">
              <div
                className="icon-ring mb-5"
                style={{ ["--ring-from" as never]: p.ringFrom, ["--ring-to" as never]: p.ringTo }}
              >
                <p.icon className="w-5 h-5 text-[#e8e8f0]" />
              </div>
              <p className="text-[11px] tracking-[0.2em] text-[#55556a] uppercase mb-2">{p.tag}</p>
              <h3 className="text-xl font-semibold mb-3">{p.title}</h3>
              <p className="text-sm text-[#9898a8] leading-relaxed">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Code demo (end-to-end) ────────────────────────────────────────────────
function CodeStory() {
  const code = `import { LanternClient } from "@lantern/sdk";

const lantern = new LanternClient({ apiKey: process.env.LANTERN_API_KEY });

// Hard budget — never spend more than $25/day on this agent.
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25,
  maxCostUsdPerRun: 0.10,
  hardFail: true,
});

// Forecast a run BEFORE dispatching it.
const f = await lantern.runs.forecast({
  agentName: "triage",
  input: customerEmail,
});
if (f.wouldExceedBudget) throw new Error(f.blockReason);

// Dispatch — routed via your provider keys, executed in your VPC.
const run = await lantern.runs.create({
  agentName: "triage",
  input: { email: customerEmail },
});

// In CI:  $ lantern test --agent=triage --suite=core --against=last-green
//         exits non-zero if the new version regresses.`;

  return (
    <section className="py-24 px-6 relative">
      <div className="max-w-6xl mx-auto">
        <header className="mb-10 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">End-to-end</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">30 lines. Production agent.</h2>
          <p className="mt-4 text-[#9898a8] text-lg">
            Budget, forecast, run, and regression-guard — in one file. No vendor-specific SDKs, no hand-rolled retry loops, no silent cost spirals.
          </p>
        </header>
        <div className="code-window rounded-xl border border-white/5 overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-[#0a0a0f]">
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-3 text-xs text-[#55556a] font-mono">triage-agent.ts</span>
          </div>
          <pre className="px-6 py-5 text-sm font-mono leading-[1.7] overflow-x-auto text-[#cbd5e1]">
            <code dangerouslySetInnerHTML={{ __html: syntax(code) }} />
          </pre>
        </div>
      </div>
    </section>
  );
}

// ─── Cost forecast interactive ─────────────────────────────────────────────
function CostForecastDemo() {
  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-teal-400/20 bg-teal-400/5 text-xs text-teal-300 mb-4">
            <Gauge className="w-3 h-3" /> Forecaster
          </div>
          <h3 className="text-3xl md:text-4xl font-bold tracking-tight">
            Before-the-fact cost. Every run.
          </h3>
          <p className="mt-4 text-[#9898a8] leading-relaxed">
            The forecaster blends your last 30 days of actual runs with an input-size heuristic. Confidence scales with sample size, asymptoting toward 0.95 as history grows. If a configured budget would break, the API returns HTTP 402 and blocks the run at dispatch.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[#cbd5e1]">
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Blended: historical baseline + heuristic, no black box</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Enforces per-day, per-run, and per-tool limits</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Persists predictions for continuous calibration</li>
          </ul>
        </div>
        <div className="code-window rounded-xl border border-white/5 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/5 bg-[#0a0a0f] text-xs font-mono text-[#55556a]">
            POST /v1/runs/forecast
          </div>
          <pre className="px-5 py-4 text-[13px] font-mono leading-[1.7] text-[#cbd5e1] overflow-x-auto">
{`{
  "agentName": "triage",
  "model": "auto",
  "provider": "anthropic",
  "estimatedTokensIn": 1428,
  "estimatedTokensOut": 612,
  "estimatedCostUsd": 0.0193,
  "confidence": 0.82,
  "budget": {
    "maxCostUsdPerDay": 25,
    "spentTodayUsd": 18.47,
    "remainingTodayUsd": 6.53,
    "hardFail": true
  },
  "wouldExceedBudget": false
}`}
          </pre>
        </div>
      </div>
    </section>
  );
}

// ─── Eval-in-CI demo ───────────────────────────────────────────────────────
function EvalCIDemo() {
  return (
    <section className="py-20 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <div className="code-window rounded-xl border border-white/5 overflow-hidden order-2 lg:order-1">
          <div className="px-4 py-2.5 border-b border-white/5 bg-[#0a0a0f] text-xs font-mono text-[#55556a]">
            .github/workflows/agents.yml
          </div>
          <pre className="px-5 py-4 text-[13px] font-mono leading-[1.7] text-[#cbd5e1] overflow-x-auto">
{`- name: Regression-check agent
  run: |
    lantern test \\
      --agent=triage \\
      --suite=golden \\
      --against=last-green

# Output on regression:
# [FAIL] handles-refund-request   score=0.42  980ms
# [PASS] parses-attachment        score=1.00  412ms
# Score: 0.78  (14/16 cases)
# Baseline (main): 0.92  delta -0.14
# Error: regression vs. baseline on main`}
          </pre>
        </div>
        <div className="order-1 lg:order-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-indigo-400/20 bg-indigo-400/5 text-xs text-indigo-300 mb-4">
            <GitBranch className="w-3 h-3" /> Eval-in-CI
          </div>
          <h3 className="text-3xl md:text-4xl font-bold tracking-tight">
            Agents that can't get quietly worse.
          </h3>
          <p className="mt-4 text-[#9898a8] leading-relaxed">
            Every merge runs your eval suite against the new agent version. Lantern compares the score to the branch's baseline — the last run you pinned as green. Below baseline, the API returns 422 and your pipeline fails.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[#cbd5e1]">
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" /> Baselines pinned per branch (main, staging, feature/*)</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" /> Pluggable assertions (contains, regex, JSON-path, LLM-judge)</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-indigo-400 mt-0.5 shrink-0" /> A/B experiments auto-promote the winning variant on &gt;2% lift</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── VPC / data plane ──────────────────────────────────────────────────────
function VPCDemo() {
  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-400/20 bg-orange-400/5 text-xs text-orange-300 mb-4">
            <Lock className="w-3 h-3" /> VPC data plane
          </div>
          <h3 className="text-3xl md:text-4xl font-bold tracking-tight">
            Your data plane. Your cloud. Your call.
          </h3>
          <p className="mt-4 text-[#9898a8] leading-relaxed">
            The control plane is the brains — state, orchestration, routing decisions. The data plane is the hands — running user code, calling LLMs, touching customer data. Put the hands inside your VPC. The tunnel is outbound-only and metadata-only.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[#cbd5e1]">
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Deploys to EKS, GKE, AKS, or bare Kubernetes</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Firecracker / Kata microVM per run, untrusted code never touches a shared pod</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Managed cloud when you don't want to operate it yourself — same code, one click</li>
          </ul>
        </div>
        <div className="code-window rounded-xl border border-white/5 p-5 font-mono text-[12px] text-[#cbd5e1]">
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-white/5 bg-[#0a0a0f] p-4">
              <div className="text-[#55556a] mb-1">Control plane — Lantern managed</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>• REST/gRPC</span>
                <span>• Postgres · Redis</span>
                <span>• Forecaster · Budgets · Evals</span>
                <span>• Marketplace · MCP · A/B</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-[#55556a] text-[11px]">
              <span>mTLS tunnel</span>
              <div className="flex-1 beam-line" />
              <span>outbound-only · metadata</span>
            </div>
            <div className="rounded-md border border-orange-400/20 bg-orange-400/5 p-4">
              <div className="text-orange-300 mb-1">Data plane — your VPC (EKS / GKE / AKS)</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>• Workflow engine</span>
                <span>• Runtime manager</span>
                <span>• Firecracker microVM</span>
                <span>• Your provider keys</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── Stack feature list ────────────────────────────────────────────────────
function Stack() {
  const rows = [
    { icon: Zap, t: "Multi-LLM routing", d: "Bring your own keys. Capability-addressed models (auto, reasoning-large, code-large). Swap providers without code changes." },
    { icon: Server, t: "Managed sessions", d: "Interactive, multi-turn, durable. SSE streaming. Survives control-plane restarts." },
    { icon: Terminal, t: "Real connector APIs", d: "Gmail, GCal, Drive, Slack, GitHub, Linear, Jira, Stripe, and 9 more — OAuth and API-key, actually calling live APIs." },
    { icon: BookOpen, t: "A2A + agent cards", d: "Publish a standard Agent Card at /.well-known/agent.json. Other platforms discover and compose with your agent." },
    { icon: Sparkles, t: "Forkable marketplace", d: "Publish agents for your team or the world. Star, fork, customize — tenant-isolated." },
    { icon: Lock, t: "Guardrails", d: "PII blocking, content filtering, topic blocking. Policy-as-code budgets per tool, per day." },
  ];
  return (
    <section id="stack" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-12 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Full stack</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Everything you need. Nothing you won't.</h2>
        </header>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((r) => (
            <div key={r.t} className="card-glow rounded-xl p-6">
              <r.icon className="w-5 h-5 text-teal-300 mb-4" />
              <h3 className="text-base font-semibold mb-1.5">{r.t}</h3>
              <p className="text-sm text-[#9898a8] leading-relaxed">{r.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Comparison ────────────────────────────────────────────────────────────
function Compare() {
  const rows = [
    ["Pre-run cost forecast", true, false, false, false],
    ["Policy-as-code per-tool budgets", true, false, false, false],
    ["Eval-in-CI with branch baselines", true, false, false, false],
    ["A/B + auto-promotion", true, false, false, false],
    ["Deploy in your VPC", true, false, false, true],
    ["Provider-agnostic by default", true, true, false, true],
    ["Forkable marketplace", true, false, false, false],
    ["Apache 2.0 core (no feature gate)", true, true, true, true],
  ];
  const cols = ["Lantern", "LangGraph", "Mastra", "Inngest"];
  return (
    <section id="compare" className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-5xl mx-auto">
        <header className="mb-10 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">vs alternatives</p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Where Lantern is actually different.</h2>
        </header>
        <div className="rounded-xl border border-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0d0d12]">
              <tr>
                <th className="text-left font-medium text-[#9898a8] py-3 px-4">Capability</th>
                {cols.map((c, i) => (
                  <th key={c} className={`text-center font-medium py-3 px-4 ${i === 0 ? "text-teal-300" : "text-[#9898a8]"}`}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-white/5">
                  <td className="py-3 px-4 text-[#e8e8f0]">{r[0] as string}</td>
                  {(r.slice(1) as boolean[]).map((v, j) => (
                    <td key={j} className="py-3 px-4 text-center">
                      {v ? (
                        <Check className="w-4 h-4 text-teal-400 inline" />
                      ) : (
                        <span className="text-[#55556a]">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 text-xs text-[#55556a]">As of v0.4. Feature matrices change; we'll keep this honest.</p>
      </div>
    </section>
  );
}

// ─── OSS ───────────────────────────────────────────────────────────────────
function OSS() {
  return (
    <section className="py-20 px-6">
      <div className="max-w-4xl mx-auto text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-white/10 text-xs text-[#cbd5e1] mb-4">
          <Github className="w-3 h-3" /> Fully open source
        </div>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">
          Apache 2.0. No feature gates. Your choice of provider.
        </h2>
        <p className="mt-4 text-[#9898a8] leading-relaxed">
          The forecaster, the budgets, the evals, the marketplace, the VPC data plane — all in the main repo. The managed cloud sells convenience (one-click deploy, billing, autoscaling), not unlocked features. Pick your LLMs, pick your smart gateway, pick your cloud.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href="https://github.com/dshakes/lantern" className="px-5 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
            <Github className="w-4 h-4" /> Star on GitHub
          </a>
          <a href="https://docs.lantern.dev" className="px-5 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
            <BookOpen className="w-4 h-4" /> Read the docs
          </a>
        </div>
      </div>
    </section>
  );
}

// ─── CTA ───────────────────────────────────────────────────────────────────
function CTA() {
  return (
    <section className="py-28 px-6 relative overflow-hidden border-t border-white/5">
      <div className="aurora-wave absolute inset-0 pointer-events-none" />
      <div className="max-w-3xl mx-auto text-center relative z-10">
        <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
          Ship agents you can actually bill customers for.
        </h2>
        <p className="mt-4 text-[#9898a8] text-lg">Free tier on managed cloud. Self-host the whole thing. No credit card, no seat minimums.</p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <a href="https://app.lantern.run/signup" className="btn-primary px-6 py-3 rounded-lg font-semibold text-white inline-flex items-center gap-2">
            Start free <ArrowRight className="w-4 h-4" />
          </a>
          <a href="https://github.com/dshakes/lantern" className="px-6 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
            <Github className="w-4 h-4" /> github.com/dshakes/lantern
          </a>
        </div>
      </div>
    </section>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────
function Footer() {
  return (
    <footer className="py-10 px-6 border-t border-white/5 bg-[#060609]">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row gap-4 md:items-center md:justify-between text-xs text-[#55556a]">
        <div className="flex items-center gap-2">
          <span className="text-glow text-base">◆</span>
          <span>Lantern · Apache 2.0 · made with care</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <a href="https://github.com/dshakes/lantern" className="hover:text-white">GitHub</a>
          <a href="https://docs.lantern.dev" className="hover:text-white">Docs</a>
          <a href="https://discord.gg/lantern" className="hover:text-white">Discord</a>
          <a href="mailto:hi@lantern.run" className="hover:text-white">hi@lantern.run</a>
        </div>
      </div>
    </footer>
  );
}

// ─── minimal syntax highlighter ─────────────────────────────────────────────
function syntax(s: string) {
  return s
    .replace(/(\/\/[^\n]*)/g, '<span style="color:#55556a">$1</span>')
    .replace(/(["'`])((?:\\.|(?!\1).)*)\1/g, '<span style="color:#a5e8d8">$1$2$1</span>')
    .replace(/\b(import|from|const|let|await|async|if|throw|new|return)\b/g, '<span style="color:#c4b5fd">$1</span>')
    .replace(/\b(true|false|null|undefined)\b/g, '<span style="color:#fb923c">$1</span>')
    .replace(/\b(LanternClient|process)\b/g, '<span style="color:#38bdf8">$1</span>');
}
