export default function QuickStartPage() {
  return (
    <>
      <h1>Quick Start</h1>
      <p>Get Lantern running locally and create your first agent in 5 minutes.</p>

      {/* Table of contents */}
      <div className="toc">
        <p className="toc-title">On this page</p>
        <ul>
          <li><a href="#prerequisites">Prerequisites</a></li>
          <li><a href="#clone">1. Clone the repository</a></li>
          <li><a href="#infra">2. Start infrastructure</a></li>
          <li><a href="#api">3. Start the API server</a></li>
          <li><a href="#dashboard">4. Start the dashboard</a></li>
          <li><a href="#signup">5. Create your account</a></li>
          <li><a href="#llm">6. Add an LLM provider</a></li>
          <li><a href="#agent">7. Create your first agent</a></li>
          <li><a href="#next">What&apos;s next</a></li>
        </ul>
      </div>

      <h2 id="prerequisites">Prerequisites</h2>
      <table>
        <thead>
          <tr><th>Tool</th><th>Version</th><th>Install</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Docker Desktop</strong></td><td>v4.x+</td><td><code>brew install --cask docker</code></td></tr>
          <tr><td><strong>Node.js</strong></td><td>v20+</td><td><code>brew install node</code></td></tr>
          <tr><td><strong>Go</strong></td><td>v1.22+</td><td><code>brew install go</code></td></tr>
          <tr><td><strong>Git</strong></td><td>any</td><td><code>brew install git</code></td></tr>
        </tbody>
      </table>

      <h2 id="clone">1. Clone the repository</h2>
      <pre><code>{`git clone https://github.com/dshakes/lantern.git
cd lantern`}</code></pre>

      <h2 id="infra">2. Start infrastructure</h2>
      <p>This starts PostgreSQL (with pgvector), Redis, and MinIO in Docker containers.</p>
      <pre><code>{`make dev-infra`}</code></pre>
      <p>Wait until all containers report healthy (about 10 seconds). You&apos;ll see:</p>
      <pre><code>{`✔ Container docker-postgres-1    Healthy
✔ Container docker-redis-1       Started
✔ Container docker-minio-1       Healthy`}</code></pre>

      <h2 id="api">3. Start the API server</h2>
      <p>In a <strong>new terminal</strong>, start the control plane:</p>
      <pre><code>{`make run-api`}</code></pre>
      <p>This connects to Docker Postgres/Redis with the correct credentials and starts the HTTP API on <code>:8080</code> and gRPC on <code>:50051</code>.</p>
      <div className="callout callout-info">
        <strong>Note:</strong> Don&apos;t run <code>go run ./cmd/server</code> directly — it defaults to your OS username for Postgres auth. Always use <code>make run-api</code>.
      </div>

      <h2 id="dashboard">4. Start the dashboard</h2>
      <p>In a <strong>third terminal</strong>:</p>
      <pre><code>{`cd apps/web && npm install && npm run dev`}</code></pre>
      <p>Or use the shortcut:</p>
      <pre><code>{`make dashboard-dev`}</code></pre>
      <p>The dashboard opens at <a href="http://localhost:3001" target="_blank" rel="noopener noreferrer">localhost:3001</a>.</p>

      <h2 id="signup">5. Create your account</h2>
      <p>Open the dashboard and sign up with email and password. Or use the pre-seeded dev credentials:</p>
      <table>
        <thead>
          <tr><th>Field</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td>Email</td><td><code>admin@lantern.dev</code></td></tr>
          <tr><td>Password</td><td><code>lantern</code></td></tr>
        </tbody>
      </table>

      <h2 id="llm">6. Add an LLM provider</h2>
      <p>Go to <strong>Settings → LLM Providers</strong> and add at least one API key:</p>
      <ul>
        <li><strong>Anthropic</strong> — get a key at <a href="https://console.anthropic.com" target="_blank" rel="noopener noreferrer">console.anthropic.com</a></li>
        <li><strong>OpenAI</strong> — get a key at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">platform.openai.com</a></li>
      </ul>
      <p>Click <strong>Test Connection</strong> to verify, then <strong>Save</strong>.</p>

      <h2 id="agent">7. Create your first agent</h2>
      <ol>
        <li>Go to <strong>Agents</strong> → <strong>Create Agent</strong></li>
        <li>Choose <strong>AI Assisted</strong></li>
        <li>Describe your agent: <em>&quot;An agent that summarizes my daily emails and highlights urgent items&quot;</em></li>
        <li>Click <strong>Generate Agent</strong> — AI fills in the name, instructions, and system prompt</li>
        <li>Review the configuration, adjust if needed</li>
        <li>Click <strong>Create Agent</strong></li>
        <li>Go to the <strong>Build</strong> tab → type a test message → click <strong>Run</strong></li>
      </ol>

      <div className="callout callout-tip">
        <strong>Tip:</strong> For email agents, connect Gmail first (Connectors → Gmail) so the agent can fetch your real emails.
      </div>

      <h2 id="next">What&apos;s next</h2>
      <ul>
        <li><a href="/agents">Learn about agent configuration</a> — instructions, prompts, connectors</li>
        <li><a href="/connectors">Set up connectors</a> — Gmail, Slack, GitHub, and more</li>
        <li><a href="/scheduling">Schedule your agent</a> — run on a cron with email delivery</li>
        <li><a href="/models">Configure models</a> — choose between Claude, GPT-4o, and Gemini</li>
        <li><a href="/security">Security &amp; privacy</a> — guardrails, encryption, audit logging</li>
      </ul>
    </>
  );
}
