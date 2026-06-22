"use client";

import { motion } from "framer-motion";
import {
  Shield,
  ShieldCheck,
  Layers,
  Boxes,
  GitBranch,
  Github,
  ArrowRight,
  Sparkles,
  Server,
  Lock,
  Zap,
  Check,
  BookOpen,
  Activity,
  KeyRound,
  RefreshCw,
  Fingerprint,
  Network,
  Cpu,
  ScrollText,
} from "lucide-react";
import Link from "next/link";

// -----------------------------------------------------------------------------
// Runtime landing — the agent execution kernel. Durable, isolated, verifiable.
// Mirrors the visual language of app/page.tsx exactly (card-glow, code-window,
// icon-ring, text-glow, nav-pill). No marketing fluff; every claim is shipped.
// -----------------------------------------------------------------------------

const DOCS_URL = "https://github.com/dshakes/lantern#agent-runtime";
const GH_URL = "https://github.com/dshakes/lantern";

export default function RuntimePage() {
  return (
    <div className="relative min-h-screen bg-[#060609] text-[#f0f0f5] grain">
      <Nav />
      <Hero />
      <SubstrateRow />
      <IsolationTiers />
      <IsolationMatrix />
      <DurableExecution />
      <Tracing />
      <Governance />
      <RuntimeCodeStory />
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
          <a href="#tiers" className="nav-pill px-3 py-1.5 rounded-md">Isolation</a>
          <a href="#durable" className="nav-pill px-3 py-1.5 rounded-md">Durability</a>
          <a href="#governance" className="nav-pill px-3 py-1.5 rounded-md">Governance</a>
          <a href={GH_URL} className="nav-pill px-3 py-1.5 rounded-md">GitHub</a>
          <a href={DOCS_URL} className="nav-pill px-3 py-1.5 rounded-md">Docs</a>
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/" className="hidden md:inline-flex text-sm text-[#9898a8] hover:text-white nav-pill px-3 py-1.5 rounded-md">Overview</Link>
          <a href={DOCS_URL} className="btn-primary text-sm font-medium px-3.5 py-1.5 rounded-md text-white inline-flex items-center gap-1.5">
            Get started <ArrowRight className="w-3.5 h-3.5" />
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
          <Sparkles className="w-3 h-3" /> Kubernetes-native · RuntimeClass-tiered isolation · fail-closed by design
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight leading-[1.05]"
        >
          The agent
          <br />
          <span className="text-glow">execution kernel.</span>
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-6 text-lg md:text-xl text-[#9898a8] max-w-2xl mx-auto leading-relaxed"
        >
          A durable, isolated, verifiable runtime for autonomous agents — running inside your VPC. Exactly-once execution under crash, hardware-grade isolation per workload, and a signed identity for every instance you can verify from the outside.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-9 flex flex-col sm:flex-row items-center justify-center gap-3"
        >
          <a href={DOCS_URL} className="btn-primary px-5 py-3 rounded-lg font-semibold text-white inline-flex items-center gap-2">
            Get started <ArrowRight className="w-4 h-4" />
          </a>
          <a href={GH_URL} className="px-5 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
            <Github className="w-4 h-4" /> View source
          </a>
        </motion.div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="mt-10 inline-flex items-center gap-3 px-4 py-2 rounded-full border border-white/5 bg-[#0d0d12] text-xs text-[#55556a] font-mono"
        >
          <span className="text-emerald-400">$</span> lantern run agent.yaml <span className="text-[#3a3a47]"># boots into an isolated microVM</span>
        </motion.div>
      </div>
    </section>
  );
}

function SubstrateRow() {
  return (
    <section className="py-10 border-y border-white/5 bg-[#08080d]/60">
      <div className="max-w-6xl mx-auto px-6 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs uppercase tracking-[0.2em] text-[#55556a]">
        <span>runc</span>
        <span>·</span>
        <span>gVisor</span>
        <span>·</span>
        <span>Kata microVM</span>
        <span>·</span>
        <span>Wasmtime</span>
        <span>·</span>
        <span>Event-sourced journal</span>
        <span>·</span>
        <span>Ed25519 receipts</span>
        <span>·</span>
        <span>Your VPC</span>
      </div>
    </section>
  );
}

// ─── Isolation tiers (feature-card grid) ───────────────────────────────────
const TIERS = [
  {
    icon: ShieldCheck,
    tag: "TRUSTED",
    rclass: "runtimeClassName: runc",
    title: "Signed first-party code.",
    body: "Cosign-verified, first-party agents only. Runs as a standard pod on shared nodes — the fast path, reserved for code you sign and trust.",
    ringFrom: "#2dd4bf",
    ringTo: "#38bdf8",
  },
  {
    icon: Shield,
    tag: "STANDARD",
    rclass: "runtimeClassName: gvisor",
    title: "gVisor-isolated. Default.",
    body: "The default for every agent. A gVisor user-space kernel intercepts syscalls, so a shared node never exposes the host kernel to agent code.",
    ringFrom: "#2dd4bf",
    ringTo: "#818cf8",
  },
  {
    icon: Network,
    tag: "UNTRUSTED",
    rclass: "gvisor + egress-deny",
    title: "gVisor + deny-default egress.",
    body: "gVisor plus a seccomp deny-default profile and an egress allowlist. Code from the internet runs here — it reaches only the hosts you name, nothing else.",
    ringFrom: "#38bdf8",
    ringTo: "#fb923c",
  },
  {
    icon: Cpu,
    tag: "HOSTILE",
    rclass: "runtimeClassName: kata-qemu",
    title: "Dedicated microVM. No co-tenancy.",
    body: "A Kata microVM with its own kernel on a dedicated node pool — hardware-grade isolation via Kubernetes. Firecracker-backed (kata-fc) where the substrate supports it.",
    ringFrom: "#fb923c",
    ringTo: "#f472b6",
  },
  {
    icon: Boxes,
    tag: "WASM",
    rclass: "crun + wasm",
    title: "Capability-sandboxed Wasm.",
    body: "WebAssembly workloads run with no ambient authority — only the capabilities you grant. crun+wasm on the cluster, or in-process Wasmtime on trusted hosts.",
    ringFrom: "#818cf8",
    ringTo: "#22d3ee",
  },
  {
    icon: Server,
    tag: "DEVCONTAINER",
    rclass: "long-lived pod + PVC",
    title: "Persistent dev environments.",
    body: "A long-lived gVisor-isolated pod with a PVC for stateful, interactive development loops — the same isolation guarantees, kept warm across sessions.",
    ringFrom: "#22d3ee",
    ringTo: "#a78bfa",
  },
];

function IsolationTiers() {
  return (
    <section id="tiers" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <header className="mb-14 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Isolation tiers</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Isolation is a tier, not an afterthought.</h2>
          <p className="mt-4 text-[#9898a8] text-lg">
            The agent author declares an isolation class; the platform maps it to a Kubernetes RuntimeClass. One substrate, six tiers — from a fast shared pod to a dedicated microVM with no co-tenant.
          </p>
        </header>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {TIERS.map((p) => (
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
              <p className="mt-4 text-[12px] font-mono text-teal-300/80">{p.rclass}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── Isolation matrix + fail-closed callout ────────────────────────────────
function IsolationMatrix() {
  const rows: Array<[string, string, string, string]> = [
    ["TRUSTED", "runc", "Shared node, host kernel", "Signed first-party only"],
    ["STANDARD", "gvisor", "Shared node, user-space kernel", "Default for all agents"],
    ["UNTRUSTED", "gvisor + egress-deny", "Shared node, allowlisted egress", "Internet-sourced code"],
    ["HOSTILE", "kata-qemu / kata-fc", "Dedicated pool, own kernel", "Adversarial workloads"],
    ["WASM", "crun + wasm", "Capability sandbox", "No ambient authority"],
    ["DEVCONTAINER", "gvisor + PVC", "Long-lived, stateful", "Interactive dev loops"],
  ];
  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-400/20 bg-orange-400/5 text-xs text-orange-300 mb-4">
            <Lock className="w-3 h-3" /> Fail-closed
          </div>
          <h3 className="text-3xl md:text-4xl font-bold tracking-tight">
            Untrusted code never gets a bare pod.
          </h3>
          <p className="mt-4 text-[#9898a8] leading-relaxed">
            The scheduler refuses to place an <span className="text-[#cbd5e1]">UNTRUSTED</span> or <span className="text-[#cbd5e1]">HOSTILE</span> workload onto anything but its hardened RuntimeClass. If the cluster can't honor the requested isolation, the workload doesn't run — it errors. There is no silent downgrade to a shared-kernel container.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[#cbd5e1]">
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Kubernetes is the default substrate — EKS, GKE, AKS, or bare K8s</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Isolation strength selected by RuntimeClass, not a separate backend</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-orange-400 mt-0.5 shrink-0" /> Hardware-grade isolation available as a tier, never the slow path</li>
          </ul>
        </div>
        <div className="rounded-xl border border-white/5 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#0d0d12]">
              <tr>
                <th className="text-left font-medium text-teal-300 py-3 px-4">Class</th>
                <th className="text-left font-medium text-[#9898a8] py-3 px-4">RuntimeClass</th>
                <th className="text-left font-medium text-[#9898a8] py-3 px-4 hidden sm:table-cell">Substrate</th>
                <th className="text-left font-medium text-[#9898a8] py-3 px-4 hidden md:table-cell">For</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r[0]} className="border-t border-white/5">
                  <td className="py-3 px-4 text-[#e8e8f0] font-medium">{r[0]}</td>
                  <td className="py-3 px-4 font-mono text-[12px] text-teal-300/80">{r[1]}</td>
                  <td className="py-3 px-4 text-[#9898a8] hidden sm:table-cell">{r[2]}</td>
                  <td className="py-3 px-4 text-[#9898a8] hidden md:table-cell">{r[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ─── Durable execution (left-text + right-code) ────────────────────────────
function DurableExecution() {
  return (
    <section id="durable" className="py-20 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-teal-400/20 bg-teal-400/5 text-xs text-teal-300 mb-4">
            <RefreshCw className="w-3 h-3" /> Durable execution
          </div>
          <h3 className="text-3xl md:text-4xl font-bold tracking-tight">
            Exactly-once, even when the machine dies.
          </h3>
          <p className="mt-4 text-[#9898a8] leading-relaxed">
            Every step an agent takes is appended to an event-sourced journal before it commits. Kill the executor mid-run and a recovery watchdog re-leases the run on a healthy worker — it resumes from the last completed step, never re-spending tokens on work already done.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-[#cbd5e1]">
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Event-sourced journal — the workflow engine is the only authority on run state</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Side-effects deduplicated by idempotency keys derived from (run, step, attempt)</li>
            <li className="flex items-start gap-2"><Check className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" /> Recovery watchdog + distributed run locks + HA scheduler</li>
          </ul>
        </div>
        <div className="code-window rounded-xl border border-white/5 p-5 font-mono text-[12px] text-[#cbd5e1]">
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-white/5 bg-[#0a0a0f] p-4">
              <div className="text-[#55556a] mb-2">run-7c2f · journal</div>
              <div className="flex flex-col gap-1">
                <span><span className="text-teal-300/80">seq 0</span> step_started · search-web</span>
                <span><span className="text-teal-300/80">seq 1</span> step_completed · search-web <span className="text-[#55556a]">(idem: 7c2f/s0/a0)</span></span>
                <span><span className="text-teal-300/80">seq 2</span> step_started · draft-reply</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-orange-300/80 text-[11px]">
              <Activity className="w-3.5 h-3.5" />
              <span>executor killed mid-step</span>
              <div className="flex-1 beam-line" />
              <span>watchdog re-leases</span>
            </div>
            <div className="rounded-md border border-teal-400/20 bg-teal-400/5 p-4">
              <div className="text-teal-300 mb-2">resumed on worker-b</div>
              <div className="flex flex-col gap-1">
                <span><span className="text-teal-300/80">seq 2</span> step replayed from journal · no re-spend</span>
                <span><span className="text-teal-300/80">seq 3</span> step_completed · draft-reply</span>
                <span className="text-emerald-400">run completed · exactly-once</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─── One trace per spawn (code-window) ─────────────────────────────────────
function Tracing() {
  const code = `// One correlation tuple, threaded end-to-end:
//   control-plane → scheduler → manager → in-VM harness
trace.context = {
  tenant_id:          "t_8f21",
  run_id:             "run-7c2f",
  step_id:            "draft-reply",
  agent_instance_id:  "ai-0b9d44",
  trace_id:           "9c1e…a7",   // W3C traceparent
};

// GenAI semantic-convention span — reasoning + cache tokens
// surface for FinOps without re-instrumenting your code.
span "gen_ai.chat.completion" {
  gen_ai.request.model        = "auto"
  gen_ai.usage.input_tokens   = 1428
  gen_ai.usage.output_tokens  = 612
  gen_ai.usage.reasoning_tokens = 240
  gen_ai.usage.cache_read_tokens = 980
}

// Real-time anomaly detection on the live span stream:
//   loop_detected  · retry_storm  · token_runaway`;

  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto">
        <header className="mb-10 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Observability</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">One trace per spawn.</h2>
          <p className="mt-4 text-[#9898a8] text-lg">
            Every spawn carries a single correlation tuple from the control plane all the way into the in-VM harness. GenAI-semconv spans carry reasoning and cache-token counts, so FinOps and anomaly detection come from the trace stream — not a side channel.
          </p>
        </header>
        <div className="code-window rounded-xl border border-white/5 overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-[#0a0a0f]">
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-3 text-xs text-[#55556a] font-mono">trace-context.ts</span>
          </div>
          <pre className="px-6 py-5 text-sm font-mono leading-[1.7] overflow-x-auto text-[#cbd5e1]">
            <code dangerouslySetInnerHTML={{ __html: syntax(code) }} />
          </pre>
        </div>
      </div>
    </section>
  );
}

// ─── Governance & identity (feature grid) ──────────────────────────────────
const GOVERNANCE = [
  {
    icon: Fingerprint,
    t: "Per-instance Ed25519 identity",
    d: "Every agent instance gets its own Ed25519 keypair, externally verifiable at /.well-known/lantern-agent-identity. You can prove which instance acted.",
  },
  {
    icon: KeyRound,
    t: "Short-TTL secret vending",
    d: "The harness vends short-lived secrets over mTLS at execution time. Nothing long-lived is baked into an image; nothing sensitive lands in run state.",
  },
  {
    icon: Shield,
    t: "RBAC scopes",
    d: "Each instance acts under a scoped identity — only the tools, connectors, and data its role allows. Least privilege is the default, not a config.",
  },
  {
    icon: ScrollText,
    t: "Ed25519 signed receipts",
    d: "Completed runs issue a signed receipt over the journal-event hash — verifiable offline by any third party. Tamper with the run, break the signature.",
  },
  {
    icon: Layers,
    t: "Tenant-isolated RLS",
    d: "Every row carries a tenant_id and Postgres Row-Level Security enforces it. No cross-tenant joins, ever — isolation holds at the data layer too.",
  },
  {
    icon: Network,
    t: "Deny-default egress",
    d: "Outbound network is denied unless explicitly allowlisted per agent. An agent reaches the hosts you named and nothing more.",
  },
];

function Governance() {
  return (
    <section id="governance" className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <header className="mb-12 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Governance &amp; identity</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Verifiable from the outside in.</h2>
          <p className="mt-4 text-[#9898a8] text-lg">
            Identity, secrets, and proof are first-class. A third party can verify which instance ran, under what scope, and that its output was never tampered with — without trusting you.
          </p>
        </header>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {GOVERNANCE.map((r) => (
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

// ─── Code story (agent.yaml → lantern run) ─────────────────────────────────
function RuntimeCodeStory() {
  const code = `# agent.yaml — declare the contract, the platform enforces it.
name: web-researcher
isolation: UNTRUSTED          # → gVisor + deny-default egress
image: ghcr.io/acme/researcher:1.4.0
entrypoint: ["python", "-m", "researcher"]

resources:
  cpu: "1"
  memory: 1Gi

# Deny-default egress — the agent reaches these hosts, nothing else.
egress:
  allow:
    - api.openai.com
    - duckduckgo.com

secrets:
  - lantern.secret/openai-key   # vended short-TTL over mTLS at runtime

# $ lantern run agent.yaml
#   → scheduled onto a gvisor RuntimeClass node
#   → per-instance Ed25519 identity minted
#   → boots isolated · journal opens · trace context attached`;

  return (
    <section className="py-24 px-6 relative border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto">
        <header className="mb-10 max-w-2xl">
          <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">A code story</p>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Declare it. Run it. It's isolated.</h2>
          <p className="mt-4 text-[#9898a8] text-lg">
            One manifest names the isolation class, the image, the entrypoint, and the egress allowlist. <span className="font-mono text-teal-300/90">lantern run</span> does the rest — placement, identity, journal, and trace context, all wired before the first line of agent code executes.
          </p>
        </header>
        <div className="code-window rounded-xl border border-white/5 overflow-hidden">
          <div className="flex items-center gap-1.5 px-4 py-2.5 border-b border-white/5 bg-[#0a0a0f]">
            <div className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            <span className="ml-3 text-xs text-[#55556a] font-mono">agent.yaml</span>
          </div>
          <pre className="px-6 py-5 text-sm font-mono leading-[1.7] overflow-x-auto text-[#cbd5e1]">
            <code dangerouslySetInnerHTML={{ __html: yamlSyntax(code) }} />
          </pre>
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
          Run agents you can prove ran correctly.
        </h2>
        <p className="mt-4 text-[#9898a8] text-lg">Durable, isolated, verifiable — in your VPC, on Kubernetes you already operate. Apache 2.0, no feature gates.</p>
        <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
          <a href={DOCS_URL} className="btn-primary px-6 py-3 rounded-lg font-semibold text-white inline-flex items-center gap-2">
            Read the runtime docs <ArrowRight className="w-4 h-4" />
          </a>
          <a href={GH_URL} className="px-6 py-3 rounded-lg border border-white/10 hover:bg-white/5 font-medium inline-flex items-center gap-2 text-[#e8e8f0]">
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
          <span>Lantern Runtime · Apache 2.0 · made with care</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/" className="hover:text-white">Overview</Link>
          <a href={GH_URL} className="hover:text-white">GitHub</a>
          <a href={DOCS_URL} className="hover:text-white">Docs</a>
          <a href="mailto:hi@lantern.run" className="hover:text-white">hi@lantern.run</a>
        </div>
      </div>
    </footer>
  );
}

// ─── minimal TS/JS syntax highlighter (shared idiom with page.tsx) ──────────
function syntax(s: string) {
  return s
    .replace(/(\/\/[^\n]*)/g, '<span style="color:#55556a">$1</span>')
    .replace(/(["'`])((?:\\.|(?!\1).)*)\1/g, '<span style="color:#a5e8d8">$1$2$1</span>')
    .replace(/\b(import|from|const|let|await|async|if|throw|new|return|span|trace)\b/g, '<span style="color:#c4b5fd">$1</span>')
    .replace(/\b(true|false|null|undefined)\b/g, '<span style="color:#fb923c">$1</span>')
    .replace(/\b(\d+)\b/g, '<span style="color:#fb923c">$1</span>');
}

// ─── minimal YAML highlighter ───────────────────────────────────────────────
function yamlSyntax(s: string) {
  return s
    .replace(/(#[^\n]*)/g, '<span style="color:#55556a">$1</span>')
    .replace(/^(\s*-?\s*)([A-Za-z0-9_./-]+)(:)/gm, '$1<span style="color:#38bdf8">$2</span>$3')
    .replace(/(["'])((?:\\.|(?!\1).)*)\1/g, '<span style="color:#a5e8d8">$1$2$1</span>');
}
