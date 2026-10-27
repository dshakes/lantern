import { Check, Minus, X } from "lucide-react";
import Link from "next/link";
import { BrokerDemo } from "./_components/BrokerDemo";
import { CopyCommand } from "./_components/CopyCommand";
import { Recording } from "./_components/Recording";
import { LanternMark } from "./_components/Logo";
import { ThemeToggle } from "./_components/ThemeToggle";

// Landing page. Every claim maps to code on master, the README, or a recorded run;
// opt-in features say so where they are claimed.

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const GITHUB = "https://github.com/dshakes/lantern";
const BLOB = `${GITHUB}/blob/master`;
// On Pages the docs are served next to this page, under /docs.
const DOCS = process.env.NEXT_PUBLIC_DOCS_URL ?? `${BASE}/docs/`;
const CLONE = "git clone https://github.com/dshakes/lantern.git && cd lantern && make dev";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="btn btn-primary sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Problem />
        <How />
        <Measured />
        <Features />
        <Compare />
        <Code />
        <OpenSource />
      </main>
      <Footer />
    </div>
  );
}

const wrap = "mx-auto w-full max-w-[1240px] px-4 sm:px-6 lg:px-10";

function Nav() {
  const links = [
    ["#how", "How it works"],
    ["#measured", "Measured"],
    ["#compare", "Compare"],
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/85 backdrop-blur-md">
      <div className={`${wrap} flex h-16 items-center justify-between gap-4`}>
        <a href="#main" className="flex items-center gap-2 font-semibold" aria-label="Lantern, top of page">
          <LanternMark className="h-7 w-7" />
          <span className="text-lg tracking-tight">Lantern</span>
        </a>
        <nav aria-label="Primary" className="hidden items-center gap-1 text-sm text-ink-2 md:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="rounded-md px-3 py-1.5 hover:text-ink">
              {label}
            </a>
          ))}
          <a href={DOCS} className="rounded-md px-3 py-1.5 hover:text-ink">
            Docs
          </a>
        </nav>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <a href={GITHUB} className="btn btn-quiet !px-3 !py-1.5 text-sm">
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-h">
      <div className="hero-bg" aria-hidden="true" />
      <div className="hero-glow" aria-hidden="true" />
      <div className={`${wrap} relative pb-20 pt-14 md:pt-20 lg:pb-28`}>
        <h1 id="hero-h" className="display text-[clamp(2.6rem,5.9vw,5.25rem)]">
          <span className="block">Run your agents in your own&nbsp;cloud.</span>
          <span className="block">The whole runtime, open&nbsp;source.</span>
        </h1>
        <div className="mt-10 grid grid-cols-1 gap-12 lg:mt-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14">
        <div>
          <p className="lede">
            Lantern is an Apache-2.0 agent runtime you deploy in your VPC or on-prem. Agent-written code runs in a
            Firecracker or Kata microVM, and around it you get durable runs, budgets, model routing and signed receipts. In
            broker mode (opt-in, Firecracker) the VM has no network card and the host adds credentials: the replay is a real
            run.
          </p>
          <div className="mt-8 max-w-xl">
            <CopyCommand command={CLONE} label="Clone and start Lantern locally" />
          </div>
          <div className="mt-5 flex flex-wrap gap-3">
            <a href={`${GITHUB}#quickstart`} className="btn btn-primary">
              Read the quickstart
            </a>
            <a href={DOCS} className="btn btn-quiet">
              Browse the docs
            </a>
          </div>
          <p className="mt-6 text-sm text-ink-3">Apache-2.0, self-hosted, no paid tier. Needs Docker.</p>
        </div>
        <BrokerDemo recording={`${BLOB}/docs/media/egress-broker-kvm.gif`} />
        </div>
      </div>
    </section>
  );
}

function Problem() {
  const beats = [
    {
      now: "It runs in someone else's cloud.",
      answer: "Lantern is Apache-2.0 and deploys in your VPC or on-prem. The control plane, the sandboxes and the run data stay in your account.",
    },
    {
      now: "A crash starts it over.",
      answer: "Every step is journaled. After a crash the run is re-driven and the steps that already completed are skipped, not repeated.",
    },
    {
      now: "Nothing stops the spend.",
      answer: "Per-agent and tenant-wide daily caps return HTTP 402 before the model is called. Forecast a run's cost before you send it.",
    },
  ];
  return (
    <section className="section rule" aria-labelledby="problem-h">
      <div className={wrap}>
        <h2 id="problem-h" className="h2 max-w-4xl">
          A sandbox runs the code. Production agents need the rest of the runtime too.
        </h2>
        <dl className="mt-14 md:mt-20">
          {beats.map((b) => (
            <div key={b.now} className="grid grid-cols-1 gap-3 border-t border-line py-8 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:items-baseline md:gap-12 md:py-10">
              <dt className="display text-[clamp(2rem,4.6vw,3.75rem)] text-ink-3">
                <span className="sr-only">Without a runtime, your agent: </span>
                {b.now}
              </dt>
              <dd className="leading-relaxed text-ink-2 md:text-lg">
                <span className="font-semibold text-patina">In Lantern: </span>
                {b.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function How() {
  const steps = [
    {
      where: "Control plane",
      tone: "var(--lx-ink)",
      hop: "ExecTool",
      title: "The agent thinks outside",
      body: "The loop, the prompt and the model keys run on your control plane. When a step needs to run code, the workflow engine sends one tool call, ExecTool, to the runtime-manager.",
    },
    {
      where: "microVM",
      tone: "var(--lx-flame)",
      hop: "vsock",
      title: "The code runs inside",
      body: "A Firecracker or Kata VM whose PID 1 is the Lantern harness. The workload runs as an unprivileged user, with no model keys, no service tokens and LANTERN_* env withheld.",
    },
    {
      where: "Host broker",
      tone: "var(--lx-patina)",
      hop: "",
      title: "The host decides what leaves",
      body: "In broker mode, requests cross vsock to the host. The broker checks the sandbox's allowlist, adds the credential from a lantern.secret ref, and audits refusals. Without it, the allowlist is enforced in the guest.",
    },
  ];
  return (
    <section id="how" className="section rule" aria-labelledby="how-h">
      <div className={wrap}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end">
          <h2 id="how-h" className="h2">
            The VM asks. The host decides.
          </h2>
          <p className="lede lg:justify-self-end">
            Three places, three jobs. The agent loop, the prompts and the model keys never enter the VM; in broker mode,
            neither do tool credentials.
          </p>
        </div>
        <ol className="relative mt-14 grid grid-cols-1 gap-px rounded-[var(--lx-radius-l)] border border-line bg-line md:grid-cols-3">
          {steps.map((s, i) => (
            <li
              key={s.where}
              className={`relative p-6 first:rounded-t-[var(--lx-radius-l)] last:rounded-b-[var(--lx-radius-l)] md:p-8 md:first:rounded-l-[var(--lx-radius-l)] md:first:rounded-tr-none md:last:rounded-r-[var(--lx-radius-l)] md:last:rounded-bl-none ${
                s.where === "microVM" ? "vm-cell" : "bg-surface"
              }`}
            >
              {s.hop && (
                <span className="hop" aria-label={`then over ${s.hop}`}>
                  {s.hop}
                </span>
              )}
              <div className="flex items-center gap-3">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold"
                  style={{ background: `color-mix(in oklab, ${s.tone} 14%, transparent)`, color: s.tone }}
                >
                  {i + 1}
                </span>
                <span className="text-sm font-medium" style={{ color: s.tone }}>
                  {s.where}
                </span>
              </div>
              <h3 className="mt-6 font-display text-2xl font-bold tracking-tight">{s.title}</h3>
              <p className="mt-3 leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-ink-3">
          See every hop, port and credential in the{" "}
          <a className="link" href={`${DOCS}architecture/`}>
            interactive architecture explorer
          </a>
          .
        </p>
      </div>
    </section>
  );
}

// docs/benchmarks/runtime-latency.md, jailed Firecracker on Lima nested KVM.
const TIMINGS: { step: string; ms: number; kind: "snap" | "base" | "fork" }[] = [
  { step: "Snapshot", ms: 634, kind: "snap" },
  { step: "Stop", ms: 207, kind: "base" },
  { step: "Restore", ms: 138, kind: "base" },
  { step: "Fork 1", ms: 131, kind: "fork" },
  { step: "Fork 2", ms: 145, kind: "fork" },
  { step: "Fork 3", ms: 160, kind: "fork" },
];

function Measured() {
  const max = 700;
  return (
    <section id="measured" className="section rule" aria-labelledby="measured-h">
      <span id="lifecycle" aria-hidden="true" />
      <div className={wrap}>
        <h2 id="measured-h" className="h2 max-w-3xl">
          Idle sandboxes give their compute back.
        </h2>
        <p className="lede mt-6">
          Set idleTimeoutSecs and an idle sandbox is snapshotted and stopped, freeing its compute and quota slot. The next
          exec or file request wakes it. Fork one to try several paths at once: the forks share one memory file, copy on
          write.
        </p>
        <div className="mt-14 grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div>
            <figure>
              <figcaption className="text-sm font-medium text-ink">One real Firecracker run, milliseconds (128 MiB VM)</figcaption>
              <table className="mt-6 w-full text-sm">
                <caption className="sr-only">Lifecycle step durations in milliseconds</caption>
                <tbody>
                  {TIMINGS.map((t) => (
                    <tr key={t.step}>
                      <th scope="row" className="w-28 py-2 pr-3 text-left font-normal text-ink-2">
                        {t.step}
                      </th>
                      <td className="py-2">
                        <div className="flex items-center gap-3">
                          <div
                            className={`bar ${t.kind === "fork" ? "bar-fork" : t.kind === "snap" ? "bar-snap" : ""}`}
                            style={{ width: `${(t.ms / max) * 100}%` }}
                            aria-hidden="true"
                          />
                          <span className="font-display text-lg font-bold tabular-nums">{t.ms}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </figure>
            <p className="mt-8 border-l-2 border-patina pl-4 leading-relaxed text-ink-2">
              <span className="font-semibold text-ink">3 forks, 1 memory inode.</span> All three fork memory files were
              hard links to the same snapshot (link count 4), so each fork paid O(1) disk I/O for 128 MiB.
            </p>
            <p className="mt-6 text-sm leading-relaxed text-ink-3">
              Lima nested virtualization on an Apple M4 Max, aarch64, 1 vCPU and 128 MiB per VM. Indicative, not bare
              metal. The first exec after a restore waits about 4 s for the in-guest channel to reconnect.{" "}
              <a className="link" href={`${BLOB}/docs/benchmarks/runtime-latency.md`}>
                Full benchmark
              </a>
            </p>
          </div>
          <figure className="min-w-0">
            <div className="console">
              <div className="console-bar">
                <span>integration-test.sh</span>
                <span>Firecracker 1.15.1 + jailer</span>
              </div>
              <Recording
                gif={`${BASE}/media/lifecycle-kvm.gif`}
                poster={`${BASE}/media/lifecycle-kvm-final.webp`}
                alt="Terminal output on real Firecracker: boot, ExecTool, snapshot, stop, restore with state intact, three forks with copy-on-write isolation sharing one snapshot-memory inode, clean teardown, ALL ASSERTIONS PASSED, and the per-step timing table."
              />
            </div>
            <figcaption className="mt-3 text-sm text-ink-3">
              Another run of the same test, recorded unedited on Lima nested KVM. Its own timing table lands close to the
              benchmark&rsquo;s, which is why both are called indicative.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Features() {
  const items: { title: string; body: string; proof: string }[] = [
    {
      title: "Sandbox runtime",
      body: "Firecracker and Kata microVMs, gVisor and runc tiers, chosen per workload by isolation class. Streaming exec, a file API under /workspace, pause, resume and fork.",
      proof: "Fail-closed: no microVM runtime, no run. Never a bare pod.",
    },
    {
      title: "Durable runs",
      body: "Every step is journaled. After a crash the recovery sweep re-drives the run and skips the steps that already completed.",
      proof: "Idempotency keys from (run_id, step_id, attempt), so a replay does not double-send.",
    },
    {
      title: "Budgets",
      body: "Per-agent caps on cost per day and runs per day, plus a tenant-wide daily cost cap. Forecast a run, and check the per-run cap, before you send it.",
      proof: "Over a hard cap the call returns HTTP 402 before a model is called. Token and per-tool limits are stored, not enforced yet.",
    },
    {
      title: "Signed receipts",
      body: "A completed run's journal is hashed into a receipt: Ed25519 when LANTERN_RECEIPT_ED25519_SEED is set, an HMAC-SHA256 dev fallback otherwise.",
      proof: "Anyone can verify an Ed25519 receipt offline against /.well-known/lantern-receipts.",
    },
    {
      title: "Model routing",
      body: "Agents ask for a capability, like model: \"auto\" or \"reasoning-large\". The router picks a provider and fails over on retryable errors.",
      proof: "No vendor model names in agent code.",
    },
    {
      title: "Evals",
      body: "Eval suites with per-branch baselines. Rehearsals replay past production failures against a candidate version before traffic flips.",
      proof: "A regression against the baseline fails CI with HTTP 422.",
    },
    {
      title: "Onboarding",
      body: "lantern doctor checks health, auth, your LLM provider and a live run. lantern onboard turns a one-line description into a running agent.",
      proof: "TypeScript, Python and Go SDKs, plus the lantern CLI.",
    },
  ];
  return (
    <section className="section rule" aria-labelledby="features-h">
      <div className={wrap}>
        <h2 id="features-h" className="h2 max-w-3xl">
          The rest of production, already in the box.
        </h2>
        <ul className="mt-14 grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-4">
          {items.map((it) => (
            <li key={it.title} className="flex flex-col border-t border-line py-8 [overflow-wrap:anywhere]">
              <h3 className="font-display text-xl font-bold tracking-tight">{it.title}</h3>
              <p className="mt-3 flex-1 leading-relaxed text-ink-2">{it.body}</p>
              <p className="mt-5 flex gap-2.5 text-sm leading-relaxed text-ink">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-patina" aria-hidden="true" />
                {it.proof}
              </p>
            </li>
          ))}
          <li className="flex flex-col justify-end border-t border-line py-8">
            <p className="leading-relaxed text-ink-2">Plus sessions, schedules, 17 connectors, MCP, A2A cards and channel surfaces.</p>
            <a className="link mt-4 font-medium text-ink" href={DOCS}>
              Every capability, in the docs
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}

type Cell = string;
type Row = { row: string; cells: [Cell, Cell, Cell, Cell] };
// Mirrors README "How Lantern compares": ACE leads on the sandbox; the platform half is out of its scope.
const SANDBOX: Row[] = [
  { row: "Hardware-isolated microVM per sandbox", cells: ["yes: Firecracker / Kata", "yes", "yes", "partial: gVisor"] },
  { row: "Agent loop runs outside the sandbox", cells: ["yes", "yes", "partial: you host the loop", "partial: you host the loop"] },
  { row: "Credentials never enter the sandbox", cells: ["partial: broker mode, opt-in", "yes: by default", "no", "no"] },
  { row: "Egress allowlist enforced outside the guest", cells: ["partial: broker mode, opt-in", "yes: by default", "partial", "partial: IP/CIDR"] },
  { row: "Idle auto-suspend, resume on demand", cells: ["yes", "yes", "partial", "partial"] },
  { row: "Snapshot and fork", cells: ["yes: shared-memory fork", "yes", "partial", "partial"] },
  { row: "Hardware root of trust / attestation", cells: ["partial: measurement recorded, not verified", "yes: Titan", "no", "no"] },
  { row: "Proven at scale", cells: ["Lima nested-KVM + CI only", "The infrastructure behind Gemini's agents (per Google)", "Production", "Production"] },
];
const PLATFORM: Row[] = [
  { row: "Durable agent runs with crash-resume", cells: ["yes", "out of scope", "no", "no"] },
  {
    row: "Budgets that return HTTP 402 before the model call",
    cells: ["partial: cost/day, runs/day, tenant daily cost; token and per-tool limits stored, not enforced", "out of scope", "no", "partial"],
  },
  { row: "Multi-provider model routing with failover", cells: ["yes", "out of scope", "no", "no"] },
  { row: "Signed, offline-verifiable run receipts", cells: ["partial: Ed25519 with a configured seed", "out of scope", "no", "no"] },
  { row: "Self-host in your VPC or on-prem", cells: ["yes: Apache-2.0", "no: Google Cloud only", "partial", "no"] },
  { row: "Availability", cells: ["Open source today", "Preview \u201cin the coming months\u201d", "Generally available", "Generally available"] },
];

function Mark({ c }: { c: Cell }) {
  if (c === "yes" || c.startsWith("yes: "))
    return (
      <span className="inline-flex items-start gap-1.5 text-patina">
        <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={c === "yes" ? "sr-only" : "text-xs text-ink-2"}>{c === "yes" ? "Yes" : c.slice(5)}</span>
      </span>
    );
  if (c === "no" || c.startsWith("no: "))
    return (
      <span className="inline-flex items-start gap-1.5 text-ink-3">
        <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span className={c === "no" ? "sr-only" : "text-xs text-ink-2"}>{c === "no" ? "No" : c.slice(4)}</span>
      </span>
    );
  if (!c.startsWith("partial")) return <span className="text-xs text-ink-2">{c}</span>;
  const note = c.startsWith("partial: ") ? c.slice(9) : "Partial";
  return (
    <span className="inline-flex items-start gap-1.5 text-flame">
      <Minus className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="text-xs text-ink-2">
        <span className="sr-only">Partial: </span>
        {note}
      </span>
    </span>
  );
}

const COLS = ["Lantern", "Google Agent Compute Engine", "E2B", "Modal"];

function CompareTable({ id, title, intro, rows }: { id: string; title: string; intro: string; rows: Row[] }) {
  return (
    <div className="mt-14">
      <h3 id={id} className="font-display text-xl font-semibold text-ink">
        {title}
      </h3>
      <p className="mt-2 max-w-3xl leading-relaxed text-ink-2">{intro}</p>
      <div className="mt-6 overflow-x-auto rounded-[var(--lx-radius-l)] border border-line bg-surface" tabIndex={0} role="region" aria-labelledby={id}>
        <table className="w-full min-w-[760px] text-left text-sm">
          <caption className="sr-only">{title}: Lantern, Google Agent Compute Engine, E2B and Modal</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-[26%] p-4">
                <span className="sr-only">Capability</span>
              </th>
              {COLS.map((c, n) => (
                <th
                  key={c}
                  scope="col"
                  className={`w-[18.5%] p-4 align-bottom font-semibold ${n === 0 ? "bg-glass-soft font-display text-base text-ink" : "text-ink-2"}`}
                >
                  {n === 0 ? (
                    <span className="flex items-center gap-2">
                      <LanternMark className="h-5 w-5" /> {c}
                    </span>
                  ) : (
                    c
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.row}>
                <th scope="row" className="p-4 font-normal text-ink">
                  {r.row}
                </th>
                {r.cells.map((c, n) => (
                  <td key={n} className={`p-4 align-top ${n === 0 ? "bg-glass-soft" : ""}`}>
                    <Mark c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Compare() {
  const picks = [
    { who: "Google ACE", when: "if you want a managed sandbox on Google Cloud with the strongest isolation defaults." },
    { who: "E2B or Modal", when: "if you want hosted sandboxes today." },
    {
      who: "Lantern",
      when: "if you need to run agents in your own cloud or on-prem, with the sandbox, durable execution, spend limits and audit trail in one stack you control.",
    },
  ];
  return (
    <section id="compare" className="section rule" aria-labelledby="compare-h">
      <div className={wrap}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end">
          <h2 id="compare-h" className="h2">
            How it compares.
          </h2>
          <p className="lede lg:justify-self-end">
            Google Agent Compute Engine, E2B and Modal are managed sandboxes: compute you rent to run agent code. Lantern
            is an open-source agent runtime you host yourself, and its sandbox is one part of it. So the comparison has
            two halves.
          </p>
        </div>
        <CompareTable
          id="cmp-sandbox"
          title="The sandbox"
          intro="This is ACE's whole product, and on isolation it is ahead of Lantern by default: its sandbox never holds a credential and all egress leaves through a proxy on the host, backed by Google's hardware root of trust. Lantern can do the same only in its opt-in broker mode on Firecracker, validated on nested KVM, not at Google's scale."
          rows={SANDBOX}
        />
        <CompareTable
          id="cmp-platform"
          title="The platform around it"
          intro="These are agent-runtime features. ACE is a compute layer, so &ldquo;out of scope&rdquo; means it isn't trying to do them, not that it fails at them; on Google Cloud they come from other products."
          rows={PLATFORM}
        />
        <div className="mt-14">
          <h3 className="font-display text-xl font-semibold text-ink">When to pick which</h3>
          <ul className="mt-4 grid grid-cols-1 gap-x-10 gap-y-4 md:grid-cols-3">
            {picks.map((p) => (
              <li key={p.who} className="border-t border-line pt-4 leading-relaxed text-ink-2">
                <span className="font-semibold text-ink">Pick {p.who}</span> {p.when}
              </li>
            ))}
          </ul>
        </div>
        <p className="mt-10 max-w-3xl text-sm leading-relaxed text-ink-3">
          Competitor columns reflect each vendor&rsquo;s public docs and announcements as of October 2026; the Google
          column follows Google&rsquo;s{" "}
          <a className="link" href="https://cloud.google.com/blog/topics/ai-infrastructure/agent-compute-engine-deep-dive">
            Agent Compute Engine deep dive
          </a>{" "}
          (Oct 22, 2026). A cross means not offered or not announced. If a cell is out of date,{" "}
          <a className="link" href={`${GITHUB}/issues`}>
            open an issue
          </a>
          .
        </p>
      </div>
    </section>
  );
}

// The README's SDK sample, reflowed to fit the column.
const SAMPLE = `import { LanternClient } from "@lantern/sdk";

const lantern = new LanternClient({
  baseUrl: "http://localhost:8080",
  apiKey: process.env.LANTERN_API_KEY,
});

await lantern.agents.create({ name: "triage", description: "Classifies support emails" });
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25, maxCostUsdPerRun: 0.1, hardFail: true,
});

const forecast = await lantern.runs.forecast({
  agentName: "triage", input: "my invoice is wrong again",
});
const run = await lantern.runs.create({
  agent: "triage", input: { email: "..." },
}); // 402 if over budget`;

// ponytail: a four-rule highlighter for one fixed snippet, not a general tokenizer.
const TOKEN = /(\/\/.*$)|("[^"]*")|\b(import|from|const|new|await|true)\b|\b(\d+(?:\.\d+)?)\b/gm;
function highlight(src: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    out.push(src.slice(last, m.index));
    const cls = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : "n";
    out.push(
      <span key={m.index} className={cls}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  out.push(src.slice(last));
  return out;
}

function Code() {
  return (
    <section className="section rule" aria-labelledby="code-h">
      <div className={`${wrap} grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-center`}>
        <div>
          <h2 id="code-h" className="h2">
            A budget before the first token.
          </h2>
          <p className="lede mt-6">
            Create an agent, cap what it may spend, forecast a run, then send it. Over a hard cap the run is refused with
            HTTP 402, before the bill instead of after it.
          </p>
          <p className="mt-6 text-sm text-ink-3">
            Also in Python and Go.{" "}
            <a className="link" href={`${DOCS}`}>
              SDK docs
            </a>
          </p>
        </div>
        <pre className="code min-w-0 p-5 sm:p-7" aria-label="TypeScript SDK example">
          <code>{highlight(SAMPLE)}</code>
        </pre>
      </div>
    </section>
  );
}

function OpenSource() {
  return (
    <section id="start" className="section rule relative overflow-hidden" aria-labelledby="oss-h">
      <div className="closing-glow" aria-hidden="true" />
      <div className={`${wrap} relative`}>
        <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
          <div>
            <h2 id="oss-h" className="h2">Open source. Runs in your cloud.</h2>
          </div>
          <div className="space-y-4 leading-relaxed text-ink-2 md:text-lg">
            <p>
              Apache-2.0, with no paid tier and no feature gates. Everything on this page is in the repository. The data
              plane runs in your VPC and dials out to the control plane, so agent code executes next to your data and
              never on someone else&rsquo;s machine.
            </p>
            <p>
              <a className="link text-ink" href={`${DOCS}architecture/`}>
                Explore the architecture
              </a>
              , or read the{" "}
              <a className="link text-ink" href={`${BLOB}/docs/adr`}>
                design decisions
              </a>{" "}
              behind it.
            </p>
          </div>
        </div>
        <div className="mt-24 flex flex-col items-center text-center md:mt-32">
          <LanternMark className="h-14 w-14" />
          <p className="display mt-8 max-w-4xl text-[clamp(2.75rem,8vw,6.5rem)]">
            Clone it. Run it on your own machines.
          </p>
          <div className="mt-10 w-full max-w-3xl text-left">
            <CopyCommand command={CLONE} label="Clone and start Lantern locally" />
          </div>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <a href={`${GITHUB}#quickstart`} className="btn btn-primary">
              Read the quickstart
            </a>
            <a href={GITHUB} className="btn btn-quiet">
              Star on GitHub
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line py-10">
      <div className={`${wrap} flex flex-wrap items-center justify-between gap-4 text-sm text-ink-3`}>
        <span className="flex items-center gap-2">
          <LanternMark className="h-5 w-5" /> Lantern is open source under Apache-2.0.
        </span>
        <nav aria-label="Footer" className="flex flex-wrap gap-5">
          <a href={DOCS} className="hover:text-ink">
            Docs
          </a>
          <a href={GITHUB} className="hover:text-ink">
            GitHub
          </a>
          <Link href="/privacy/" className="hover:text-ink">
            Privacy
          </Link>
          <Link href="/terms/" className="hover:text-ink">
            Terms
          </Link>
        </nav>
      </div>
    </footer>
  );
}
