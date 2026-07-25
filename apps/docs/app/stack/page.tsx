import { Concept } from "../_components/Concept";

export default function StackPage() {
  return (
    <>
      <h1>The Stack</h1>
      <p>
        Lantern is a polyglot monorepo <strong>on purpose</strong>. Four
        languages, three data stores, one contract format. This page is the
        honest answer to &ldquo;why is there Rust <em>and</em> Go in here?&rdquo;
        — what each piece is, what job it holds, and why that job went to that
        tool instead of the obvious one.
      </p>

      <Concept>
        A platform that runs other people&apos;s agents has three very different
        jobs. It has to <strong>coordinate</strong> (who owns what, what ran
        when, who gets billed) — that wants a language with great database and
        cluster libraries. It has to <strong>be fast on every single request</strong>{" "}
        (routing tokens, holding sandboxes open) — that wants a language with no
        garbage-collector pauses. And it has to{" "}
        <strong>be pleasant to build against</strong> — that wants the language
        the AI ecosystem already lives in. No single language is best at all
        three, so we stopped pretending and picked the right one per layer.
      </Concept>

      <h2 id="rule">The rule</h2>
      <p>
        Right tool per layer. <strong>Never unify for unification&apos;s sake.</strong>{" "}
        Adding a new language requires an ADR (
        <a
          href="https://github.com/dshakes/lantern/blob/master/docs/adr/0001-language-stack.md"
          target="_blank"
          rel="noopener noreferrer"
        >
          ADR 0001
        </a>
        ) — the bar is deliberately high, because every extra language is a
        second CI matrix, a second set of security advisories, and a second
        thing a new hire has to learn.
      </p>

      <h2 id="languages">Languages, and the job each one holds</h2>
      <table>
        <thead>
          <tr>
            <th>Layer</th>
            <th>Language</th>
            <th>Why this one</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Control plane, workflow engine, scheduler, memory, billing</td>
            <td>
              <strong>Go 1.23</strong>
            </td>
            <td>
              Kubernetes is written in Go, so every cluster library is
              first-class. Compiles to one static binary with no runtime to
              install. Mature gRPC + Postgres ecosystem. Its concurrency model
              (goroutines) suits work that is mostly <em>waiting</em> — on a
              database, on another service.
            </td>
          </tr>
          <tr>
            <td>Gateway, model router, runtime manager, surface gateway</td>
            <td>
              <strong>Rust 2024</strong>
            </td>
            <td>
              The hot path. Rust has no garbage collector, so there are no
              unpredictable pauses while a token stream is in flight — latency
              stays flat instead of spiking. It also frees memory
              deterministically, which matters for a process babysitting
              hundreds of sandboxes. Firecracker itself is Rust, so we speak its
              native language.
            </td>
          </tr>
          <tr>
            <td>Dashboard, landing page, docs site</td>
            <td>
              <strong>TypeScript / Next.js 15</strong>
            </td>
            <td>
              React Server Components + streaming means the run waterfall can
              render tokens as they arrive rather than after. And it is the same
              language as our primary SDK, so types flow straight through.
            </td>
          </tr>
          <tr>
            <td>Primary SDK</td>
            <td>
              <strong>TypeScript</strong>
            </td>
            <td>Where the agent ecosystem already lives.</td>
          </tr>
          <tr>
            <td>Secondary SDKs</td>
            <td>
              <strong>Python 3.11+</strong>, <strong>Go</strong>
            </td>
            <td>Python for AI/ML users, Go for infra users.</td>
          </tr>
          <tr>
            <td>
              CLI (<code>lantern</code>)
            </td>
            <td>
              <strong>Go / Cobra</strong>
            </td>
            <td>
              Static binary, trivial cross-compilation to every OS, and it
              reuses the same gRPC client the services use.
            </td>
          </tr>
          <tr>
            <td>API contracts</td>
            <td>
              <strong>protobuf3</strong>
            </td>
            <td>
              One source of truth for types that cross a service boundary.
              Generates Go and TypeScript, so a field rename cannot silently
              drift between two services.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="glossary">What these things actually are</h2>
      <p>
        If a name below is unfamiliar, this is the whole idea in a sentence —
        no prior infrastructure background assumed.
      </p>
      <table>
        <thead>
          <tr>
            <th>Thing</th>
            <th>In one sentence</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>gRPC</strong>
            </td>
            <td>
              How our services call each other — like a web request, but with a
              schema both sides agreed on in advance, so a typo is a compile
              error rather than a 3am page.
            </td>
          </tr>
          <tr>
            <td>
              <strong>protobuf</strong>
            </td>
            <td>
              The schema language for those calls. You write the message shape
              once; code for every language is generated from it.
            </td>
          </tr>
          <tr>
            <td>
              <strong>Firecracker</strong>
            </td>
            <td>
              A very small, very fast virtual machine built by AWS to run Lambda.
              Boots in about a tenth of a second and gives untrusted code its own
              kernel, so escaping it means breaking the hardware boundary, not
              just a container.
            </td>
          </tr>
          <tr>
            <td>
              <strong>gVisor</strong>
            </td>
            <td>
              A sandbox that pretends to be the operating system. The workload
              thinks it is talking to Linux; it is actually talking to a
              user-space impersonation that only forwards the safe calls.
            </td>
          </tr>
          <tr>
            <td>
              <strong>Kata Containers</strong>
            </td>
            <td>
              Containers that are secretly full virtual machines. Broader
              compatibility than Firecracker, slower to start — used for hostile
              input.
            </td>
          </tr>
          <tr>
            <td>
              <strong>The harness</strong>
            </td>
            <td>
              Our Rust program that boots as the very first process inside every
              microVM. It hands out secrets, enforces the egress allowlist, and
              streams logs and heartbeats home. It is the last trust boundary
              around the workload.
            </td>
          </tr>
          <tr>
            <td>
              <strong>Control plane / data plane</strong>
            </td>
            <td>
              The split between the part that <em>decides</em> (our SaaS: who
              owns what, what should run) and the part that{" "}
              <em>executes</em> (your cloud account: the actual agent code and
              your data). Your data never has to leave your infrastructure.
            </td>
          </tr>
          <tr>
            <td>
              <strong>pgvector</strong>
            </td>
            <td>
              A Postgres extension that stores embeddings and finds similar ones
              — semantic search without running a separate vector database.
            </td>
          </tr>
          <tr>
            <td>
              <strong>OTel (OpenTelemetry)</strong>
            </td>
            <td>
              The vendor-neutral standard for traces and metrics. Every Lantern
              service emits it, so one run can be followed across five services
              in whatever monitoring tool you already own.
            </td>
          </tr>
          <tr>
            <td>
              <strong>RLS (Row-Level Security)</strong>
            </td>
            <td>
              A Postgres feature that filters rows by tenant inside the database
              itself. Tenant isolation survives an application bug, because the
              database refuses to return the other tenant&apos;s rows regardless
              of what the query asked for.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="data">Data stores</h2>
      <p>
        Three, and adding a fourth requires an ADR. Between them they cover
        every current need.
      </p>
      <table>
        <thead>
          <tr>
            <th>Store</th>
            <th>Holds</th>
            <th>Why not something else</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>Postgres</strong> (+ pgvector)
            </td>
            <td>
              Everything durable: tenants, agents, runs, the event journal,
              budgets, receipts, embeddings.
            </td>
            <td>
              Transactions, JSONB, and row-level security in one engine. pgvector
              means we do not need a separate vector database.
            </td>
          </tr>
          <tr>
            <td>
              <strong>Redis</strong>
            </td>
            <td>
              Caching, rate limiting, queues, and the pub/sub that pushes live
              run events to the dashboard.
            </td>
            <td>
              This data is allowed to be lost on restart. Putting it in Postgres
              would mean paying durability costs for something disposable.
            </td>
          </tr>
          <tr>
            <td>
              <strong>S3 / MinIO</strong>
            </td>
            <td>
              Large blobs: agent bundles, microVM snapshots, attachments.
            </td>
            <td>
              Big binary objects do not belong in a relational database. MinIO is
              the S3-compatible local stand-in for development.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="e2e">End to end: one run, all the way through</h2>
      <p>
        This is what actually happens between{" "}
        <code>lantern run agent.yaml</code> and a result. Every hop below is a
        real process boundary.
      </p>
      <pre>
        <code>{`  you ──▶ CLI / SDK / dashboard                          (Go · TypeScript)
           │  REST or gRPC, bearer token
           ▼
  1  CONTROL PLANE                                      (Go, :8080 / :50051)
           │  authenticate, resolve tenant, check budget + quota,
           │  write the run row, mint a per-instance identity
           ▼
  2  WORKFLOW ENGINE                                     (Go, :50052)
           │  the only thing allowed to mutate run state.
           │  each step is journaled, so a crash resumes instead of restarting
           ├──────────────▶ 3  MODEL ROUTER              (Rust, :50053)
           │                     picks a real vendor model from a capability
           │                     name like "reasoning-large", handles failover,
           │                     meters tokens and cost
           ▼
  4  RUNTIME SCHEDULER                                   (Go, :50055)
           │  picks a node: warm pool, region, fair share, cost, health
           ▼
  5  RUNTIME MANAGER                                     (Rust, :50054)
           │  spawns the workload in the isolation class the spec declared
           │  (Firecracker · Kata · K8s Job · Wasmtime · Docker)
           ▼
  6  HARNESS — PID 1 inside the sandbox                  (Rust)
           │  vends short-lived secrets, enforces the egress allowlist,
           │  streams logs, heartbeats, and cost back up
           ▼
     your agent code runs

  results flow back the same way, streaming:
     harness ──▶ manager ──▶ control plane ──▶ SSE ──▶ dashboard / SDK
                                  │
                                  └──▶ journal_events (Postgres)
                                       the durable record: replay, receipts, audit`}</code>
      </pre>

      <h2 id="invariants">The rules that hold it together</h2>
      <p>
        The stack choices above only pay off because a handful of boundaries are
        never crossed. These are load-bearing — breaking one causes an incident,
        not a bug.
      </p>
      <ul>
        <li>
          <strong>The control plane never touches your code.</strong> Only the
          runtime manager talks to Firecracker or Kata or pods.
        </li>
        <li>
          <strong>One writer for run state.</strong> Services emit events; the
          workflow engine is the only thing that writes the outcome. No service
          updates the <code>runs</code> table directly.
        </li>
        <li>
          <strong>Anything slow is durable.</strong> If it can take more than
          100ms or calls a model, it becomes a journaled step — idempotent and
          replayable, so a restart resumes mid-run.
        </li>
        <li>
          <strong>Streaming never buffers.</strong> No service is allowed to
          collect a whole response and then forward it.
        </li>
        <li>
          <strong>Untrusted code gets a microVM.</strong> Never a bare
          container. If the cluster cannot provide the declared isolation, the
          workload is refused rather than quietly downgraded.
        </li>
        <li>
          <strong>Models are named by capability, not vendor.</strong> Your code
          says <code>reasoning-large</code>; the router decides it is a specific
          vendor model today and something better next month.
        </li>
        <li>
          <strong>Multi-tenant by default.</strong> Every row carries a tenant,
          every call carries a tenant, and Postgres row-level security enforces
          it below the application.
        </li>
        <li>
          <strong>Secrets never appear in logs, traces, or run state.</strong>{" "}
          Only a reference travels; the harness resolves it at the moment of
          use.
        </li>
      </ul>

      <h2 id="tradeoffs">What this costs us</h2>
      <p>
        Being honest about the bill, because a stack page that only lists
        benefits is marketing:
      </p>
      <ul>
        <li>
          <strong>Four language toolchains in CI.</strong> Every pull request
          runs golangci-lint, <code>cargo clippy -D warnings</code>, and
          eslint/tsc. Slower pipeline, more supply-chain surface to audit.
        </li>
        <li>
          <strong>Contract changes are two-step.</strong> Touching a proto means
          regenerating, then fixing both the Go and the Rust side. Deliberate —
          the friction is what stops silent drift.
        </li>
        <li>
          <strong>A wider hiring surface.</strong> Nobody is deep in all four.
          The mitigation is that the boundaries are narrow enough to work in one
          layer without holding the others in your head.
        </li>
        <li>
          <strong>Rust is slower to write.</strong> We accept that only where
          latency or memory determinism actually pays for it — never for CRUD.
        </li>
      </ul>
    </>
  );
}
