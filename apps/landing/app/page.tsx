import { Check, Minus, X } from "lucide-react";
import { HeroFlow } from "./_components/HeroFlow";
import { Lifecycle } from "./_components/Lifecycle";
import { LanternMark } from "./_components/Logo";
import { ThemeToggle } from "./_components/ThemeToggle";

// Landing page. Every claim maps to code on master or the egress-broker stack (opt-in).

const GITHUB = "https://github.com/dshakes/lantern";
const DOCS = "https://dshakes.github.io/lantern/";

export default function LandingPage() {
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 btn btn-primary">
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Why />
        <Egress />
        <LifecycleSection />
        <Security />
        <Cost />
        <Platform />
        <Compare />
        <Start />
      </main>
      <Footer />
    </div>
  );
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="border-t border-line px-4 py-20 sm:px-6 md:py-28">
      <div className="mx-auto max-w-6xl">
        <h2 id={`${id}-h`} className="display max-w-3xl text-4xl font-bold md:text-5xl">
          {title}
        </h2>
        {lede && <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ink-2">{lede}</p>}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

function Nav() {
  const links = [
    ["#egress", "How it works"],
    ["#lifecycle", "Lifecycle"],
    ["#security", "Security"],
    ["#compare", "Compare"],
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="/" className="flex items-center gap-2 font-semibold" aria-label="Lantern home">
          <LanternMark />
          <span className="text-[17px] tracking-tight">Lantern</span>
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
          <a href={GITHUB} className="btn btn-quiet !py-1.5 text-sm">
            GitHub
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="px-4 pb-20 pt-16 sm:px-6 md:pt-24">
      <div className="mx-auto max-w-6xl">
        <h1 className="display max-w-4xl text-[clamp(2.75rem,8vw,5.5rem)] font-extrabold">
          The agent runs outside. Its code runs in a microVM.
        </h1>
        <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-2 md:text-xl">
          Lantern is an open-source runtime for AI agents that you host in your own cloud. The loop, the prompt and the
          model keys stay on your control plane. Code the agent writes runs in a Firecracker or Kata microVM. Every step
          is journaled, every agent has a budget, and every completed run can be signed.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <a href={`${GITHUB}#quickstart`} className="btn btn-primary">
            Run it locally
          </a>
          <a href={DOCS} className="btn btn-quiet">
            Read the docs
          </a>
        </div>
        <div className="mt-16">
          <HeroFlow explore={`${DOCS}architecture/`} />
        </div>
      </div>
    </section>
  );
}

function Why() {
  const items = [
    {
      color: "var(--lx-glass)",
      title: "Untrusted code gets its own kernel",
      body: "Code an agent writes or downloads runs in a Firecracker or Kata microVM, never a bare pod. If the required runtime is missing, the run is refused, not quietly downgraded.",
    },
    {
      color: "var(--lx-flame)",
      title: "The loop is out of reach",
      body: "Prompts, model keys and the run journal live on the control plane. The sandbox receives one tool call, not the conversation. A compromised workload has nothing to steal and nothing to steer.",
    },
    {
      color: "var(--lx-patina)",
      title: "Your cloud, your keys",
      body: "Apache-2.0. The data plane runs in your VPC and dials out to the control plane. No paywalled tier, no feature gates.",
    },
  ];
  return (
    <section aria-label="Why Lantern" className="border-t border-line px-4 py-16 sm:px-6">
      <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title} className="border-l-2 pl-5" style={{ borderColor: it.color }}>
            <h2 className="text-lg font-semibold">{it.title}</h2>
            <p className="mt-2 leading-relaxed text-ink-2">{it.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Egress() {
  const hops = [
    ["Workload", "Sends traffic to 127.0.0.1:3128 like any HTTP proxy. No SDK, no code change."],
    ["Harness", "PID 1 in the VM. Forwards the request over vsock, the VM's only link to the host."],
    ["Host broker", "Runs in the runtime-manager. Checks the destination against this sandbox's allowlist."],
    ["Credential", "Resolved from a lantern.secret/… ref and attached on the host. The VM never sees it."],
    ["Upstream", "Gets an authenticated request. Refused requests go to the audit stream."],
  ];
  return (
    <Section
      id="egress"
      title="The VM asks. The host decides."
      lede="A microVM is only as safe as its way out. Turn on the host egress broker (LANTERN_EGRESS_MODE=broker, opt-in, Firecracker only) and the guest boots with no network device. Every request crosses vsock to a broker on the host, which holds the allowlist and the credentials. Without it, the allowlist is enforced inside the guest."
    >
      <ol className="grid gap-px overflow-hidden rounded-[var(--lx-radius-l)] border border-line bg-line md:grid-cols-5">
        {hops.map(([t, b], n) => (
          <li key={t} className="bg-surface p-5">
            <span className="font-mono text-xs text-ink-3">{n + 1}</span>
            <p className="mt-2 font-medium">{t}</p>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">{b}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function LifecycleSection() {
  return (
    <Section
      id="lifecycle"
      title="Idle sandboxes give their compute back."
      lede="Sandboxes keep their state. Set idleTimeoutSecs and an idle one is snapshotted and stopped, freeing its compute and quota slot. The next exec or file request wakes it. Fork one to try several paths at once: on a real KVM run, three forks shared one memory file and each spawned in 131–160 ms."
    >
      <Lifecycle />
      <p className="mt-8 text-sm text-ink-3">
        Numbers from a Lima nested-virt run on an Apple M4 Max, aarch64. Indicative, not bare metal:{" "}
        <a className="underline decoration-line underline-offset-4 hover:text-ink" href={`${GITHUB}/blob/master/docs/benchmarks/runtime-latency.md`}>
          docs/benchmarks/runtime-latency.md
        </a>
        .
      </p>
    </Section>
  );
}

function Security() {
  const rows: { what: string; how: string; where: string }[] = [
    {
      what: "Your credentials",
      how: "Broker mode (opt-in): attached at the host broker from a lantern.secret ref, so the VM never holds the token. Default mode vends secrets into the VM over a peer-authenticated socket.",
      where: "runtime-manager egress broker (opt-in)",
    },
    {
      what: "A network device",
      how: "In broker mode (opt-in, Firecracker only): the VM has no NIC; the only way out is vsock to the broker, which enforces the per-sandbox allowlist and audits refusals.",
      where: "harness forwarder, host broker (opt-in)",
    },
    {
      what: "The agent's prompt or model keys",
      how: "The loop and the model router run on the control plane. The VM receives one tool call over ExecTool.",
      where: "workflow-engine step_executor.go",
    },
    {
      what: "Someone else's identity",
      how: "Each VM gets its own certificate and Ed25519 agent identity. The manager refuses VM certificates on its control methods.",
      where: "ADR 0025, runtime-manager authz.rs",
    },
    {
      what: "Another tenant's rows",
      how: "tenant_id on every row and gRPC call, a service token on every internal port, and row-level security on every tenant table.",
      where: "ADR 0011, grpcauth",
    },
    {
      what: "A way to rewrite history",
      how: "A completed run's journal is hashed into a signed receipt: Ed25519 when LANTERN_RECEIPT_ED25519_SEED is set (HMAC-SHA256 dev fallback otherwise). Anyone can check an Ed25519 receipt against the published key.",
      where: "/.well-known/lantern-receipts",
    },
  ];
  return (
    <Section id="security" title="What the workload never gets." lede="Each row is something the sandbox does not have, and the place outside it that enforces that.">
      <dl className="divide-y divide-line border-y border-line">
        {rows.map((r) => (
          <div key={r.what} className="grid gap-2 py-6 md:grid-cols-[minmax(0,4fr)_minmax(0,6fr)_minmax(0,3fr)] md:gap-8">
            <dt className="font-semibold">{r.what}</dt>
            <dd className="leading-relaxed text-ink-2">{r.how}</dd>
            <dd className="font-mono text-xs text-ink-3 md:text-right">{r.where}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function Cost() {
  const items = [
    {
      title: "Pay for work, not waiting",
      body: "A sandbox with no activity for idleTimeoutSecs is snapshotted and stopped. The next request wakes it; the first exec waits a few seconds for the in-guest channel to reconnect (~4 s in our Lima benchmark).",
    },
    {
      title: "Budgets that stop the run",
      body: "Per-agent caps on cost per day and runs per day, plus a tenant-wide daily cost cap. Over a hard cap the call returns HTTP 402 before a model is called. Forecast a run's cost, and check the per-run cap, before you send it.",
    },
    {
      title: "Models by capability",
      body: "Ask for model: \"auto\" or \"reasoning-large\". The model router picks a provider by target (cheap, fast, best, balanced) and fails over on retryable errors.",
    },
  ];
  return (
    <Section id="cost" title="Spend stays where you can see it.">
      <div className="grid gap-10 md:grid-cols-3">
        {items.map((it) => (
          <div key={it.title}>
            <h3 className="text-lg font-semibold">{it.title}</h3>
            <p className="mt-2 leading-relaxed text-ink-2">{it.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Platform() {
  const groups: [string, string[]][] = [
    [
      "Reliability",
      [
        "Durable steps that resume from the journal after a crash",
        "Idempotency keys from (run_id, step_id, attempt), so a replay does not double-send",
        "Eval suites that fail CI on regression (HTTP 422)",
        "Rehearsals that replay past failures before traffic flips",
      ],
    ],
    [
      "Building agents",
      [
        "Visual workflow graphs that execute (tool nodes not yet wired)",
        "Sessions with SSE streaming, cron schedules, human approval",
        "17 connectors to real APIs, an MCP registry, A2A cards",
        "TypeScript, Python and Go SDKs and the lantern CLI",
      ],
    ],
    [
      "Runtime",
      [
        "Firecracker, Kata, gVisor and runc tiers by isolation class",
        "Streaming exec and a file API under /workspace",
        "Session-scoped VMs, pause, resume and fork",
        "One trace per spawn, control plane to harness",
      ],
    ],
    [
      "Surfaces",
      [
        "Slack, Telegram, Discord, voice and an embeddable webchat",
        "WhatsApp and iMessage assistants that reply in your voice",
        "Commitment and grounding gates hold risky replies for you",
        "Signed receipts for completed runs, checkable at /proof",
      ],
    ],
  ];
  return (
    <Section id="platform" title="The rest of production, included.">
      <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
        {groups.map(([g, items]) => (
          <div key={g}>
            <h3 className="font-semibold">{g}</h3>
            <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-2">
              {items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

type Cell = "yes" | "partial" | "no" | string;
const COMPARE: { row: string; cells: [Cell, Cell, Cell, Cell] }[] = [
  { row: "Hardware-isolated microVM per sandbox", cells: ["yes", "yes", "yes", "partial: gVisor"] },
  { row: "Agent loop outside the sandbox", cells: ["yes", "not stated", "partial: you host the loop", "partial: you host the loop"] },
  { row: "Credentials never enter the sandbox", cells: ["partial: broker mode, opt-in", "yes", "no", "no"] },
  { row: "Egress allowlist enforced outside the guest", cells: ["partial: broker mode, opt-in", "yes", "partial", "partial: IP/CIDR"] },
  { row: "Idle auto-suspend, resume on demand", cells: ["yes", "yes", "partial", "partial"] },
  { row: "Snapshot and fork", cells: ["yes", "yes", "partial", "partial"] },
  { row: "Durable runs with crash-resume", cells: ["yes", "no", "no", "no"] },
  { row: "Hard budgets and cost forecast", cells: ["yes", "no", "no", "partial"] },
  { row: "Multi-provider model routing", cells: ["yes", "no", "no", "no"] },
  { row: "Signed, offline-verifiable receipts", cells: ["partial: Ed25519 with a configured seed", "no", "no", "no"] },
  { row: "Hardware root of trust", cells: ["partial: recorded, not verified", "yes", "no", "no"] },
  { row: "Self-host, open source", cells: ["yes", "no", "partial", "no"] },
];

function Mark({ c }: { c: Cell }) {
  if (c === "yes")
    return (
      <span className="inline-flex items-center gap-1.5 text-patina">
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Yes</span>
      </span>
    );
  if (c === "no")
    return (
      <span className="inline-flex items-center text-ink-3">
        <X className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">No</span>
      </span>
    );
  if (c !== "partial" && !c.startsWith("partial: ")) return <span className="text-xs text-ink-3">{c}</span>;
  const note = c.startsWith("partial: ") ? c.slice(9) : "";
  return (
    <span className="inline-flex items-start gap-1.5 text-flame">
      <Minus className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="text-xs text-ink-2">{note || "Partial"}</span>
    </span>
  );
}

function Compare() {
  const cols = ["Lantern", "Google Agent Compute Engine", "E2B", "Modal"];
  return (
    <Section
      id="compare"
      title="How it compares."
      lede="Google announced Agent Compute Engine on October 22, 2026: a microVM per agent, credentials kept outside it. Lantern runs that shape today, in your cloud, under Apache-2.0, with durable runs, budgets, model routing and receipts around it."
    >
      <div className="relative overflow-x-auto rounded-[var(--lx-radius-l)] border border-line">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Feature comparison of Lantern, Google Agent Compute Engine, E2B and Modal</caption>
          <thead>
            <tr className="border-b border-line bg-surface">
              <th scope="col" className="p-4 font-medium text-ink-2">
                <span className="sr-only">Capability</span>
              </th>
              {cols.map((c, n) => (
                <th key={c} scope="col" className={`p-4 font-semibold ${n === 0 ? "text-ink" : "text-ink-2"}`}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {COMPARE.map((r) => (
              <tr key={r.row}>
                <th scope="row" className="p-4 font-normal text-ink">
                  {r.row}
                </th>
                {r.cells.map((c, n) => (
                  <td key={n} className={`p-4 align-top ${n === 0 ? "bg-surface/60" : ""}`}>
                    <Mark c={c} />
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row" className="p-4 font-normal text-ink">
                Availability
              </th>
              <td className="bg-surface/60 p-4 text-xs text-ink-2">Open source today</td>
              <td className="p-4 text-xs text-ink-2">Announced; rolling out</td>
              <td className="p-4 text-xs text-ink-2">Generally available</td>
              <td className="p-4 text-xs text-ink-2">Generally available</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-4 max-w-3xl text-sm text-ink-3">
        A cross means not offered or not announced; &ldquo;not stated&rdquo; means the public material doesn&rsquo;t say.
        Other columns reflect each vendor&rsquo;s public docs and announcements as of October 2026; the Google column is per launch coverage (SiliconANGLE, Oct 22 2026), as Google&rsquo;s own documentation was not yet published. If one is out of date,{" "}
        <a className="underline decoration-line underline-offset-4 hover:text-ink" href={`${GITHUB}/issues`}>
          open an issue
        </a>
        .
      </p>
    </Section>
  );
}

function Start() {
  return (
    <Section id="start" title="Run it on your laptop." lede="You need Docker, and Go 1.25+ for the CLI.">
      <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
        <pre className="term overflow-x-auto p-5" aria-label="Quickstart commands">
          <code>
            <span className="text-ink-3">$ </span>git clone https://github.com/dshakes/lantern.git && cd lantern{"\n"}
            <span className="text-ink-3">$ </span>make dev{"\n"}
            <span className="text-ink-3">$ </span>( cd packages/cli && go install ./cmd/lantern ){"\n"}
            <span className="text-ink-3">$ </span>lantern doctor{"\n"}
            <span className="text-ink-3">$ </span>lantern onboard
          </code>
        </pre>
        <div>
          <p className="leading-relaxed text-ink-2">
            <code className="font-mono text-sm text-ink">make dev</code> starts Postgres, Redis, MinIO, the control plane and
            the dashboard on localhost:3001. <code className="font-mono text-sm text-ink">lantern doctor</code> checks the
            stack end to end. <code className="font-mono text-sm text-ink">lantern onboard</code> turns a one-line
            description into a running agent.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href={`${GITHUB}#quickstart`} className="btn btn-primary">
              Read the quickstart
            </a>
            <a href={GITHUB} className="btn btn-quiet">
              Star on GitHub
            </a>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line px-4 py-10 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-sm text-ink-3">
        <span className="flex items-center gap-2">
          <LanternMark className="h-5 w-5" /> Lantern is open source under Apache-2.0.
        </span>
        <nav aria-label="Footer" className="flex gap-5">
          <a href={DOCS} className="hover:text-ink">
            Docs
          </a>
          <a href={GITHUB} className="hover:text-ink">
            GitHub
          </a>
          <a href="/privacy" className="hover:text-ink">
            Privacy
          </a>
        </nav>
      </div>
    </footer>
  );
}
