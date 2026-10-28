import { ArrowRight, Check, Minus, X } from "lucide-react";
import Link from "next/link";
import { BrokerDemo } from "./_components/BrokerDemo";
import { CopyCommand } from "./_components/CopyCommand";
import { LanternMark } from "./_components/Logo";
import { Actions, BASE, BLOB, DOCS, Footer, Nav, wrap } from "./_components/site";

// Landing page. Every claim maps to code on master, the README, or a recorded run;
// opt-in features say so where they are claimed.

const CLONE = "git clone https://github.com/dshakes/lantern.git && cd lantern && make demo";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="btn btn-primary sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <How />
        <PainFix />
        <Measured />
        <Compare />
        <Code />
        <Start />
      </main>
      <Footer />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-h">
      <div
        className={`${wrap} relative grid grid-cols-1 gap-12 pb-16 pt-12 md:pb-24 md:pt-16 lg:grid-cols-[minmax(0,6.4fr)_minmax(0,5.6fr)] lg:items-center lg:gap-12`}
      >
        <div>
          <p className="eyebrow">Agents now write and run code, mostly on someone else&rsquo;s machine.</p>
          <h1 id="hero-h" className="display mt-5 text-[clamp(2.75rem,5.5vw,5rem)]">
            <span className="block whitespace-nowrap">Run your agents</span>
            <span className="block whitespace-nowrap">in your own cloud.</span>
          </h1>
          <div className="mt-7">
            <p className="lede !text-[clamp(1.1rem,1.5vw,1.3rem)]">
              Lantern runs agent code in a microVM and gives it the rest of production: crash-resume, spend caps, model
              routing and signed receipts. In your VPC, Apache-2.0.
            </p>
            <div className="mt-8">
              <Actions />
            </div>
          </div>
        </div>
        <div className="relative">
          <div className="proof-glow" aria-hidden="true" />
          <BrokerDemo recording={`${BLOB}/docs/media/egress-broker-kvm.gif`} poster={`${BASE}/media/broker-run-poster.webp`} />
        </div>
      </div>
    </section>
  );
}

function How() {
  const steps = [
    {
      where: "Control plane",
      tone: "var(--lx-ink)",
      hop: "one tool call",
      title: "Your agent thinks here",
      body: "The agent loop, its prompts and your model keys stay on the control plane. When a step needs to run code, it sends one tool call to the VM.",
    },
    {
      where: "microVM",
      tone: "var(--lx-flame)",
      hop: "to the host",
      title: "Its code runs here",
      body: "A Firecracker or Kata microVM with its own kernel. The code runs as an unprivileged user and never sees a model key or a service token.",
    },
    {
      where: "Host",
      tone: "var(--lx-patina)",
      hop: "",
      title: "The host decides what leaves",
      body: "In broker mode (opt-in, Firecracker) the VM has no network card. The host checks every request against the allowlist and adds the credential. Without it, the allowlist is enforced inside the VM.",
    },
  ];
  return (
    <section id="how" className="section band" aria-labelledby="how-h">
      <div className={wrap}>
        <div className="mx-auto max-w-3xl text-center">
          <h2 id="how-h" className="h2">
            The VM asks. The host decides.
          </h2>
          <p className="lede mx-auto mt-6">
            Three places, three jobs. The agent thinks outside the box, its code runs inside it, and the host decides
            what leaves.
          </p>
        </div>
        <ol className="flow relative mt-12 grid grid-cols-1 gap-px rounded-[var(--lx-radius-l)] border border-line bg-line md:mt-14 md:grid-cols-3">
          <span className="wire" aria-hidden="true">
            <span className="spark" />
          </span>
          {steps.map((s, i) => (
            <li
              key={s.where}
              className={`relative p-6 first:rounded-t-[var(--lx-radius-l)] last:rounded-b-[var(--lx-radius-l)] md:p-8 md:first:rounded-l-[var(--lx-radius-l)] md:first:rounded-tr-none md:last:rounded-r-[var(--lx-radius-l)] md:last:rounded-bl-none ${
                s.where === "microVM" ? "vm-cell" : "bg-surface"
              }`}
            >
              {s.where === "microVM" && <span className="vm-flame" aria-hidden="true" />}
              {s.where === "Host" && (
                <span className="cred-badge">
                  <Check className="h-3.5 w-3.5" aria-hidden="true" /> credential added
                </span>
              )}
              {s.hop && (
                <span className="hop" aria-label={`then over ${s.hop}`}>
                  {s.hop}
                </span>
              )}
              <div className="relative flex items-center gap-3">
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
              <h3 className="relative mt-6 font-display text-2xl font-bold tracking-tight">{s.title}</h3>
              <p className="relative mt-3 leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-6 text-sm text-ink-3">
          See every hop and credential in the{" "}
          <a className="link" href={`${DOCS}architecture/`}>
            interactive architecture explorer
          </a>
          .
        </p>
      </div>
    </section>
  );
}

function PainFix() {
  const cards = [
    {
      pain: "It runs on someone else’s cloud.",
      fix: "Next to your data.",
      body: "Apache-2.0, deployed in your VPC or on-prem. The data plane dials out to the control plane, so the sandboxes and the run data stay in your account.",
    },
    {
      pain: "A crash starts the run over.",
      fix: "It resumes.",
      body: "Every step is journaled. After a crash the run is picked up again and the steps that already finished are skipped, not repeated.",
    },
    {
      pain: "Nothing stops the spend.",
      fix: "Refused before the call.",
      body: "Daily caps on cost, runs and tokens return HTTP 402 before the model is called, not after the bill arrives.",
    },
    {
      pain: "Nobody can prove what ran.",
      fix: "A signed receipt.",
      body: "Every finished run can get a receipt that anyone can verify offline, once you configure a signing key.",
    },
  ];
  return (
    <section className="section rule" aria-labelledby="pain-h">
      <div className={wrap}>
        <h2 id="pain-h" className="h2 max-w-4xl">
          The sandbox is one part.
        </h2>
        <ul className="mt-12 grid grid-cols-1 gap-4 md:mt-14 md:grid-cols-2">
          {cards.map((c) => (
            <li key={c.pain} className="pain-card">
              <p className="text-ink-3">
                <span className="sr-only">Without a runtime: </span>
                {c.pain}
              </p>
              <p className="mt-3 flex items-baseline gap-3 font-display text-[clamp(1.75rem,3.2vw,2.5rem)] font-bold leading-tight tracking-tight">
                <ArrowRight className="h-6 w-6 shrink-0 translate-y-0.5 text-flame" aria-hidden="true" />
                <span>
                  <span className="sr-only">With Lantern: </span>
                  {c.fix}
                </span>
              </p>
              <p className="mt-4 leading-relaxed text-ink-2">{c.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-sm text-ink-3">
          Plus model routing with failover, eval suites that gate CI, sessions, schedules and 18 connectors.{" "}
          <a className="link" href={DOCS}>
            Everything, in the docs
          </a>
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
      <div className={`${wrap} grid grid-cols-1 gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)] lg:items-center`}>
        <div>
          <h2 id="measured-h" className="h2 !text-[clamp(2rem,3.6vw,3.25rem)]">
            Snapshot an idle agent in 634&nbsp;ms.{" "}
            <span className="ind">indicative, nested KVM on an M4 Max</span> Fork it in under 160&nbsp;ms.
          </h2>
          <p className="lede mt-6">
            An idle sandbox is snapshotted and stopped, so it gives its compute back, and wakes on the next request. Fork
            one to try several paths at once: three forks shared one memory snapshot, with no copy.
          </p>
          <p className="mt-6 text-sm leading-relaxed text-ink-3">
            One Firecracker run, 1 vCPU and 128 MiB per VM, on a laptop rather than bare metal.{" "}
            <a className="link" href={`${BLOB}/docs/benchmarks/runtime-latency.md`}>
              Full benchmark
            </a>
            {", "}
            <a className="link" href={`${BLOB}/docs/media/lifecycle-kvm.gif`}>
              watch the recording
            </a>
          </p>
        </div>
        <figure className="rounded-[var(--lx-radius-l)] border border-line bg-surface p-6 md:p-8">
          <figcaption className="text-sm font-medium text-ink">Milliseconds, one run</figcaption>
          <table className="mt-5 w-full text-sm">
            <caption className="sr-only">Lifecycle step durations in milliseconds</caption>
            <tbody>
              {TIMINGS.map((t) => (
                <tr key={t.step}>
                  <th scope="row" className="w-24 py-1.5 pr-3 text-left font-normal text-ink-2">
                    {t.step}
                  </th>
                  <td className="py-1.5">
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
      </div>
    </section>
  );
}

type Mark = "yes" | "no" | "partial" | "na";
const SUMMARY: { row: string; lantern: [Mark, string]; managed: [Mark, string] }[] = [
  { row: "Runs in your VPC or on-prem", lantern: ["yes", "Apache-2.0"], managed: ["partial", "ACE is Google Cloud only; E2B partly"] },
  { row: "Crash-resume for agent runs", lantern: ["yes", "Journaled steps"], managed: ["na", "Out of scope for a sandbox"] },
  { row: "Spend caps before the model call", lantern: ["partial", "Daily caps; per-run cap on workflows only"], managed: ["na", "Out of scope; Modal partly"] },
  { row: "Model routing with failover", lantern: ["yes", "Across providers"], managed: ["na", "Out of scope for a sandbox"] },
  {
    row: "Credentials kept outside the sandbox",
    lantern: ["partial", "Opt-in broker mode"],
    managed: ["partial", "ACE by default; E2B (beta) and Modal (experimental) opt-in"],
  },
];

function MarkIcon({ m }: { m: Mark }) {
  const Icon = m === "yes" ? Check : m === "no" ? X : Minus;
  const tone = m === "yes" ? "text-patina" : m === "partial" ? "text-flame" : "text-ink-3";
  return (
    <>
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} aria-hidden="true" />
      <span className="sr-only">{{ yes: "Yes", no: "No", partial: "Partly", na: "Not applicable" }[m]}: </span>
    </>
  );
}

function Compare() {
  return (
    <section id="compare" className="section rule" aria-labelledby="compare-h">
      <div className={wrap}>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-end">
          <h2 id="compare-h" className="h2">
            A runtime, not a rented sandbox.
          </h2>
          <p className="lede lg:justify-self-end">
            On sandbox isolation Google ACE leads: credentials and egress stay outside its sandbox by default, on
            Google&rsquo;s hardware root of trust. Lantern comes closest only in opt-in broker mode. Where it differs is
            everything around the sandbox.
          </p>
        </div>
        <table className="sum mt-12">
          <caption className="sr-only">Lantern compared with managed sandboxes (Google ACE, E2B, Modal)</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Capability</span>
              </th>
              <th scope="col" className="sum-us">
                <span className="flex items-center gap-2">
                  <LanternMark className="h-5 w-5" /> Lantern
                </span>
              </th>
              <th scope="col">Managed sandboxes (ACE, E2B, Modal)</th>
            </tr>
          </thead>
          <tbody>
            {SUMMARY.map((r) => (
              <tr key={r.row}>
                <th scope="row">{r.row}</th>
                <td className="sum-us" data-label="Lantern">
                  <span className="flex items-start gap-2">
                    <MarkIcon m={r.lantern[0]} />
                    {r.lantern[1]}
                  </span>
                </td>
                <td data-label="Managed sandboxes">
                  <span className="flex items-start gap-2">
                    <MarkIcon m={r.managed[0]} />
                    {r.managed[1]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-6">
          <Link href="/compare/" className="link inline-flex items-center gap-1.5 font-medium text-ink">
            Full comparison, column by column <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </p>
      </div>
    </section>
  );
}

const SAMPLE = `const lantern = new LanternClient({
  baseUrl: "http://localhost:8080",
  apiKey: process.env.LANTERN_API_KEY,
});

await lantern.agents.create({ name: "triage" });
await lantern.budgets.upsert("triage", {
  maxCostUsdPerDay: 25,
  hardFail: true,
});

await lantern.runs.create({ agent: "triage", input });`;

// The body POST /v1/runs writes when a hard cap blocks the run (rest.go, CheckBudget's
// reason string). Only the dollar amounts are an example.
const REASON = "daily spend would reach $25.0318 exceeding limit $25.0000";
const RESPONSE = `{
  "error": "agent budget limit reached: ${REASON}",
  "reason": "${REASON}"
}`;

// ponytail: a four-rule highlighter for one fixed snippet, not a general tokenizer.
const TOKEN = /(\/\/.*$)|("[^"]*")|\b(const|new|await|true)\b|\b(\d+(?:\.\d+)?)\b/gm;
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
      <div className={`${wrap} grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,3.4fr)_minmax(0,8.6fr)] lg:items-center`}>
        <div>
          <h2 id="code-h" className="h2">
            A budget before the first token.
          </h2>
          <p className="lede mt-6">Cap what an agent may spend. Over the cap, the run is refused before the bill.</p>
          <p className="mt-4 text-sm leading-relaxed text-ink-2">
            Enforced today: per-agent daily cost, runs and tokens, and a tenant-wide daily cost cap. Workflow runs also
            stop mid-run at a per-run cost cap and at per-tool limits.
          </p>
          <p className="mt-4 text-sm text-ink-3">
            TypeScript shown; Python and Go too.{" "}
            <a className="link" href={DOCS}>
              SDK docs
            </a>
          </p>
        </div>
        <div className="min-w-0">
          <pre className="code p-5 sm:p-7" aria-label="TypeScript SDK example" tabIndex={0}>
            <code>{highlight(SAMPLE)}</code>
          </pre>
          <figure className="response mt-3" aria-label="The response when the cap is reached">
            <div className="response-bar">
              <span className="status-pill">402 Payment Required</span>
              <span>POST /v1/runs</span>
            </div>
            <pre className="code response-body p-5 sm:px-7" tabIndex={0}>
              <code>{RESPONSE}</code>
            </pre>
            <figcaption className="mt-3 text-sm text-ink-3">
              No model call is made. The fields and wording are the handler&rsquo;s; the dollar amounts are an example.
            </figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

function Start() {
  return (
    <section id="start" className="section rule relative overflow-hidden" aria-labelledby="start-h">
      <div className="closing-glow" aria-hidden="true" />
      <div className={`${wrap} relative flex flex-col items-center text-center`}>
        <LanternMark className="h-14 w-14" />
        <h2 id="start-h" className="display mt-8 max-w-4xl text-[clamp(2.5rem,7vw,5.5rem)]">
          Clone it. Run it on your own machines.
        </h2>
        <div className="mt-10 w-full max-w-3xl text-left">
          <CopyCommand command={CLONE} label="Clone and start the Lantern demo (Docker, no API key)" />
        </div>
        <div className="mt-6">
          <Actions center />
        </div>
      </div>
    </section>
  );
}
