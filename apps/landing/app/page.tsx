"use client";

import { motion, type Variants } from "framer-motion";
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
  MessageCircle,
  Phone,
  Globe,
  Activity,
  ScrollText,
  RefreshCw,
} from "lucide-react";
import Link from "next/link";

// -----------------------------------------------------------------------------
// Landing page — the GA front door. Visual-first: every load-bearing concept
// gets a hand-authored inline SVG in the design palette. Tight copy, motion on
// scroll, generous whitespace. Every claim is true to README + shipped code.
// -----------------------------------------------------------------------------

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-[#060609] text-[#f0f0f5] grain">
      <Nav />
      <Hero />
      <TrustRow />
      <Channels />
      <Pillars />
      <VPCDemo />
      <CodeStory />
      <CostForecastDemo />
      <EvalCIDemo />
      <Observability />
      <Governed />
      <Stack />
      <Compare />
      <OSS />
      <CTA />
      <Footer />
    </div>
  );
}

// ─── Scroll-reveal helpers ──────────────────────────────────────────────────
const REVEAL: Variants = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] } },
};

function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      variants={REVEAL}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      transition={{ delay }}
      className={className}
    >
      {children}
    </motion.div>
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
          <a href="#channels" className="nav-pill px-3 py-1.5 rounded-md">Channels</a>
          <a href="#vpc" className="nav-pill px-3 py-1.5 rounded-md">Your VPC</a>
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
          <Sparkles className="w-3 h-3" /> Apache 2.0 · GA · agents on real channels, in your cloud
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
          Pair WhatsApp, embed a webchat widget, plug in a voice number — your agent talks on the
          surfaces your users already use. Runs execute in <span className="text-[#e8e8f0]">your VPC</span>,
          cost-forecasted, eval-gated, and signed. One command to boot.
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
        <span>iMessage</span>
        <span>·</span>
        <span>Slack</span>
        <span>·</span>
        <span>Telegram</span>
        <span>·</span>
        <span>Voice</span>
        <span>·</span>
        <span>Webchat</span>
        <span>·</span>
        <span>Apache 2.0</span>
        <span>·</span>
        <span>Your VPC, your data</span>
      </div>
    </section>
  );
}

// ─── Channels (inline SVG: agent hub → channels) ───────────────────────────
const CHANNELS = [
  { icon: MessageCircle, t: "WhatsApp + iMessage", d: "Pair by scanning a QR. The bridge paces replies and splits long answers into burst messages — it doesn't read like a bot." },
  { icon: Globe, t: "Webchat widget", d: "One <script> tag drops a chat widget on any site. Same /v1/sessions API the dashboard uses — no parallel surface to maintain." },
  { icon: Phone, t: "Voice number", d: "Buy or BYO a number over Twilio or LiveKit. Inbound calls route to an agent; voice spend counts against the same budgets as runs." },
  { icon: Terminal, t: "Slack · Telegram · Email", d: "Signature-verified webhooks, naturally paced replies. The agent meets people where they already are." },
];

function Channels() {
  return (
    <section id="channels" className="py-24 px-6">
      <div className="max-w-6xl mx-auto">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <Reveal>
              <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Reach</p>
              <h2 className="text-4xl md:text-5xl font-bold tracking-tight">One agent. Every channel.</h2>
              <p className="mt-4 text-[#9898a8] text-lg leading-relaxed">
                Most frameworks trap your agent inside their own dashboard. Lantern wires it to the
                surfaces people actually use — and the same agent answers on all of them.
              </p>
            </Reveal>
            <div className="mt-8 grid sm:grid-cols-2 gap-4">
              {CHANNELS.map((c, i) => (
                <Reveal key={c.t} delay={i * 0.05}>
                  <div className="card-glow rounded-xl p-5 h-full">
                    <c.icon className="w-5 h-5 text-teal-300 mb-3" />
                    <h3 className="text-base font-semibold mb-1.5">{c.t}</h3>
                    <p className="text-sm text-[#9898a8] leading-relaxed">{c.d}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
          <Reveal delay={0.1}>
            <ChannelsSVG />
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function ChannelsSVG() {
  // Agent core in the center; channels orbit and connect with animated beams.
  const spokes = [
    { label: "WhatsApp", x: 60, y: 50, c: "#34d399" },
    { label: "Voice", x: 60, y: 130, c: "#f59e0b" },
    { label: "Webchat", x: 60, y: 210, c: "#38bdf8" },
    { label: "Slack", x: 60, y: 290, c: "#8b5cf6" },
  ];
  return (
    <svg viewBox="0 0 520 340" className="w-full h-auto" role="img" aria-label="One agent connected to WhatsApp, voice, webchat, and Slack channels">
      <defs>
        <linearGradient id="ch-core" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.5" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
        <radialGradient id="ch-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.35" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="400" cy="170" r="120" fill="url(#ch-glow)" />
      {/* connector beams */}
      {spokes.map((s, i) => (
        <g key={s.label}>
          <path
            d={`M150 ${s.y + 20} C 260 ${s.y + 20}, 300 170, 392 170`}
            fill="none"
            stroke={s.c}
            strokeOpacity="0.45"
            strokeWidth="1.5"
          />
          <circle r="3" fill={s.c}>
            <animateMotion
              dur={`${2.6 + i * 0.4}s`}
              repeatCount="indefinite"
              path={`M150 ${s.y + 20} C 260 ${s.y + 20}, 300 170, 392 170`}
            />
          </circle>
        </g>
      ))}
      {/* channel pills */}
      {spokes.map((s) => (
        <g key={`pill-${s.label}`}>
          <rect x="20" y={s.y} width="130" height="40" rx="10" fill="#0d0d12" stroke={s.c} strokeOpacity="0.4" />
          <circle cx="40" cy={s.y + 20} r="5" fill={s.c} />
          <text x="56" y={s.y + 25} fill="#cbd5e1" fontSize="13" fontFamily="Inter, sans-serif">{s.label}</text>
        </g>
      ))}
      {/* agent core */}
      <circle cx="400" cy="170" r="58" fill="#0d0d12" stroke="url(#ch-core)" strokeWidth="2" />
      <text x="400" y="160" textAnchor="middle" fill="#f0f0f5" fontSize="22" fontWeight="700">◆</text>
      <text x="400" y="184" textAnchor="middle" fill="#9898a8" fontSize="12" fontFamily="Inter, sans-serif">agent</text>
      <text x="400" y="200" textAnchor="middle" fill="#55556a" fontSize="10" fontFamily="JetBrains Mono, monospace">/v1/sessions</text>
    </svg>
  );
}

// ─── Four pillars ──────────────────────────────────────────────────────────
const PILLARS = [
  {
    icon: Gauge,
    tag: "Cost",
    title: "Forecast before you dispatch.",
    body: "Other frameworks tell you what a run cost afterwards. Lantern tells you before. One POST returns estimated tokens, dollars, and confidence — grounded in your own 30-day history. Hard-fail the run if it would blow your budget.",
    ringFrom: "#2dd4bf",
    ringTo: "#38bdf8",
  },
  {
    icon: GitBranch,
    tag: "Quality",
    title: "Eval-in-CI + replay failures.",
    body: "Define eval suites declaratively, pin a baseline per branch, run them in CI. If the score drops, the build fails (HTTP 422). Rehearsals replay the exact production failures that broke the last version against the candidate.",
    ringFrom: "#818cf8",
    ringTo: "#ec4899",
  },
  {
    icon: RefreshCw,
    tag: "Durable",
    title: "Survives a crash mid-run.",
    body: "Every step is journaled before it commits. Kill the executor and a watchdog re-leases the run on a healthy worker — it resumes from the last completed step, exactly-once, never re-spending tokens on work already done.",
    ringFrom: "#2dd4bf",
    ringTo: "#34d399",
  },
  {
    icon: Shield,
    tag: "Trust",
    title: "Signed receipts. Your VPC.",
    body: "Every run issues an Ed25519-signed receipt over the journal-event hash — any third party verifies it at /proof. Prompts and customer data stay in your EKS/GKE/AKS. Tamper with the run, break the signature.",
    ringFrom: "#fb923c",
    ringTo: "#f472b6",
  },
];

function Pillars() {
  return (
    <section id="pillars" className="py-24 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-14 max-w-2xl">
            <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Why Lantern</p>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Four things other frameworks hand-wave.</h2>
          </header>
        </Reveal>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          {PILLARS.map((p, i) => (
            <Reveal key={p.tag} delay={i * 0.06}>
              <div className="card-glow rounded-2xl p-7 group h-full">
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
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─── VPC / data plane — flagship section with inline SVG flow ──────────────
function VPCDemo() {
  return (
    <section id="vpc" className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-12 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-orange-400/20 bg-orange-400/5 text-xs text-orange-300 mb-4">
              <Lock className="w-3 h-3" /> The flagship differentiator
            </div>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Runs execute in your VPC.</h2>
            <p className="mt-4 text-[#9898a8] text-lg leading-relaxed">
              The control plane is the brains — state, routing, budgets. The data plane is the hands —
              running code, calling LLMs, touching customer data. Put the hands inside your cloud. The
              tunnel is <span className="text-[#e8e8f0]">outbound-only</span> — no inbound ports open in
              your VPC.
            </p>
          </header>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="card-glow rounded-2xl p-6 md:p-10">
            <VPCSVG />
          </div>
        </Reveal>
        <div className="mt-8 grid md:grid-cols-3 gap-4">
          {[
            { t: "Dials out, never in", d: "The data-plane agent dials the control plane at :50051 and holds a persistent gRPC RunStream. No inbound ports in your VPC." },
            { t: "Falls back to managed", d: "No data plane connected? Runs execute inline in the managed control plane — same code, zero config. Connect a VPC later." },
            { t: "Traces flow back", d: "OTel spans (tenant · run · step · trace_id) propagate back up the tunnel — full observability without exporting your data." },
          ].map((c, i) => (
            <Reveal key={c.t} delay={i * 0.05}>
              <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-5 h-full">
                <Check className="w-4 h-4 text-orange-400 mb-2" />
                <h3 className="text-base font-semibold mb-1.5">{c.t}</h3>
                <p className="text-sm text-[#9898a8] leading-relaxed">{c.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function VPCSVG() {
  return (
    <svg viewBox="0 0 960 300" className="w-full h-auto" role="img" aria-label="Control plane dials over an outbound-only mTLS tunnel into your VPC runtime; OTel traces flow back">
      <defs>
        <linearGradient id="vpc-cp" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id="vpc-dp" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f59e0b" />
          <stop offset="1" stopColor="#f472b6" />
        </linearGradient>
        <linearGradient id="vpc-beam" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0" />
          <stop offset="0.5" stopColor="#38bdf8" stopOpacity="0.9" />
          <stop offset="1" stopColor="#38bdf8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="vpc-beam-back" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#34d399" stopOpacity="0" />
          <stop offset="0.5" stopColor="#34d399" stopOpacity="0.9" />
          <stop offset="1" stopColor="#34d399" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Control plane panel */}
      <g>
        <rect x="20" y="50" width="300" height="200" rx="16" fill="#0d0d12" stroke="url(#vpc-cp)" strokeWidth="1.5" strokeOpacity="0.7" />
        <text x="40" y="82" fill="#2dd4bf" fontSize="12" letterSpacing="2" fontFamily="JetBrains Mono, monospace">CONTROL PLANE · MANAGED</text>
        {[
          ["Auth · RBAC · budgets", 112],
          ["Model router · forecaster", 140],
          ["Scheduler · run assignment", 168],
          ["Receipt signer · Ed25519", 196],
        ].map(([label, y]) => (
          <g key={label as string}>
            <circle cx="48" cy={(y as number) - 4} r="3" fill="#38bdf8" />
            <text x="62" y={y as number} fill="#cbd5e1" fontSize="13" fontFamily="Inter, sans-serif">{label}</text>
          </g>
        ))}
        <rect x="40" y="216" width="260" height="22" rx="6" fill="#11182a" />
        <text x="50" y="231" fill="#55556a" fontSize="11" fontFamily="JetBrains Mono, monospace">postgres · redis · s3</text>
      </g>

      {/* Tunnel */}
      <g>
        {/* outbound (down): data plane dials the control plane */}
        <line x1="320" y1="125" x2="640" y2="125" stroke="#1c2533" strokeWidth="14" strokeLinecap="round" />
        <rect x="320" y="118" width="320" height="14" rx="7" fill="url(#vpc-beam)">
          <animate attributeName="x" values="540;320" dur="2.4s" repeatCount="indefinite" />
        </rect>
        <text x="480" y="110" textAnchor="middle" fill="#38bdf8" fontSize="12" fontFamily="JetBrains Mono, monospace">outbound mTLS · :50051</text>
        <polygon points="332,118 320,125 332,132" fill="#38bdf8" />

        {/* return (up): OTel traces back */}
        <line x1="320" y1="175" x2="640" y2="175" stroke="#1c2533" strokeWidth="14" strokeLinecap="round" />
        <rect x="320" y="168" width="320" height="14" rx="7" fill="url(#vpc-beam-back)">
          <animate attributeName="x" values="320;540" dur="2.8s" repeatCount="indefinite" />
        </rect>
        <text x="480" y="200" textAnchor="middle" fill="#34d399" fontSize="12" fontFamily="JetBrains Mono, monospace">OTel traces · run status</text>
        <polygon points="628,168 640,175 628,182" fill="#34d399" />
      </g>

      {/* VPC panel */}
      <g>
        <rect x="640" y="50" width="300" height="200" rx="16" fill="#11100c" stroke="url(#vpc-dp)" strokeWidth="1.5" strokeOpacity="0.7" />
        <text x="660" y="82" fill="#f59e0b" fontSize="12" letterSpacing="2" fontFamily="JetBrains Mono, monospace">YOUR VPC · EKS / GKE / AKS</text>
        {[
          ["Data-plane agent (dials out)", 112],
          ["Workflow engine · durable", 140],
          ["Runtime manager · microVM", 168],
          ["Your provider keys · your data", 196],
        ].map(([label, y]) => (
          <g key={label as string}>
            <circle cx="668" cy={(y as number) - 4} r="3" fill="#f59e0b" />
            <text x="682" y={y as number} fill="#e7c98b" fontSize="13" fontFamily="Inter, sans-serif">{label}</text>
          </g>
        ))}
        <rect x="660" y="216" width="260" height="22" rx="6" fill="#1c160a" />
        <text x="670" y="231" fill="#8a7a52" fontSize="11" fontFamily="JetBrains Mono, monospace">no inbound ports · data never leaves</text>
      </g>
    </svg>
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
    <section className="py-24 px-6 relative border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-10 max-w-2xl">
            <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">End-to-end</p>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">30 lines. Production agent.</h2>
            <p className="mt-4 text-[#9898a8] text-lg">
              Budget, forecast, run, and regression-guard — in one file. No vendor-specific SDKs, no hand-rolled retry loops, no silent cost spirals.
            </p>
          </header>
        </Reveal>
        <Reveal delay={0.1}>
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
        </Reveal>
      </div>
    </section>
  );
}

// ─── Cost forecast interactive ─────────────────────────────────────────────
function CostForecastDemo() {
  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <Reveal>
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
        </Reveal>
        <Reveal delay={0.1}>
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
        </Reveal>
      </div>
    </section>
  );
}

// ─── Eval-in-CI demo ───────────────────────────────────────────────────────
function EvalCIDemo() {
  return (
    <section className="py-20 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
        <Reveal>
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
        </Reveal>
        <Reveal delay={0.1}>
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
        </Reveal>
      </div>
    </section>
  );
}

// ─── Observability — inline SVG trace spine ────────────────────────────────
function Observability() {
  return (
    <section className="py-24 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-12 max-w-2xl">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-sky-400/20 bg-sky-400/5 text-xs text-sky-300 mb-4">
              <Activity className="w-3 h-3" /> Observability
            </div>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">One trace, end to end.</h2>
            <p className="mt-4 text-[#9898a8] text-lg leading-relaxed">
              A single correlation tuple threads every hop — control-plane → gateway → model-router →
              runtime → in-VM harness. GenAI-semconv spans carry reasoning and cache tokens, so FinOps
              and anomaly detection come from the trace stream, not a side channel.
            </p>
          </header>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="card-glow rounded-2xl p-6 md:p-10">
            <TraceSVG />
          </div>
        </Reveal>
        <div className="mt-8 grid md:grid-cols-3 gap-4">
          {[
            { t: "Prometheus alerts", d: "13 production alert rules across 3 groups — token runaway, retry storms, budget breach — ship in infra/monitoring/." },
            { t: "Grafana dashboards", d: "Two pre-built dashboards for run health, cost attribution, and model usage. Live mode reads GET /v1/runtime/metrics." },
            { t: "8 operator runbooks", d: "Control-plane, data-plane, DB, gateway, scheduler, budget, restore — the on-call playbook is in the repo, not your head." },
          ].map((c, i) => (
            <Reveal key={c.t} delay={i * 0.05}>
              <div className="rounded-xl border border-white/5 bg-[#0d0d12] p-5 h-full">
                <Check className="w-4 h-4 text-sky-400 mb-2" />
                <h3 className="text-base font-semibold mb-1.5">{c.t}</h3>
                <p className="text-sm text-[#9898a8] leading-relaxed">{c.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function TraceSVG() {
  const hops = [
    { label: "control-plane", c: "#2dd4bf", x: 20 },
    { label: "gateway", c: "#38bdf8", x: 205 },
    { label: "model-router", c: "#38bdf8", x: 390 },
    { label: "runtime", c: "#8b5cf6", x: 575 },
    { label: "harness", c: "#f59e0b", x: 760 },
  ];
  const W = 175;
  return (
    <svg viewBox="0 0 960 260" className="w-full h-auto" role="img" aria-label="A single trace propagating across control-plane, gateway, model-router, runtime, and harness, with nested GenAI spans">
      <defs>
        <linearGradient id="tr-line" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2dd4bf" />
          <stop offset="0.5" stopColor="#38bdf8" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>

      {/* tuple chip */}
      <rect x="20" y="14" width="540" height="28" rx="8" fill="#0d0d12" stroke="#38bdf8" strokeOpacity="0.3" />
      <text x="34" y="33" fill="#9898a8" fontSize="12" fontFamily="JetBrains Mono, monospace">
        traceparent: tenant_id · run_id · step_id · agent_instance_id · trace_id
      </text>

      {/* spine */}
      <line x1="40" y1="86" x2="900" y2="86" stroke="url(#tr-line)" strokeWidth="2" strokeOpacity="0.5" />
      <circle r="4" fill="#fff">
        <animateMotion dur="3.2s" repeatCount="indefinite" path="M40 86 L900 86" />
      </circle>

      {/* hop nodes */}
      {hops.map((h) => (
        <g key={h.label}>
          <line x1={h.x + W / 2} y1="74" x2={h.x + W / 2} y2="98" stroke={h.c} strokeWidth="2" />
          <rect x={h.x} y="62" width={W} height="48" rx="10" fill="#11182a" stroke={h.c} strokeOpacity="0.5" />
          <circle cx={h.x + 18} cy="86" r="4" fill={h.c} />
          <text x={h.x + 32} y="91" fill="#cbd5e1" fontSize="13" fontFamily="JetBrains Mono, monospace">{h.label}</text>
        </g>
      ))}

      {/* nested span waterfall under runtime/router */}
      <g>
        <rect x="390" y="140" width="510" height="20" rx="5" fill="#38bdf8" fillOpacity="0.18" />
        <text x="400" y="154" fill="#9898a8" fontSize="11" fontFamily="JetBrains Mono, monospace">gen_ai.chat.completion</text>

        <rect x="430" y="168" width="320" height="18" rx="5" fill="#8b5cf6" fillOpacity="0.22" />
        <text x="440" y="181" fill="#9898a8" fontSize="11" fontFamily="JetBrains Mono, monospace">input 1428 · output 612 · reasoning 240</text>

        <rect x="470" y="194" width="220" height="18" rx="5" fill="#34d399" fillOpacity="0.2" />
        <text x="480" y="207" fill="#9898a8" fontSize="11" fontFamily="JetBrains Mono, monospace">cache_read 980 · $0.0193</text>
      </g>

      {/* anomaly tags */}
      <g>
        <rect x="20" y="170" width="320" height="42" rx="10" fill="#0d0d12" stroke="#f472b6" strokeOpacity="0.3" />
        <text x="36" y="188" fill="#f472b6" fontSize="11" letterSpacing="1.5" fontFamily="JetBrains Mono, monospace">LIVE ANOMALY DETECTION</text>
        <text x="36" y="204" fill="#9898a8" fontSize="11" fontFamily="JetBrains Mono, monospace">loop_detected · retry_storm · token_runaway</text>
      </g>
    </svg>
  );
}

// ─── Durable + governed band ───────────────────────────────────────────────
const GOVERNED = [
  { code: "402", icon: Gauge, t: "Hard-fail budgets", d: "A run that would exceed a per-day, per-run, or per-tool budget is blocked at dispatch with HTTP 402. No surprise invoices.", c: "#f59e0b" },
  { code: "422", icon: GitBranch, t: "Eval-gate on regression", d: "A version that scores below its branch baseline returns HTTP 422 in CI. The build fails before the regression ships.", c: "#8b5cf6" },
  { code: "Ed25519", icon: ScrollText, t: "Signed receipts", d: "Every completed run issues a receipt signed over the journal-event hash. Verify offline at /proof — tamper-evident by construction.", c: "#34d399" },
];

function Governed() {
  return (
    <section className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-12 max-w-2xl">
            <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Durable &amp; governed</p>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Guardrails are HTTP status codes.</h2>
            <p className="mt-4 text-[#9898a8] text-lg leading-relaxed">
              Governance isn't a dashboard you check after the fact — it's enforced in the request path,
              with status codes your pipeline already understands.
            </p>
          </header>
        </Reveal>
        <div className="grid md:grid-cols-3 gap-5">
          {GOVERNED.map((g, i) => (
            <Reveal key={g.t} delay={i * 0.06}>
              <div className="card-glow rounded-2xl p-7 h-full">
                <div className="flex items-center justify-between mb-5">
                  <g.icon className="w-5 h-5" style={{ color: g.c }} />
                  <span className="font-mono text-lg font-bold" style={{ color: g.c }}>{g.code}</span>
                </div>
                <h3 className="text-xl font-semibold mb-3">{g.t}</h3>
                <p className="text-sm text-[#9898a8] leading-relaxed">{g.d}</p>
              </div>
            </Reveal>
          ))}
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
    <section id="stack" className="py-24 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-6xl mx-auto">
        <Reveal>
          <header className="mb-12 max-w-2xl">
            <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">Full stack</p>
            <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Everything you need. Nothing you won't.</h2>
          </header>
        </Reveal>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rows.map((r, i) => (
            <Reveal key={r.t} delay={(i % 3) * 0.05}>
              <div className="card-glow rounded-xl p-6 h-full">
                <r.icon className="w-5 h-5 text-teal-300 mb-4" />
                <h3 className="text-base font-semibold mb-1.5">{r.t}</h3>
                <p className="text-sm text-[#9898a8] leading-relaxed">{r.d}</p>
              </div>
            </Reveal>
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
    <section id="compare" className="py-20 px-6 border-t border-white/5">
      <div className="max-w-5xl mx-auto">
        <Reveal>
          <header className="mb-10 max-w-2xl">
            <p className="text-sm text-teal-300 uppercase tracking-[0.2em] mb-3">vs alternatives</p>
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Where Lantern is actually different.</h2>
          </header>
        </Reveal>
        <Reveal delay={0.1}>
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
        </Reveal>
        <p className="mt-4 text-xs text-[#55556a]">As of GA. Feature matrices change; we'll keep this honest.</p>
      </div>
    </section>
  );
}

// ─── OSS ───────────────────────────────────────────────────────────────────
function OSS() {
  return (
    <section className="py-20 px-6 border-t border-white/5 bg-[#08080d]">
      <div className="max-w-4xl mx-auto text-center">
        <Reveal>
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
        </Reveal>
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
        <Reveal>
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
        </Reveal>
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
