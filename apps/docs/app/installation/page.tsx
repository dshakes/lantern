import Link from "next/link";

export default function InstallationPage() {
  return (
    <>
      <h1>Installation</h1>
      <p>
        Clone the repo, start three commands, and you have a full local Lantern
        stack running in under two minutes. This page covers everything from
        prerequisites to verifying every service is healthy.
      </p>

      {/* ── Table of Contents ── */}
      <div className="toc">
        <p className="toc-title">On this page</p>
        <ul>
          <li><a href="#prerequisites">Prerequisites</a></li>
          <li><a href="#clone">Clone the repo</a></li>
          <li><a href="#one-command">One-command stack</a></li>
          <li><a href="#what-booted">What just booted</a></li>
          <li><a href="#credentials">Dev credentials</a></li>
          <li><a href="#ports">Service ports</a></li>
          <li><a href="#make-targets">Make targets (power users)</a></li>
          <li><a href="#next">Next steps</a></li>
        </ul>
      </div>

      {/* ── Prerequisites ── */}
      <h2 id="prerequisites">Prerequisites</h2>
      <table>
        <thead>
          <tr><th>Tool</th><th>Min version</th><th>Homebrew install</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Docker Desktop</strong></td>
            <td>v4.x+</td>
            <td><code>brew install --cask docker</code></td>
          </tr>
          <tr>
            <td><strong>Node.js</strong></td>
            <td>v20+</td>
            <td><code>brew install node</code></td>
          </tr>
          <tr>
            <td><strong>Go</strong></td>
            <td>v1.23+</td>
            <td><code>brew install go</code></td>
          </tr>
          <tr>
            <td><strong>Git</strong></td>
            <td>any</td>
            <td><code>brew install git</code></td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-info">
        <strong>Docker must be running</strong> before you start. The
        infrastructure services (Postgres, Redis, MinIO) run in Docker
        containers managed by Compose.
      </div>

      {/* ── Clone ── */}
      <h2 id="clone">Clone the repo</h2>
      <pre><code>{`git clone https://github.com/dshakes/lantern.git
cd lantern`}</code></pre>

      {/* ── One-command stack ── */}
      <h2 id="one-command">One-command stack</h2>
      <p>
        The fastest path boots infrastructure, the control-plane API, the
        dashboard, and the WhatsApp bridge all at once:
      </p>
      <pre><code>{`lantern dev`}</code></pre>
      <p>
        Prefer running services individually (for faster restarts during
        development)? Use the Make targets in sequence:
      </p>
      <pre><code>{`# Terminal 1 — infrastructure (Postgres, Redis, MinIO)
make dev-infra

# Terminal 2 — control-plane API on :8080
make run-api

# Terminal 3 — Next.js dashboard on :3001
make dashboard-dev`}</code></pre>

      <div className="callout callout-warning">
        <strong>Never run <code>go run ./cmd/server</code> directly.</strong>{" "}
        It defaults to your OS username for Postgres auth and will fail.
        Always use <code>make run-api</code>, which injects the correct
        <code>DATABASE_URL</code>, <code>REDIS_URL</code>, and{" "}
        <code>S3_ENDPOINT</code>.
      </div>

      {/* ── Architecture diagram ── */}
      <h2 id="what-booted">What just booted</h2>
      <p>
        Here is the full local stack after <code>lantern dev</code> completes:
      </p>

      {/* Styled-div diagram */}
      <div style={{
        background: "#0d0d12",
        border: "1px solid #1e2235",
        borderRadius: "12px",
        padding: "1.5rem",
        marginBottom: "1.5rem",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
        lineHeight: "1.9",
        overflowX: "auto",
      }}>
        {/* Row: your browser */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
          <span style={{
            background: "#1e293b",
            border: "1px solid #38bdf8",
            color: "#38bdf8",
            borderRadius: "6px",
            padding: "0.2rem 0.7rem",
            whiteSpace: "nowrap",
          }}>Your browser</span>
          <span style={{ color: "#71717a" }}>─────────────────────────────────────</span>
          <span style={{
            background: "#1e293b",
            border: "1px solid #8b5cf6",
            color: "#8b5cf6",
            borderRadius: "6px",
            padding: "0.2rem 0.7rem",
            whiteSpace: "nowrap",
          }}>Dashboard :3001</span>
        </div>

        {/* Connector line */}
        <div style={{ marginLeft: "3.5rem", color: "#52525b" }}>│</div>

        {/* Control plane */}
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
          <span style={{ color: "#52525b", width: "3.5rem", textAlign: "right", display: "inline-block" }}>HTTP</span>
          <span style={{ color: "#52525b" }}>▼</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.25rem" }}>
          <span style={{
            background: "#1a1a2e",
            border: "1px solid #f59e0b",
            color: "#f59e0b",
            borderRadius: "6px",
            padding: "0.25rem 1rem",
            whiteSpace: "nowrap",
          }}>Control Plane :8080 / :50051</span>
          <span style={{ color: "#71717a", fontSize: "0.7rem" }}>Sessions · Agents · Runs · Connectors · Model Router · Scheduler</span>
        </div>

        {/* Connector lines to infra */}
        <div style={{ marginLeft: "1.5rem", color: "#52525b", marginBottom: "0.25rem" }}>│&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;│&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;│</div>
        <div style={{ marginLeft: "1.5rem", color: "#52525b", marginBottom: "0.5rem" }}>▼&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;▼&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;▼</div>

        {/* Infra row */}
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <span style={{
            background: "#0f2922",
            border: "1px solid #34d399",
            color: "#34d399",
            borderRadius: "6px",
            padding: "0.2rem 0.7rem",
            whiteSpace: "nowrap",
          }}>Postgres :5432</span>
          <span style={{
            background: "#0f2922",
            border: "1px solid #34d399",
            color: "#34d399",
            borderRadius: "6px",
            padding: "0.2rem 0.7rem",
            whiteSpace: "nowrap",
          }}>Redis :6379</span>
          <span style={{
            background: "#0f2922",
            border: "1px solid #34d399",
            color: "#34d399",
            borderRadius: "6px",
            padding: "0.2rem 0.7rem",
            whiteSpace: "nowrap",
          }}>MinIO :9000</span>
        </div>
        <div style={{ marginTop: "0.75rem", color: "#52525b", fontSize: "0.7rem" }}>
          Infrastructure runs in Docker containers · Control plane + Dashboard run as host processes
        </div>
      </div>

      <div className="callout callout-tip">
        <strong>Health check:</strong> run{" "}
        <code>make dev-doctor</code> at any time. It probes every service and
        infra container and reports what is healthy, what is down, and what is
        misconfigured.
      </div>

      {/* ── Dev credentials ── */}
      <h2 id="credentials">Dev credentials</h2>
      <p>
        Everything below is seeded automatically on first boot. No setup
        required.
      </p>
      <table>
        <thead>
          <tr><th>Service</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>PostgreSQL</td>
            <td><code>postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable</code></td>
          </tr>
          <tr>
            <td>Redis</td>
            <td><code>redis://localhost:6379</code></td>
          </tr>
          <tr>
            <td>MinIO endpoint</td>
            <td><code>http://localhost:9000</code> · console at <code>:9001</code></td>
          </tr>
          <tr>
            <td>MinIO credentials</td>
            <td><code>lantern</code> / <code>lanternsecret</code></td>
          </tr>
          <tr>
            <td>Dashboard login</td>
            <td><code>admin@lantern.dev</code> / <code>lantern</code></td>
          </tr>
          <tr>
            <td>JWT secret</td>
            <td><code>lantern-dev-jwt-secret-do-not-use-in-production</code></td>
          </tr>
          <tr>
            <td>Dev tenant ID</td>
            <td><code>00000000-0000-0000-0000-000000000001</code> (slug: <code>dev</code>)</td>
          </tr>
          <tr>
            <td>Dev user ID</td>
            <td><code>00000000-0000-0000-0000-000000000002</code> (role: <code>owner</code>)</td>
          </tr>
        </tbody>
      </table>

      <div className="callout callout-warning">
        <strong>Never use these credentials in production.</strong> They are
        seeded for local dev only. Production deployments must rotate all
        secrets.
      </div>

      {/* ── Service ports ── */}
      <h2 id="ports">Service ports</h2>
      <table>
        <thead>
          <tr><th>Service</th><th>Port</th><th>Protocol</th></tr>
        </thead>
        <tbody>
          <tr><td>control-plane (HTTP)</td><td><code>:8080</code></td><td>HTTP — REST + health + SSE</td></tr>
          <tr><td>control-plane (gRPC)</td><td><code>:50051</code></td><td>gRPC</td></tr>
          <tr><td>dashboard</td><td><code>:3001</code></td><td>HTTP (Next.js / Turbopack)</td></tr>
          <tr><td>workflow-engine</td><td><code>:50052</code></td><td>gRPC</td></tr>
          <tr><td>model-router</td><td><code>:50053</code></td><td>gRPC</td></tr>
          <tr><td>runtime-manager</td><td><code>:50054</code></td><td>gRPC</td></tr>
          <tr><td>runtime-scheduler</td><td><code>:50055</code> / <code>:8085</code></td><td>gRPC / REST</td></tr>
          <tr><td>gateway</td><td><code>:8443</code></td><td>HTTPS (TLS)</td></tr>
          <tr><td>surface-gateway</td><td><code>:8444</code></td><td>HTTP (webhooks)</td></tr>
          <tr><td>PostgreSQL</td><td><code>:5432</code></td><td>postgres</td></tr>
          <tr><td>Redis</td><td><code>:6379</code></td><td>redis</td></tr>
          <tr><td>MinIO S3</td><td><code>:9000</code></td><td>S3-compatible HTTP</td></tr>
          <tr><td>MinIO console</td><td><code>:9001</code></td><td>HTTP (browser console)</td></tr>
        </tbody>
      </table>

      {/* ── Make targets ── */}
      <h2 id="make-targets">Make targets (power users)</h2>
      <p>
        The four-terminal approach gives you faster feedback when iterating on a
        single service. All targets set the correct environment variables — never
        bypass them.
      </p>
      <table>
        <thead>
          <tr><th>Target</th><th>What it does</th></tr>
        </thead>
        <tbody>
          <tr><td><code>make dev</code></td><td>Full docker-compose stack (all services containerized)</td></tr>
          <tr><td><code>make dev-infra</code></td><td>Postgres + Redis + MinIO only (recommended for day-to-day)</td></tr>
          <tr><td><code>make dev-doctor</code></td><td>Health-check every service and infra container</td></tr>
          <tr><td><code>make run-api</code></td><td>Control-plane on <code>:8080</code> (host process, dev env vars)</td></tr>
          <tr><td><code>make dashboard-dev</code></td><td>Next.js dashboard on <code>:3001</code> with Turbopack</td></tr>
          <tr><td><code>make run-whatsapp-bridge</code></td><td>WhatsApp bridge on <code>:3100</code></td></tr>
          <tr><td><code>make run-scheduler</code></td><td>Runtime scheduler on <code>:50055</code> / <code>:8085</code></td></tr>
          <tr><td><code>make run-runtime-manager</code></td><td>Rust runtime-manager on <code>:50054</code> (Docker backend)</td></tr>
          <tr><td><code>make build</code></td><td>Compile Go + Rust + TypeScript</td></tr>
          <tr><td><code>make test</code></td><td>All test suites</td></tr>
          <tr><td><code>make lint</code></td><td>All linters</td></tr>
          <tr><td><code>make ci-local</code></td><td>Lint + test + audit (same matrix as CI)</td></tr>
          <tr><td><code>make proto</code></td><td>Regenerate from <code>.proto</code> definitions</td></tr>
          <tr><td><code>make clean</code></td><td>Remove artifacts + docker volumes</td></tr>
          <tr><td><code>make seed</code></td><td>Seed sample data into running services</td></tr>
        </tbody>
      </table>

      {/* ── Next steps ── */}
      <h2 id="next">Next steps</h2>
      <ul>
        <li>
          <Link href="/quickstart"><strong>Quickstart</strong></Link> — create your
          first agent and run it end-to-end in 5 minutes
        </li>
        <li>
          <Link href="/agents">Agent configuration</Link> — instructions, prompts,
          connectors, visual editor
        </li>
        <li>
          <Link href="/deployment">Deployment</Link> — move to production with Helm or
          Terraform
        </li>
      </ul>
    </>
  );
}
