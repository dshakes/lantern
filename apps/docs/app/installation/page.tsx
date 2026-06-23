import Link from "next/link";

export default function InstallationPage() {
  return (
    <>
      <h1>Installation</h1>
      <p>
        Clone, start the stack, verify it&apos;s healthy — under two minutes.
      </p>

      <div className="steps">

        <div className="step">
          <h3>Prerequisites</h3>
          <table>
            <thead>
              <tr><th>Tool</th><th>Min version</th><th>Homebrew</th></tr>
            </thead>
            <tbody>
              <tr><td><strong>Docker Desktop</strong></td><td>v4.x+</td><td><code>brew install --cask docker</code></td></tr>
              <tr><td><strong>Node.js</strong></td><td>v20+</td><td><code>brew install node</code></td></tr>
              <tr><td><strong>Go</strong></td><td>v1.23+</td><td><code>brew install go</code></td></tr>
              <tr><td><strong>Git</strong></td><td>any</td><td><code>brew install git</code></td></tr>
            </tbody>
          </table>
          <div className="callout callout-info">
            <strong>Docker must be running</strong> before you start. Postgres, Redis, and MinIO run in Docker containers.
          </div>
        </div>

        <div className="step">
          <h3>Clone the repo</h3>
          <pre><code>{`git clone https://github.com/dshakes/lantern.git
cd lantern`}</code></pre>
        </div>

        <div className="step">
          <h3>Start the stack</h3>
          <p>One command boots everything:</p>
          <pre><code>{`lantern dev`}</code></pre>
          <p>Or run services individually for faster iteration:</p>
          <pre><code>{`# Terminal 1 — Postgres, Redis, MinIO
make dev-infra

# Terminal 2 — control-plane API on :8080
make run-api

# Terminal 3 — Next.js dashboard on :3001
make dashboard-dev`}</code></pre>
          <div className="callout callout-warning">
            <strong>Never run <code>go run ./cmd/server</code> directly.</strong> It uses OS-user Postgres auth and will fail. Always use <code>make run-api</code> — it injects <code>DATABASE_URL</code>, <code>REDIS_URL</code>, and <code>S3_ENDPOINT</code>.
          </div>
        </div>

        <div className="step">
          <h3>Verify</h3>
          <pre><code>{`curl -s http://localhost:8080/healthz
# → {"status":"ok"}

make dev-doctor   # probes every service and reports status`}</code></pre>
        </div>

      </div>

      <h2 id="credentials">Dev credentials</h2>
      <p>Seeded automatically on first boot. No setup required.</p>
      <table>
        <thead><tr><th>Service</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>PostgreSQL</td><td><code>postgres://lantern:lantern@localhost:5432/lantern?sslmode=disable</code></td></tr>
          <tr><td>Redis</td><td><code>redis://localhost:6379</code></td></tr>
          <tr><td>MinIO</td><td><code>http://localhost:9000</code> · console <code>:9001</code> · creds <code>lantern / lanternsecret</code></td></tr>
          <tr><td>Dashboard</td><td><code>admin@lantern.dev</code> / <code>lantern</code> at <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer">localhost:3001</a></td></tr>
          <tr><td>JWT secret</td><td><code>lantern-dev-jwt-secret-do-not-use-in-production</code></td></tr>
          <tr><td>Dev tenant ID</td><td><code>00000000-0000-0000-0000-000000000001</code> (slug: <code>dev</code>)</td></tr>
          <tr><td>Dev user ID</td><td><code>00000000-0000-0000-0000-000000000002</code> (role: <code>owner</code>)</td></tr>
        </tbody>
      </table>
      <div className="callout callout-warning">
        <strong>Never use these credentials in production.</strong> Rotate all secrets before any production deployment.
      </div>

      <h2 id="ports">Service ports</h2>
      <table>
        <thead><tr><th>Service</th><th>Port</th><th>Protocol</th></tr></thead>
        <tbody>
          <tr><td>control-plane (HTTP)</td><td><code>:8080</code></td><td>REST + health + SSE</td></tr>
          <tr><td>control-plane (gRPC)</td><td><code>:50051</code></td><td>gRPC</td></tr>
          <tr><td>dashboard</td><td><code>:3001</code></td><td>Next.js / Turbopack</td></tr>
          <tr><td>workflow-engine</td><td><code>:50052</code></td><td>gRPC</td></tr>
          <tr><td>model-router</td><td><code>:50053</code></td><td>gRPC</td></tr>
          <tr><td>runtime-manager</td><td><code>:50054</code></td><td>gRPC</td></tr>
          <tr><td>runtime-scheduler</td><td><code>:50055</code> / <code>:8085</code></td><td>gRPC / REST</td></tr>
          <tr><td>gateway</td><td><code>:8443</code></td><td>HTTPS</td></tr>
          <tr><td>surface-gateway</td><td><code>:8444</code></td><td>HTTP webhooks</td></tr>
          <tr><td>PostgreSQL</td><td><code>:5432</code></td><td>postgres</td></tr>
          <tr><td>Redis</td><td><code>:6379</code></td><td>redis</td></tr>
          <tr><td>MinIO S3</td><td><code>:9000</code></td><td>S3-compatible</td></tr>
          <tr><td>MinIO console</td><td><code>:9001</code></td><td>HTTP browser</td></tr>
        </tbody>
      </table>

      <h2 id="make-targets">Make targets</h2>
      <table>
        <thead><tr><th>Target</th><th>What it does</th></tr></thead>
        <tbody>
          <tr><td><code>make dev</code></td><td>Full docker-compose stack</td></tr>
          <tr><td><code>make dev-infra</code></td><td>Postgres + Redis + MinIO only (daily driver)</td></tr>
          <tr><td><code>make dev-doctor</code></td><td>Health-check every service</td></tr>
          <tr><td><code>make run-api</code></td><td>Control-plane on <code>:8080</code></td></tr>
          <tr><td><code>make dashboard-dev</code></td><td>Next.js dashboard on <code>:3001</code></td></tr>
          <tr><td><code>make run-whatsapp-bridge</code></td><td>WhatsApp bridge on <code>:3100</code></td></tr>
          <tr><td><code>make build</code></td><td>Compile Go + Rust + TypeScript</td></tr>
          <tr><td><code>make test</code></td><td>All test suites</td></tr>
          <tr><td><code>make lint</code></td><td>All linters</td></tr>
          <tr><td><code>make ci-local</code></td><td>Lint + test + audit (same as CI)</td></tr>
          <tr><td><code>make proto</code></td><td>Regenerate from <code>.proto</code> definitions</td></tr>
          <tr><td><code>make clean</code></td><td>Remove artifacts + docker volumes</td></tr>
        </tbody>
      </table>

      <h2 id="next">Next steps</h2>
      <div className="card-grid">
        <Link href="/quickstart" className="card">
          <div className="card-title">Quickstart</div>
          <div className="card-desc">Create your first agent and run it end-to-end.</div>
        </Link>
        <Link href="/agents" className="card">
          <div className="card-title">Agents</div>
          <div className="card-desc">Instructions, tools, visual editor.</div>
        </Link>
        <Link href="/deployment" className="card">
          <div className="card-title">Deployment</div>
          <div className="card-desc">Production with Helm, Terraform, or Lantern Cloud.</div>
        </Link>
      </div>
    </>
  );
}
