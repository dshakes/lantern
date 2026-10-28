import Link from "next/link";
import { pageMeta } from "../_meta";

export const metadata = pageMeta("/env-vars");

// Generated from the code on origin/master (os.Getenv / std::env::var / process.env reads). Do not hand-edit a
// default without re-checking the source file named in the page's "How this list was built" note.
export default function EnvVarsPage() {
  return (
    <>
      <h1>Environment variables</h1>
      <p>
        Every environment variable the control plane, schedulers, runtime manager, in-VM harness and dashboard read, grouped by
        service, with its default and what it does. <strong>Required in prod</strong> means the process refuses to start
        (or, for the harness, refuses to run the workload) when <code>LANTERN_ENV</code> is <code>prod</code>,{" "}
        <code>production</code> or <code>staging</code> and the value is missing. Flag values accept <code>1</code>,{" "}
        <code>true</code> or <code>on</code> unless a row says otherwise.
      </p>

      <h2 id="how">How to use this page</h2>
      <p>
        Local development needs none of these: <code>make run-api</code> sets the database, Redis and S3 values, and every
        security variable has a dev default or is skipped with a warning. For production, start from the{" "}
        <a href="#prod-checklist">checklist below</a>, then see <Link href="/operations">Operations</Link> for how the Helm
        chart supplies them. A production process that is missing a required value logs it by name and exits at startup.
      </p>

      <h2 id="prod-checklist">Production checklist</h2>
      <table>
        <thead><tr><th>Service</th><th>Must be set</th></tr></thead>
        <tbody>
          <tr><td>Control plane</td><td><code>JWT_SECRET</code>, <code>LANTERN_RECEIPT_SECRET</code>, <code>LANTERN_CREDENTIAL_KEY</code>, <code>LANTERN_GRPC_SERVICE_TOKEN</code>, <code>LANTERN_RLS_ENFORCE=1</code> with <code>LANTERN_APP_DB_PASSWORD</code>, <code>LANTERN_CONTROL_PLANE_TLS_CERT</code>/<code>_KEY</code>, <code>LANTERN_SCHEDULER_GRPC_ADDR</code>, <code>LANTERN_RUNTIME_MANAGER_TLS_CA</code>/<code>_CERT</code>/<code>_KEY</code></td></tr>
          <tr><td>Runtime scheduler</td><td><code>LANTERN_GRPC_SERVICE_TOKEN</code>, <code>SCHEDULER_NODE_TOKEN</code>, <code>LANTERN_DEFAULT_MANAGER_ADDR</code>, manager TLS CA and client cert</td></tr>
          <tr><td>Runtime manager</td><td><code>LANTERN_GRPC_SERVICE_TOKEN</code>, <code>LANTERN_MANAGER_TLS_CA</code>/<code>_CERT</code>/<code>_KEY</code></td></tr>
          <tr><td>Harness</td><td><code>LANTERN_WORKLOAD_UID</code>, <code>LANTERN_HARNESS_EXEC_TOKEN</code></td></tr>
        </tbody>
      </table>
      <p>
        The control plane also refuses to start in prod with <code>LANTERN_TWILIO_WEBHOOK_AUTH=off</code> or{" "}
        <code>LANTERN_USE_CLAUDE_CODE=1</code>, and the scheduler refuses <code>LANTERN_DIALER=stub</code>.
      </p>

      <h2 id="cp-core">Control plane: listeners, stores, process</h2>
      <p>Binary: <code>services/control-plane/cmd/server</code>. HTTP REST is on <code>:8080</code>, gRPC on <code>:50051</code>.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>HTTP_ADDR</code></td><td><code>:8080</code></td><td>REST listen address.</td></tr>
          <tr><td><code>LISTEN_ADDR</code></td><td><code>:50051</code></td><td>gRPC listen address (the tenant-trust boundary).</td></tr>
          <tr><td><code>LANTERN_METRICS_ADDR</code></td><td><code>:9464</code></td><td>Separate Prometheus <code>/metrics</code> listener. Unauthenticated and labelled with agent names, so scrape it from Prometheus only, never through ingress.</td></tr>
          <tr><td><code>LOG_LEVEL</code></td><td><code>info</code></td><td>Log level.</td></tr>
          <tr><td><code>LANTERN_DRAIN_TIMEOUT</code></td><td><code>30s</code></td><td>Graceful-shutdown drain window (Go duration).</td></tr>
          <tr><td><code>LANTERN_ENV</code></td><td>unset (dev)</td><td><code>prod</code>, <code>production</code> or <code>staging</code> turns on every production startup guard in this table. The Helm chart defaults it to <code>production</code>.</td></tr>
          <tr><td><code>DATABASE_URL</code></td><td><code>postgres://localhost:5432/lantern?sslmode=disable</code></td><td>Postgres DSN (pgvector image). Also read by <code>cmd/migrate</code> and the cron scheduler.</td></tr>
          <tr><td><code>REDIS_URL</code></td><td><code>redis://localhost:6379/0</code></td><td>Redis for rate limits, pub/sub and queues.</td></tr>
          <tr><td><code>LANTERN_PG_MAX_CONNS</code></td><td><code>20</code></td><td>Postgres pool size.</td></tr>
          <tr><td><code>LANTERN_PG_MAX_CONN_LIFETIME</code></td><td><code>1h</code></td><td>Max connection lifetime.</td></tr>
          <tr><td><code>LANTERN_PG_MAX_CONN_IDLE_TIME</code></td><td><code>30m</code></td><td>Max connection idle time.</td></tr>
          <tr><td><code>LANTERN_REDIS_POOL_SIZE</code></td><td><code>20</code></td><td>Redis pool size.</td></tr>
          <tr><td><code>S3_ENDPOINT</code></td><td>unset</td><td>S3-compatible endpoint for agent bundles and attachments.</td></tr>
          <tr><td><code>S3_BUCKET</code></td><td><code>lantern-bundles-dev</code></td><td>Bucket name.</td></tr>
          <tr><td><code>S3_REGION</code></td><td>unset</td><td>Signing region.</td></tr>
          <tr><td><code>S3_ACCESS_KEY</code></td><td>falls back to <code>AWS_ACCESS_KEY_ID</code>, then <code>lantern</code></td><td>Object-store access key.</td></tr>
          <tr><td><code>S3_SECRET</code></td><td>falls back to <code>AWS_SECRET_ACCESS_KEY</code>, then <code>lanternsecret</code></td><td>Object-store secret. Set real values outside dev.</td></tr>
          <tr><td><code>SEED_DEV</code></td><td>unset</td><td><code>1</code>/<code>true</code>: <code>cmd/migrate</code> seeds the dev tenant and admin user.</td></tr>
        </tbody>
      </table>
      <h2 id="cp-security">Control plane: auth, secrets, trust boundaries</h2>
      <p>These are the production-required ones. With <code>LANTERN_ENV=production</code> the control plane refuses to start when a required value is missing.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>JWT_SECRET</code></td><td>dev default (public)</td><td>Signs dashboard JWTs. Unset or the dev default is fatal in prod. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RECEIPT_SECRET</code></td><td>dev default</td><td>HMAC secret for run receipts and marketplace invocation signatures. Fatal in prod when unset. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RECEIPT_ED25519_SEED</code></td><td>unset</td><td>Seed for the Ed25519 receipt key. Unset: receipts fall back to HMAC and cannot be verified offline by third parties.</td></tr>
          <tr><td><code>LANTERN_CREDENTIAL_KEY</code></td><td>unset (plaintext in dev)</td><td>32-byte AES-256-GCM key that encrypts provider keys and connector tokens at rest. Fatal in prod when unset or malformed. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_GRPC_SERVICE_TOKEN</code></td><td>unset</td><td>Shared service token for the gRPC trust boundaries. Set the same value on the control plane, gateway, workflow engine, runtime scheduler, model router and runtime manager. Fatal in prod when unset; dev warns and allows unauthenticated calls. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_CONTROL_PLANE_TLS_CERT</code></td><td>unset</td><td>PEM path for the gRPC server certificate. Both cert and key, or neither; one alone is always fatal. Prod requires them. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_CONTROL_PLANE_TLS_KEY</code></td><td>unset</td><td>PEM path for the matching key. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RLS_ENFORCE</code></td><td>unset (off)</td><td><code>1</code> enforces Postgres row-level security through the <code>lantern_app</code> pool. Prod refuses to start without it. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_APP_DB_PASSWORD</code></td><td>unset</td><td>Password of the non-superuser <code>lantern_app</code> role used when RLS is enforced. Prod refuses to start without it. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_AUTHZ_ENFORCE</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>on</code>: a key missing the endpoint's scope gets 403. Off: the miss is logged and the request proceeds.</td></tr>
          <tr><td><code>LANTERN_CORS_ORIGINS</code></td><td><code>http://localhost:3001</code></td><td>Comma-separated allowed browser origins. Public endpoints (receipt verify, <code>/.well-known/*</code>) stay open.</td></tr>
          <tr><td><code>LANTERN_TRUSTED_PROXIES</code></td><td>empty</td><td>CIDRs whose <code>X-Forwarded-For</code> is trusted for rate-limit keys.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_SECRET_TOKEN</code></td><td>unset</td><td>Pre-shared token for the manager-to-control-plane secret relay. Unset: <code>POST /v1/runtime/secrets/resolve</code> returns 403.</td></tr>
          <tr><td><code>LANTERN_AGENT_IDENTITY_SECRET</code></td><td>unset</td><td>HMAC secret for per-instance agent identity tokens.</td></tr>
          <tr><td><code>LANTERN_AGENT_IDENTITY_ED25519_SEED</code></td><td>unset</td><td>Seed for Ed25519 agent identity tokens (preferred over the HMAC secret).</td></tr>
          <tr><td><code>LANTERN_AGENT_IDENTITY_TTL</code></td><td><code>1h</code></td><td>Identity token lifetime (Go duration).</td></tr>
          <tr><td><code>LANTERN_DL_SIGNING_SECRET</code></td><td>unset</td><td>Signing secret for short-lived document download links.</td></tr>
          <tr><td><code>LANTERN_SIGNAL_TOKEN</code></td><td>unset</td><td>Shared secret for <code>/v1/signals</code> (header <code>x-lantern-signal-token</code>). Unset: the endpoint is 401.</td></tr>
          <tr><td><code>SLACK_SIGNING_SECRET</code></td><td>unset</td><td>Verifies Slack slash commands. Unset in prod: unsigned commands are refused.</td></tr>
          <tr><td><code>LANTERN_TWILIO_WEBHOOK_AUTH</code></td><td>on</td><td><code>off</code> skips Twilio signature checks. Fatal in prod.</td></tr>
          <tr><td><code>LANTERN_USE_CLAUDE_CODE</code></td><td>unset</td><td><code>1</code> routes through a local <code>claude</code> binary. Fatal in prod.</td></tr>
          <tr><td><code>LANTERN_CLAUDE_BINARY</code></td><td>found on PATH</td><td>Explicit path to that binary.</td></tr>
        </tbody>
      </table>
      <h2 id="cp-signup">Control plane: sign-up, mail, OAuth</h2>
      <p>Behaviour and rationale are on <Link href="/accounts">Accounts &amp; sign-up</Link>.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LANTERN_SIGNUP_MODE</code></td><td><code>closed</code> in prod, <code>open</code> in dev</td><td><code>open</code>, <code>invite</code> or <code>closed</code>. Any other value stops startup.</td></tr>
          <tr><td><code>LANTERN_SIGNUP_INVITE_SECRET</code></td><td>unset</td><td>HMAC key for invite codes. Required for <code>invite</code> mode.</td></tr>
          <tr><td><code>LANTERN_TURNSTILE_SECRET</code></td><td>unset</td><td>Cloudflare Turnstile secret. Setting it requires a captcha on every sign-up.</td></tr>
          <tr><td><code>LANTERN_MAILER</code></td><td><code>log</code></td><td><code>log</code>, <code>smtp</code> or <code>http</code>.</td></tr>
          <tr><td><code>LANTERN_MAIL_FROM</code></td><td><code>Lantern &lt;no-reply@localhost&gt;</code></td><td>From address for <code>smtp</code> and <code>http</code>.</td></tr>
          <tr><td><code>LANTERN_SMTP_ADDR</code></td><td>unset</td><td><code>host:port</code>; required for <code>smtp</code>.</td></tr>
          <tr><td><code>LANTERN_SMTP_USER</code></td><td>unset</td><td>SMTP user (PLAIN auth).</td></tr>
          <tr><td><code>LANTERN_SMTP_PASSWORD</code></td><td>unset</td><td>SMTP password.</td></tr>
          <tr><td><code>LANTERN_MAIL_HTTP_URL</code></td><td>unset</td><td>Endpoint for the <code>http</code> driver.</td></tr>
          <tr><td><code>LANTERN_MAIL_HTTP_TOKEN</code></td><td>unset</td><td>Bearer token for the <code>http</code> driver.</td></tr>
          <tr><td><code>OAUTH_DASHBOARD_URL</code></td><td><code>http://localhost:3001</code></td><td>Dashboard base URL used in emailed verify/reset links and OAuth redirects.</td></tr>
          <tr><td><code>OAUTH_REDIRECT_BASE</code></td><td><code>http://localhost:8080</code></td><td>Base URL for the Google sign-in redirect URI. Set it to the public API URL.</td></tr>
          <tr><td><code>OAUTH_BASE_URL</code></td><td><code>http://localhost:8080</code></td><td>Public base URL for connector OAuth redirect URIs.</td></tr>
          <tr><td><code>GOOGLE_CLIENT_ID</code></td><td>unset</td><td>Enables &quot;Sign in with Google&quot; (with the secret).</td></tr>
          <tr><td><code>GOOGLE_CLIENT_SECRET</code></td><td>unset</td><td>Google OAuth client secret.</td></tr>
          <tr><td><code>OAUTH_CLIENT_ID_&lt;CONNECTOR&gt;</code></td><td>unset</td><td>Per-connector OAuth client id; connector id upper-cased, <code>-</code> as <code>_</code> (for example <code>OAUTH_CLIENT_ID_GITHUB</code>).</td></tr>
          <tr><td><code>OAUTH_CLIENT_SECRET_&lt;CONNECTOR&gt;</code></td><td>unset</td><td>The matching client secret.</td></tr>
        </tbody>
      </table>
      <h2 id="cp-runtime">Control plane: runtime, recovery, limits</h2>
      <p>How the control plane reaches the scheduler and manager, plus the loops and caps it runs.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LANTERN_SCHEDULER_GRPC_ADDR</code></td><td>unset (stub scheduler)</td><td>Runtime scheduler, for example <code>localhost:50055</code>. Unset uses a stub that fabricates VM ids and spawns nothing, so prod refuses to start. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_ADDR</code></td><td>unset</td><td>Runtime manager, for exec, pause and fork calls. Unset: those routes are unavailable.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_CA</code></td><td>unset</td><td>CA used to verify the manager. Prod requires mTLS to the manager; dev allows plaintext. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_CERT</code></td><td>unset</td><td>Client certificate (both cert and key, or neither). Prod requires it. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_KEY</code></td><td>unset</td><td>Client key. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_DEFAULT_MANAGER_ADDR</code></td><td>unset</td><td>Manager address for the log-stream proxy and the health sweep.</td></tr>
          <tr><td><code>LANTERN_MODEL_ROUTER_ADDR</code></td><td>unset</td><td>Model router address; also a health-sweep target.</td></tr>
          <tr><td><code>LANTERN_WORKFLOW_ENGINE_ADDR</code></td><td>unset</td><td>Workflow engine address, a health-sweep target.</td></tr>
          <tr><td><code>LANTERN_HEALTH_SWEEP_INTERVAL</code></td><td><code>60s</code></td><td>Peer-service health sweep period. <code>0</code> or <code>off</code> disables it.</td></tr>
          <tr><td><code>LANTERN_NODE_ADDR_&lt;NODE&gt;</code></td><td>unset</td><td>Explicit <code>host:port</code> for a named scheduler node whose address is not resolvable by DNS (node name upper-cased, <code>.</code> and <code>-</code> as <code>_</code>).</td></tr>
          <tr><td><code>LANTERN_RECOVERY_INTERVAL</code></td><td><code>30s</code></td><td>Crash-recovery sweep period.</td></tr>
          <tr><td><code>LANTERN_RUN_LEASE_TTL</code></td><td><code>60s</code></td><td>Run lease length; renewed every third of it while a run executes.</td></tr>
          <tr><td><code>LANTERN_MAX_FORK_COUNT</code></td><td><code>100 (ceiling 1000)</code></td><td>Per-call cap on <code>POST /v1/runtime/vms/&#123;id&#125;/fork</code>.</td></tr>
          <tr><td><code>LANTERN_SESSION_VM_IDLE_TTL</code></td><td><code>30m</code></td><td>Idle time before a session's sandbox VM is reaped.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_TERMINAL_GRACE</code></td><td><code>10m</code></td><td>How long after a VM turns terminal the control plane still accepts its late log and audit reports. <code>0</code> disables the window.</td></tr>
          <tr><td><code>LANTERN_SPAWN_RATE_PER_MIN</code></td><td><code>120</code></td><td>Per-tenant VM spawn rate limit.</td></tr>
          <tr><td><code>LANTERN_SPAWN_BURST</code></td><td><code>20</code></td><td>Per-tenant spawn burst.</td></tr>
          <tr><td><code>LANTERN_HOOK_RATE_PER_MIN</code></td><td><code>60</code></td><td>Per-trigger rate limit on <code>POST /v1/hooks/&#123;id&#125;</code>.</td></tr>
          <tr><td><code>LANTERN_HOOK_BURST</code></td><td><code>10</code></td><td>Per-trigger burst.</td></tr>
          <tr><td><code>LANTERN_DP_MAX_STREAMS_PER_TENANT</code></td><td><code>10</code></td><td>Concurrent data-plane run streams per tenant.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_LOG_RETENTION_DAYS</code></td><td><code>14</code></td><td>Retention for <code>runtime_vm_logs</code>.</td></tr>
          <tr><td><code>LANTERN_JOURNAL_RETENTION_DAYS</code></td><td><code>90</code></td><td>Retention for <code>journal_events</code>.</td></tr>
          <tr><td><code>LANTERN_AUDIT_RETENTION_DAYS</code></td><td><code>365</code></td><td>Retention for audit events.</td></tr>
          <tr><td><code>LANTERN_USAGE_DAILY_RETENTION_DAYS</code></td><td><code>400</code></td><td>Retention for <code>agent_usage_daily</code>.</td></tr>
          <tr><td><code>LANTERN_SIDE_EFFECT_RETENTION_DAYS</code></td><td><code>30</code></td><td>Retention for <code>side_effect_receipts</code>.</td></tr>
          <tr><td><code>LANTERN_DEFAULT_TIMEZONE</code></td><td>UTC</td><td>IANA zone for cron matching and the budget day boundary when a schedule sets none.</td></tr>
        </tbody>
      </table>
      <h2 id="cp-models">Control plane: models, knowledge, flags</h2>
      <p>Flags marked <em>on</em> are on unless set to a disabling value.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>OPENAI_API_KEY</code></td><td>unset</td><td>Platform-level fallback provider key, used when a tenant has none configured.</td></tr>
          <tr><td><code>ANTHROPIC_API_KEY</code></td><td>unset</td><td>Same, for Anthropic.</td></tr>
          <tr><td><code>LANTERN_USE_MODEL_ROUTER</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>on</code> sends plain completions through the model router; any router error falls back to the direct provider.</td></tr>
          <tr><td><code>LANTERN_ROUTE_STRATEGY</code></td><td><code>balanced</code></td><td><code>balanced</code>, <code>cheap</code>, <code>quality</code> or <code>fast</code> for <code>model: auto</code>.</td></tr>
          <tr><td><code>LANTERN_LLM_MAX_TURNS</code></td><td><code>12 (cap 40)</code></td><td>Tool-loop turn limit per completion.</td></tr>
          <tr><td><code>LANTERN_HAIKU_MODEL</code></td><td><code>claude-haiku-4-5-20251001</code></td><td>Concrete model behind the small tier.</td></tr>
          <tr><td><code>LANTERN_SONNET_MODEL</code></td><td><code>claude-sonnet-4-6</code></td><td>Concrete model behind the mid tier.</td></tr>
          <tr><td><code>LANTERN_OPUS_MODEL</code></td><td><code>claude-opus-4-8</code></td><td>Concrete model behind the large tier.</td></tr>
          <tr><td><code>LANTERN_WEBSEARCH_MODEL</code></td><td><code>claude-sonnet-4-6</code></td><td>Anthropic model for the built-in <code>web_search</code> tool.</td></tr>
          <tr><td><code>LANTERN_WEBSEARCH_OPENAI_MODEL</code></td><td><code>gpt-4o-mini-search-preview</code></td><td>OpenAI fallback model for <code>web_search</code>.</td></tr>
          <tr><td><code>LANTERN_EMBED_MODEL</code></td><td><code>text-embedding-3-small</code></td><td>Embedding model for knowledge and memory.</td></tr>
          <tr><td><code>LANTERN_EMBED_CONCURRENCY</code></td><td><code>4 (1 to 32)</code></td><td>Parallel embedding calls.</td></tr>
          <tr><td><code>LANTERN_KB_MIN_SCORE</code></td><td><code>0.2</code></td><td>Cosine floor for a knowledge-base vector hit; below it the full-text fallback runs.</td></tr>
          <tr><td><code>LANTERN_LLM_BASEURL_OPENAI</code></td><td>unset</td><td>Points OpenAI calls at a fixture or proxy base URL (used by demo mode and the replay server).</td></tr>
          <tr><td><code>LANTERN_LLM_BASEURL_ANTHROPIC</code></td><td>unset</td><td>Same, for Anthropic.</td></tr>
          <tr><td><code>LANTERN_CONNECTOR_BASEURL_&lt;NAME&gt;</code></td><td>unset</td><td>Overrides a connector's API host, for example <code>LANTERN_CONNECTOR_BASEURL_GITHUB</code>; used by the recorded-server example tests.</td></tr>
          <tr><td><code>LANTERN_COMPLEXITY_ROUTING</code></td><td>on</td><td>Complexity-based model routing. <code>0</code>/<code>off</code>/<code>false</code> disables.</td></tr>
          <tr><td><code>LANTERN_MULTI_STEP_PLANNER</code></td><td>on</td><td>Multi-step planner. <code>0</code>/<code>off</code>/<code>false</code> disables.</td></tr>
          <tr><td><code>LANTERN_CLAIM_VERIFY</code></td><td>on</td><td>Claim-verify guard on completed-action claims. <code>0</code>/<code>off</code>/<code>false</code> disables; read on every call.</td></tr>
          <tr><td><code>LANTERN_BROWSER_SKILL</code></td><td>off</td><td><code>on</code>/<code>1</code>/<code>true</code> enables browser-as-skill.</td></tr>
          <tr><td><code>LANTERN_CROSS_APP</code></td><td>off</td><td><code>on</code>/<code>1</code>/<code>true</code> enables cross-app workflows.</td></tr>
          <tr><td><code>LANTERN_CONFIDENCE_GATE</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>on</code> diverts low-confidence tool and connector steps to approval. See <Link href="/human-in-the-loop">Human-in-the-loop</Link>.</td></tr>
          <tr><td><code>LANTERN_CONFIDENCE_GATE_THRESHOLD</code></td><td><code>0.75</code></td><td>Minimum score in [0,1] for auto-execution.</td></tr>
          <tr><td><code>LANTERN_CONFIDENCE_ESTIMATOR</code></td><td><code>verbalization</code></td><td><code>self-consistency</code> (also <code>self_consistency</code>, <code>sampling</code>) polls the model; anything else uses the heuristic.</td></tr>
          <tr><td><code>LANTERN_CONFIDENCE_SAMPLES</code></td><td><code>5 (1 to 9)</code></td><td>Independent judgments per self-consistency estimate; each is one LLM call.</td></tr>
          <tr><td><code>LANTERN_CONFIDENCE_CALIBRATE</code></td><td>off</td><td>Lowers the score by the step type's realized regret rate.</td></tr>
          <tr><td><code>LANTERN_FREE_TIER_COST_USD_PER_DAY</code></td><td><code>2.00</code></td><td>Tenant-wide LLM spend cap applied to new tenants.</td></tr>
          <tr><td><code>LANTERN_FREE_TIER_MAX_VMS</code></td><td><code>2</code></td><td>Concurrent sandbox VMs for new tenants.</td></tr>
          <tr><td><code>LANTERN_FREE_TIER_RUNTIME_COST_USD_PER_DAY</code></td><td><code>1.00</code></td><td>Sandbox spend cap for new tenants.</td></tr>
          <tr><td><code>LANTERN_KIOSK</code></td><td>off</td><td>Demo mode: anonymous throwaway workspaces. Refuses to start unless RLS and authz enforcement are on and <code>JWT_SECRET</code> is non-default.</td></tr>
          <tr><td><code>LANTERN_KIOSK_ALLOW_PROD</code></td><td>off</td><td>Required to run kiosk mode under a production-like <code>LANTERN_ENV</code>.</td></tr>
          <tr><td><code>LANTERN_KIOSK_TTL_MIN</code></td><td><code>30</code></td><td>Workspace lifetime in minutes.</td></tr>
          <tr><td><code>LANTERN_KIOSK_MAX_SESSIONS</code></td><td><code>20</code></td><td>Concurrent kiosk workspaces.</td></tr>
          <tr><td><code>LANTERN_KIOSK_IP_PER_HOUR</code></td><td><code>3</code></td><td>New workspaces per client IP per hour.</td></tr>
          <tr><td><code>LANTERN_KIOSK_SWEEP_SEC</code></td><td><code>60</code></td><td>Expiry sweep period in seconds.</td></tr>
          <tr><td><code>LANTERN_OTEL_ENABLED</code></td><td>unset</td><td><code>1</code> enables tracing (with an OTLP endpoint).</td></tr>
          <tr><td><code>OTEL_EXPORTER_OTLP_ENDPOINT</code></td><td>unset</td><td>Standard OTLP endpoint; setting it also enables tracing.</td></tr>
        </tbody>
      </table>
      <h2 id="cp-personal">Control plane: personal-assistant and bridge integration</h2>
      <p>Only relevant if you run the iMessage or WhatsApp bridges. All default to off or unset.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LANTERN_BRIDGE_URL</code></td><td>unset</td><td>WhatsApp bridge base URL.</td></tr>
          <tr><td><code>LANTERN_BRIDGE_TOKEN</code></td><td>unset</td><td>Token the WhatsApp bridge validates.</td></tr>
          <tr><td><code>LANTERN_BRIDGE_HEARTBEAT_TOKEN</code></td><td>unset</td><td>Shared token for <code>POST /v1/surfaces/whatsapp/heartbeat</code>.</td></tr>
          <tr><td><code>LANTERN_IMESSAGE_BRIDGE_URL</code></td><td>unset</td><td>iMessage bridge base URL.</td></tr>
          <tr><td><code>LANTERN_IMESSAGE_BRIDGE_TOKEN</code></td><td>unset</td><td>Token the iMessage bridge validates (a different variable from the WhatsApp one).</td></tr>
          <tr><td><code>LANTERN_PERSONAL_DOCS_BRIDGE_URL</code></td><td>unset</td><td>Overrides the bridge URL for the personal-docs tool.</td></tr>
          <tr><td><code>LANTERN_WHATSAPP_BRIDGE_URL</code></td><td>unset</td><td>WhatsApp bridge URL for the personal-docs tool.</td></tr>
          <tr><td><code>LANTERN_DEFAULT_TENANT_ID</code></td><td><code>00000000-0000-0000-0000-000000000001</code></td><td>Tenant that single-owner background jobs act for.</td></tr>
          <tr><td><code>LANTERN_OWNER_NAME</code></td><td>unset</td><td>Owner first name for briefs and calls.</td></tr>
          <tr><td><code>LANTERN_OWNER_EMAIL</code></td><td>unset</td><td>Owner email: brief fallback and memory-ingest identity.</td></tr>
          <tr><td><code>LANTERN_OWNER_PHONE</code></td><td>unset</td><td>Owner number for the morning brief by SMS.</td></tr>
          <tr><td><code>LANTERN_OWNER_VERIFY_PIN</code></td><td>unset</td><td>PIN for the owner's Twilio line; unset authorizes on caller ID alone (spoofable).</td></tr>
          <tr><td><code>LANTERN_OWNER_VERIFY_TTL</code></td><td><code>12h</code></td><td>How long a PIN verification lasts.</td></tr>
          <tr><td><code>LANTERN_TWILIO_NUMBER</code></td><td>from the Twilio connector</td><td>SMS sending number override.</td></tr>
          <tr><td><code>LANTERN_PUBLIC_BASE_URL</code></td><td>unset</td><td>Public URL override for Twilio callbacks.</td></tr>
          <tr><td><code>LANTERN_CONTROL_PLANE_URL</code></td><td>unset</td><td>Control plane's own public URL (errand callbacks); also what the manager uses for the secret relay.</td></tr>
          <tr><td><code>LANTERN_RCS_INBOUND</code></td><td>off</td><td><code>on</code> accepts inbound RCS.</td></tr>
          <tr><td><code>LANTERN_JARVIS_BRIEF_HOUR</code></td><td>unset (brief off)</td><td>Hour 0 to 23 for the morning brief push.</td></tr>
          <tr><td><code>LANTERN_JARVIS_BRIEF_CHANNEL</code></td><td>unset</td><td>Channel for the brief.</td></tr>
          <tr><td><code>LANTERN_ERRAND</code></td><td>off</td><td>Enables outbound errand calls.</td></tr>
          <tr><td><code>LANTERN_ERRAND_PUBLIC_URL</code></td><td>unset</td><td>Public URL for errand webhooks.</td></tr>
          <tr><td><code>LANTERN_MEMORY_INGEST</code></td><td>on</td><td>Background memory ingest. <code>off</code> disables.</td></tr>
          <tr><td><code>LANTERN_MEMORY_INGEST_INTERVAL</code></td><td><code>15m (min 1m)</code></td><td>Ingest period.</td></tr>
          <tr><td><code>LANTERN_MEMORY_DISTILL</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>on</code> enables LLM memory distillation.</td></tr>
          <tr><td><code>LANTERN_MEMORY_DISTILL_INTERVAL</code></td><td><code>6h (min 1m)</code></td><td>Distillation period.</td></tr>
          <tr><td><code>LANTERN_IMMIGRATION_SENTINEL</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>on</code> enables the document-deadline sentinel; off is fully inert.</td></tr>
        </tbody>
      </table>
      <h2 id="scheduler">Cron scheduler</h2>
      <p>Binary: <code>services/scheduler/cmd/server</code>.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>DATABASE_URL</code></td><td><code>postgres://localhost:5432/lantern?sslmode=disable</code></td><td>Postgres DSN.</td></tr>
          <tr><td><code>REDIS_URL</code></td><td><code>redis://localhost:6379/0</code></td><td>Redis.</td></tr>
          <tr><td><code>LISTEN_ADDR</code></td><td><code>:50058</code></td><td>gRPC listen address.</td></tr>
          <tr><td><code>LOG_LEVEL</code></td><td><code>info</code></td><td>Log level.</td></tr>
          <tr><td><code>LANTERN_GRPC_SERVICE_TOKEN</code></td><td>unset</td><td>Shared service token.</td></tr>
        </tbody>
      </table>
      <h2 id="runtime-scheduler">Runtime scheduler (placement)</h2>
      <p>Binary: <code>services/runtime-scheduler/cmd/scheduler</code>; gRPC <code>:50055</code>, REST and <code>/metrics</code> on <code>:8085</code>.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LISTEN_ADDR</code></td><td><code>:50055</code></td><td>gRPC listen address.</td></tr>
          <tr><td><code>LOG_LEVEL</code></td><td><code>info</code></td><td>Log level.</td></tr>
          <tr><td><code>DATABASE_URL</code></td><td>unset</td><td>Optional Postgres for write-through cluster state.</td></tr>
          <tr><td><code>JWT_SECRET</code></td><td>dev default</td><td>Verifies caller JWTs on the REST surface.</td></tr>
          <tr><td><code>LANTERN_ENV</code></td><td>unset (dev)</td><td>Production-like values arm the guards below.</td></tr>
          <tr><td><code>LANTERN_GRPC_SERVICE_TOKEN</code></td><td>unset</td><td>Shared service token for the gRPC port. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>SCHEDULER_NODE_TOKEN</code></td><td>unset</td><td>Token that node heartbeats must present. Fatal in prod when unset; dev warns. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_DEFAULT_MANAGER_ADDR</code></td><td>unset (log-only dialer)</td><td>Manager address for placements on <code>node-local</code>, <code>node-stub</code> or an empty node. Prod refuses to start without it. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_DIALER</code></td><td>unset</td><td><code>stub</code> forces the stub dialer. Fatal in prod.</td></tr>
          <tr><td><code>LANTERN_NODE_ADDR_&lt;NODE&gt;</code></td><td>unset</td><td>Explicit address for a named node.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_CA</code></td><td>unset</td><td>CA for dialing managers. Prod requires the CA and a client cert. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_CERT</code></td><td>unset</td><td>Client certificate. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_RUNTIME_MANAGER_TLS_KEY</code></td><td>unset</td><td>Client key. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>SCHEDULER_TENANT_MAX_VMS</code></td><td><code>20</code></td><td>Default per-tenant concurrent VM cap.</td></tr>
          <tr><td><code>SCHEDULER_WEIGHT_WARM_POOL</code></td><td><code>0.40</code></td><td>Placement score weight.</td></tr>
          <tr><td><code>SCHEDULER_WEIGHT_REGION</code></td><td><code>0.25</code></td><td>Placement score weight.</td></tr>
          <tr><td><code>SCHEDULER_WEIGHT_FAIR_SHARE</code></td><td><code>0.15</code></td><td>Placement score weight.</td></tr>
          <tr><td><code>SCHEDULER_WEIGHT_COST</code></td><td><code>0.10</code></td><td>Placement score weight.</td></tr>
          <tr><td><code>SCHEDULER_WEIGHT_HEALTH</code></td><td><code>0.10</code></td><td>Placement score weight.</td></tr>
          <tr><td><code>LANTERN_MAX_FORK_COUNT</code></td><td><code>100</code></td><td>Upper bound on one Fork call.</td></tr>
          <tr><td><code>LANTERN_FORK_CONCURRENCY</code></td><td><code>16</code></td><td>Concurrent fork spawns.</td></tr>
          <tr><td><code>LANTERN_AGENT_INSTANCE_ID</code></td><td>set by the control plane</td><td>Injected into spawned workloads, not an operator setting.</td></tr>
          <tr><td><code>LANTERN_AGENT_INSTANCE_TOKEN</code></td><td>set by the control plane</td><td>Injected into spawned workloads, not an operator setting.</td></tr>
        </tbody>
      </table>
      <h2 id="manager">Runtime manager</h2>
      <p>Binary: <code>services/runtime-manager</code> (Rust). Spawns workloads and owns the exec channel.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LISTEN_ADDR</code></td><td><code>0.0.0.0:50054</code></td><td>gRPC listen address.</td></tr>
          <tr><td><code>LOG_LEVEL</code></td><td><code>info</code></td><td>Log level.</td></tr>
          <tr><td><code>LANTERN_ENV</code></td><td>unset (dev)</td><td>Production-like values make the guards below fatal.</td></tr>
          <tr><td><code>RUNTIME_BACKEND</code></td><td><code>k8s</code></td><td>Backend: <code>k8s</code>, <code>docker</code>, <code>firecracker</code>, <code>kata</code> or <code>wasm</code>.</td></tr>
          <tr><td><code>LANTERN_GRPC_SERVICE_TOKEN</code></td><td>unset</td><td>Callers must present it as <code>x-lantern-service-token</code>. Refuses to start in prod without it; per-VM certs are always refused on manager methods. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_MANAGER_TLS_CA</code></td><td>unset</td><td>CA that harness and caller client certs must chain to. Fail-closed in prod, plaintext with a warning in dev. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_MANAGER_TLS_CERT</code></td><td>unset</td><td>Manager server certificate (PEM). <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_MANAGER_TLS_KEY</code></td><td>unset</td><td>Manager server key (PEM). <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_VM_SIGNING_CA_CERT</code></td><td>falls back to the manager CA</td><td>CA that signs per-VM certificates.</td></tr>
          <tr><td><code>LANTERN_VM_SIGNING_CA_KEY</code></td><td>falls back to the manager key</td><td>Its key.</td></tr>
          <tr><td><code>LANTERN_CONTROL_PLANE_URL</code></td><td>unset</td><td>Base URL for the secret relay and report forwarding. Set with the token below.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_SECRET_TOKEN</code></td><td>unset</td><td>Sent as <code>X-Lantern-Runtime-Token</code> to the control plane. With the URL, activates the relay resolver; otherwise a dev env resolver is used.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_RELAY_ALLOW_INSECURE</code></td><td>unset</td><td><code>1</code> allows a non-TLS relay URL (dev only).</td></tr>
          <tr><td><code>NODE_NAME</code></td><td><code>HOSTNAME</code>-derived</td><td>Node name reported to the scheduler.</td></tr>
          <tr><td><code>NODE_ADVERTISE_ADDR</code></td><td><code>LISTEN_ADDR</code> with <code>0.0.0.0</code> as <code>localhost</code></td><td>Address the scheduler dials back; set it on multi-host.</td></tr>
          <tr><td><code>NODE_REGION</code></td><td><code>local</code></td><td>Region label for placement.</td></tr>
          <tr><td><code>NODE_ZONE</code></td><td><code>local-a</code></td><td>Zone label.</td></tr>
          <tr><td><code>SCHEDULER_URL</code></td><td>unset</td><td>Runtime scheduler address for node heartbeats.</td></tr>
          <tr><td><code>SCHEDULER_TOKEN</code></td><td>unset</td><td>Heartbeat token (the scheduler's <code>SCHEDULER_NODE_TOKEN</code>).</td></tr>
          <tr><td><code>LANTERN_NODE_VCPU_MILLIS</code></td><td>detected</td><td>Override the advertised CPU capacity in millicores. Default: detected parallelism x 1000.</td></tr>
          <tr><td><code>LANTERN_NODE_MEMORY_BYTES</code></td><td>detected</td><td>Override the advertised memory in bytes. Default: detected, else 8 GiB with a warning.</td></tr>
          <tr><td><code>LANTERN_REAPER_INTERVAL_SECS</code></td><td><code>15</code></td><td>Orphan-VM reaper period (minimum 1).</td></tr>
          <tr><td><code>AGENT_IMAGE</code></td><td><code>ghcr.io/lantern/agent-runner:latest</code></td><td>Default workload image (docker, kata).</td></tr>
          <tr><td><code>DOCKER_SOCKET</code></td><td><code>/var/run/docker.sock</code></td><td>Docker socket path.</td></tr>
          <tr><td><code>BUNDLE_S3_ENDPOINT</code></td><td><code>http://localhost:9000</code></td><td>Where agent bundles are fetched from.</td></tr>
          <tr><td><code>BUNDLE_S3_BUCKET</code></td><td><code>lantern-bundles</code></td><td>Bundle bucket.</td></tr>
          <tr><td><code>SNAPSHOT_DIR</code></td><td><code>/var/lib/lantern/snapshots</code></td><td>Local snapshot store root.</td></tr>
          <tr><td><code>S3_ENDPOINT</code></td><td>unset</td><td>With <code>S3_BUCKET</code> and the AWS keys, enables the S3 snapshot tier.</td></tr>
          <tr><td><code>S3_BUCKET</code></td><td>unset</td><td>Snapshot bucket.</td></tr>
          <tr><td><code>AWS_ACCESS_KEY_ID</code></td><td>unset</td><td>Snapshot-tier credentials.</td></tr>
          <tr><td><code>AWS_SECRET_ACCESS_KEY</code></td><td>unset</td><td>Snapshot-tier credentials.</td></tr>
          <tr><td><code>FC_BINARY_PATH</code></td><td>found on PATH</td><td>Firecracker binary.</td></tr>
          <tr><td><code>FC_KERNEL_PATH</code></td><td><code>/opt/lantern/vmlinux</code></td><td>Guest kernel.</td></tr>
          <tr><td><code>FC_ROOTFS_PATH</code></td><td><code>/opt/lantern/rootfs.ext4</code></td><td>Base rootfs image.</td></tr>
          <tr><td><code>FC_BRIDGE</code></td><td>unset</td><td>Host bridge for VM taps.</td></tr>
          <tr><td><code>FIRECRACKER_JAILER_PATH</code></td><td>unset (no jailer)</td><td>Run Firecracker under this <code>jailer</code> binary.</td></tr>
          <tr><td><code>FIRECRACKER_JAILER_UID</code></td><td><code>123</code></td><td>Uid the jailer drops to.</td></tr>
          <tr><td><code>FIRECRACKER_JAILER_GID</code></td><td><code>100</code></td><td>Gid the jailer drops to.</td></tr>
          <tr><td><code>FIRECRACKER_CHROOT_BASE</code></td><td><code>/srv/jailer</code></td><td>Jailer chroot base.</td></tr>
          <tr><td><code>LANTERN_WORKLOAD_UID_DEFAULT</code></td><td><code>1000</code></td><td>Workload uid written to <code>spawn.json</code>; a caller-supplied <code>LANTERN_WORKLOAD_UID</code> is dropped.</td></tr>
          <tr><td><code>LANTERN_WORKLOAD_GID_DEFAULT</code></td><td>same as the uid</td><td>Workload gid.</td></tr>
          <tr><td><code>LANTERN_EGRESS_MODE</code></td><td><code>guest</code></td><td><code>broker</code> (Firecracker only) gives VMs no NIC and enforces egress on the host over vsock. See <Link href="/runtime/egress">Egress and credentials</Link>.</td></tr>
          <tr><td><code>LANTERN_EGRESS_ALLOWED_PORTS</code></td><td><code>443</code></td><td>Comma list of ports the broker will dial.</td></tr>
          <tr><td><code>LANTERN_EGRESS_PLAIN_INJECT</code></td><td>unset</td><td><code>1</code> permits credential injection over plain HTTP on port 80. Off by default.</td></tr>
          <tr><td><code>LANTERN_HARNESS_EXEC_PORT</code></td><td><code>50056</code></td><td>Port of the harness exec channel.</td></tr>
          <tr><td><code>LANTERN_HARNESS_READY_TIMEOUT_MS</code></td><td><code>5000</code></td><td>How long resume and fork wait for the harness.</td></tr>
          <tr><td><code>KATA_RUNTIME_NAME</code></td><td><code>kata-runtime</code></td><td>Docker runtime name registered for Kata.</td></tr>
          <tr><td><code>LANTERN_RUNTIMECLASS_GVISOR</code></td><td>unset</td><td>Kubernetes RuntimeClass for gVisor. Unset: that class is refused (fail-closed).</td></tr>
          <tr><td><code>LANTERN_RUNTIMECLASS_KATA</code></td><td>unset</td><td>RuntimeClass for Kata.</td></tr>
          <tr><td><code>LANTERN_RUNTIMECLASS_KATA_CC</code></td><td>unset</td><td>RuntimeClass for confidential Kata.</td></tr>
          <tr><td><code>LANTERN_RUNTIMECLASS_WASM</code></td><td>unset</td><td>RuntimeClass for Wasm pods.</td></tr>
          <tr><td><code>LANTERN_NODE_LABEL_GVISOR</code></td><td>unset</td><td>Node label that marks gVisor-capable nodes.</td></tr>
          <tr><td><code>LANTERN_NODE_LABEL_KATA</code></td><td>unset</td><td>Node label that marks Kata-capable nodes.</td></tr>
          <tr><td><code>LANTERN_ALLOW_RUNC_STANDARD</code></td><td>off</td><td><code>1</code>/<code>true</code>/<code>yes</code>/<code>on</code> lets the <code>standard</code> class run on plain runc (admin override).</td></tr>
          <tr><td><code>LANTERN_CC_TECH</code></td><td>unset</td><td>Confidential-computing technology to report.</td></tr>
          <tr><td><code>LANTERN_OTEL_ENABLED</code></td><td>unset</td><td><code>1</code> enables traces (with the OTLP endpoint).</td></tr>
          <tr><td><code>OTEL_EXPORTER_OTLP_ENDPOINT</code></td><td>unset</td><td>Standard OTLP endpoint.</td></tr>
        </tbody>
      </table>
      <h2 id="harness">In-VM harness</h2>
      <p>Binary: <code>services/harness</code> (Rust, PID 1 in the VM). Almost everything here is written into <code>spawn.json</code> or the kernel command line by the manager; set these through the agent spec, not by hand. The exceptions are called out.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LANTERN_ENV</code></td><td>unset (dev)</td><td>Production-like values arm the guards below.</td></tr>
          <tr><td><code>LANTERN_WORKLOAD_UID</code></td><td>unset</td><td>Uid the workload, exec and shell children run as; also the only uid admitted to the secrets socket. In prod the harness refuses to start without it. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_WORKLOAD_GID</code></td><td>uid</td><td>Workload gid.</td></tr>
          <tr><td><code>LANTERN_HARNESS_EXEC_TOKEN</code></td><td>unset</td><td>Token the Exec RPC requires. Must be set in prod and staging. <strong>Required in prod.</strong></td></tr>
          <tr><td><code>LANTERN_HARNESS_EXEC_ADDR</code></td><td><code>0.0.0.0:50056</code></td><td>Listen address of the one-shot exec server.</td></tr>
          <tr><td><code>LANTERN_WORKLOAD_CMD</code></td><td>from spawn.json</td><td>Workload command line.</td></tr>
          <tr><td><code>LANTERN_WORKLOAD_ARGV</code></td><td>from spawn.json</td><td>Workload arguments.</td></tr>
          <tr><td><code>LANTERN_MAX_RESTARTS</code></td><td><code>5</code></td><td>Workload restart limit.</td></tr>
          <tr><td><code>LANTERN_DRAIN_GRACE_SECS</code></td><td><code>25</code></td><td>Grace period on SIGTERM drain.</td></tr>
          <tr><td><code>LANTERN_RUN_DIR</code></td><td><code>/run/lantern</code></td><td>Directory for sockets (<code>secrets.sock</code>).</td></tr>
          <tr><td><code>LANTERN_RLIMIT_AS_BYTES</code></td><td>unset (no cap)</td><td>Address-space limit applied to the workload.</td></tr>
          <tr><td><code>LANTERN_EGRESS_RULES</code></td><td><code>[]</code></td><td>JSON <code>[&#123;pattern, http_methods, rate_bps&#125;]</code> declared egress.</td></tr>
          <tr><td><code>LANTERN_EGRESS_FAIL_CLOSED</code></td><td>off in dev</td><td><code>1</code> refuses to boot without the iptables REDIRECT rule. Always on in prod; <code>0</code> is ignored there with a warning.</td></tr>
          <tr><td><code>LANTERN_EGRESS_BIND</code></td><td><code>127.0.0.1:3128</code></td><td>Listen address of the in-guest egress proxy.</td></tr>
          <tr><td><code>LANTERN_EGRESS_ALLOWED_PORTS</code></td><td><code>443</code></td><td>Comma list of ports the proxy may CONNECT to; empty re-applies the default.</td></tr>
          <tr><td><code>LANTERN_NO_PROXY</code></td><td><code>127.0.0.1,localhost,::1,169.254.169.254</code></td><td>Overrides the injected <code>NO_PROXY</code>.</td></tr>
          <tr><td><code>LANTERN_EGRESS_MODE</code></td><td><code>guest</code></td><td><code>broker</code> swaps the proxy for a vsock forwarder.</td></tr>
          <tr><td><code>LANTERN_EGRESS_VSOCK_PORT</code></td><td><code>3128</code></td><td>Broker-mode vsock port to the host broker.</td></tr>
          <tr><td><code>LANTERN_EGRESS_CA_PEM</code></td><td>unset</td><td>Per-VM CA the broker uses to terminate TLS for injecting hosts.</td></tr>
          <tr><td><code>LANTERN_MANAGER_ADDR</code></td><td>from spawn.json</td><td>Manager address; in broker mode the manager's name, dialed over vsock.</td></tr>
          <tr><td><code>LANTERN_MANAGER_VSOCK_PORT</code></td><td>unset</td><td>Broker mode: vsock port of the control channel.</td></tr>
          <tr><td><code>LANTERN_MANAGER_SERVER_NAME</code></td><td><code>manager.lantern.internal</code></td><td>TLS server name used to verify the manager.</td></tr>
          <tr><td><code>LANTERN_VM_TLS_CERT</code></td><td>set at spawn</td><td>Per-VM client certificate path.</td></tr>
          <tr><td><code>LANTERN_VM_TLS_KEY</code></td><td>set at spawn</td><td>Per-VM client key path.</td></tr>
          <tr><td><code>LANTERN_MANAGER_TLS_CA</code></td><td>set at spawn</td><td>CA used to verify the manager.</td></tr>
          <tr><td><code>LANTERN_ALLOW_SECRET_STUB</code></td><td>off</td><td><code>1</code>: read secrets from the harness's own env instead of the manager. Dev only; never in production.</td></tr>
          <tr><td><code>LANTERN_DECLARED_SECRETS</code></td><td>set at spawn</td><td>Secret refs the spec declared.</td></tr>
          <tr><td><code>LANTERN_VM_ID</code></td><td>set at spawn</td><td>This VM's id.</td></tr>
          <tr><td><code>LANTERN_AGENT_INSTANCE_TOKEN</code></td><td>set at spawn</td><td>Per-instance identity token.</td></tr>
          <tr><td><code>LANTERN_TRACE_PARENT</code></td><td>set at spawn</td><td>W3C trace parent for the spawn.</td></tr>
          <tr><td><code>LANTERN_OTLP_SOCKET</code></td><td>set at spawn</td><td>Unix socket for workload OTLP.</td></tr>
          <tr><td><code>LANTERN_CONFIDENTIAL</code></td><td>unset</td><td>Marks a confidential-computing VM for attestation.</td></tr>
          <tr><td><code>LANTERN_CC_TECH</code></td><td>unset</td><td>Confidential-computing technology.</td></tr>
          <tr><td><code>LANTERN_CC_MEASUREMENT_PATH</code></td><td>unset</td><td>File holding the launch measurement.</td></tr>
          <tr><td><code>LANTERN_RUNTIME_CLASS</code></td><td>unset</td><td>RuntimeClass the pod runs under (attestation).</td></tr>
          <tr><td><code>RUST_LOG</code></td><td>unset</td><td>Standard Rust log filter.</td></tr>
        </tbody>
      </table>
      <h2 id="dashboard">Dashboard (Next.js)</h2>
      <p>App: <code>apps/web</code>. <code>NEXT_PUBLIC_*</code> values are baked in at build time.</p>
      <table>
        <thead><tr><th>Variable</th><th>Default</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>LANTERN_API_URL</code></td><td><code>http://localhost:8080</code></td><td>Control-plane URL for server-side calls (checked before <code>NEXT_PUBLIC_API_URL</code>).</td></tr>
          <tr><td><code>NEXT_PUBLIC_API_URL</code></td><td><code>http://localhost:8080</code></td><td>Control-plane URL for the browser and the kiosk page.</td></tr>
          <tr><td><code>NEXT_PUBLIC_DEMO_MODE</code></td><td>unset</td><td><code>1</code> shows the demo affordances on the login page.</td></tr>
          <tr><td><code>NEXT_PUBLIC_TURNSTILE_SITE_KEY</code></td><td>unset</td><td>Turnstile site key; renders the captcha widget.</td></tr>
          <tr><td><code>LANTERN_API_KEY</code></td><td>unset</td><td>Appears only in the generated &quot;view code&quot; samples; the dashboard itself does not read it.</td></tr>
          <tr><td><code>LANTERN_BRIDGE_URL</code></td><td>unset</td><td>WhatsApp bridge URL for the dashboard's bridge proxy route.</td></tr>
          <tr><td><code>NEXT_PUBLIC_LANTERN_BRIDGE_URL</code></td><td>unset</td><td>Public fallback for the same URL, and the Surfaces page probe.</td></tr>
          <tr><td><code>LANTERN_BRIDGE_TOKEN</code></td><td>unset</td><td>Token the proxy sends to the WhatsApp bridge.</td></tr>
          <tr><td><code>LANTERN_IMESSAGE_BRIDGE_URL</code></td><td>unset</td><td>iMessage bridge URL for the proxy route.</td></tr>
          <tr><td><code>NEXT_PUBLIC_LANTERN_IMESSAGE_BRIDGE_URL</code></td><td>unset</td><td>Public fallback, and the Surfaces page probe.</td></tr>
          <tr><td><code>LANTERN_IMESSAGE_BRIDGE_TOKEN</code></td><td>unset</td><td>Token the proxy sends to the iMessage bridge.</td></tr>
          <tr><td><code>LANTERN_SIGNAL_TOKEN</code></td><td>unset</td><td>Gates the dashboard's <code>/api/signals</code> route (header <code>x-lantern-signal-token</code>).</td></tr>
          <tr><td><code>NODE_ENV</code></td><td>set by Next.js</td><td><code>production</code> marks the session cookie <code>Secure</code>.</td></tr>
        </tbody>
      </table>

      <h2 id="how-built">How this list was built</h2>
      <p>
        Names and defaults come from the reads in code, not from other docs: Go <code>os.Getenv</code> and the local
        <code>envOrDefault</code>/<code>envInt</code> helpers in <code>services/control-plane</code>, <code>services/scheduler</code> and{" "}
        <code>services/runtime-scheduler</code>; Rust <code>std::env::var</code> in <code>services/runtime-manager/src</code> and{" "}
        <code>services/harness/src</code>; <code>process.env</code> in <code>apps/web</code>. Prod requirements come from the
        startup guards (<code>runStartupGuards</code> in the control plane, <code>authz.rs</code>/<code>tls.rs</code> in the manager).
      </p>

      <h2 id="limits">Limits</h2>
      <ul>
        <li>Not covered yet: the workflow engine, model router, gateway, surface gateway and the two chat bridges. The service token above applies to the first three.</li>
        <li>Rows whose default says <em>set at spawn</em> or <em>from spawn.json</em> are written by the manager. Setting them yourself on the harness is overridden or ignored.</li>
        <li>Duration values are Go durations (<code>30s</code>, <code>1h</code>) unless the name ends in <code>_SECS</code>, <code>_MS</code>, <code>_MIN</code> or <code>_DAYS</code>.</li>
        <li>Defaults for the model-tier variables change with releases; check <code>services/control-plane/internal/handlers/llm_proxy.go</code>.</li>
      </ul>
    </>
  );
}
