import Link from "next/link";
import { Concept } from "../_components/Concept";
import { Diagram } from "../_components/Diagram";

export default function SecurityPage() {
  return (
    <>
      <h1>Security</h1>
      <p>
        Each hop between the caller, the
        control plane, the data-plane host and the microVM is a trust boundary with its own credential, and untrusted
        code sits behind all of them.
      </p>

      <Diagram
        name="trust-boundaries"
        caption="Four zones and the credential that crosses each boundary. See Egress and credentials for the path out of the VM."
      />
      <p>
        How a sandbox reaches the network, and why it never holds a credential in broker mode:{" "}
        <Link href="/runtime/egress">Egress and credentials</Link>.
      </p>

      <Concept>
        Three questions this page answers. Can one customer&apos;s agent ever
        see another customer&apos;s data? (No — every record is fenced by
        tenant, enforced down to the database row.) What happens if an agent
        runs malicious code? (It runs inside a microVM, with egress limited to a per-sandbox allowlist:
        structurally in broker mode, where the VM has no network device, and in default mode when the image
        installs the iptables REDIRECT rule.) Can you prove what an agent did? (Yes. You can issue a signed receipt for any completed
        run; with an Ed25519 seed configured, anyone can verify it.) Everything below is labeled shipped or planned.
      </Concept>

      <div className="callout callout-warning">
        <strong>Status note:</strong> The controls described below
        reflect what is shipped and what is planned. Items marked
        <em> (planned)</em> are designed and documented but not yet implemented.
        Do not rely on planned features for compliance decisions.
      </div>

      <h2 id="what-is-shipped">What is shipped today</h2>
      <ul>
        <li><strong>AES-256-GCM encryption at rest</strong> for connector credentials and LLM provider keys. Active only when <code>LANTERN_CREDENTIAL_KEY</code> is set — when unset, these columns are stored as plaintext pass-through, so set the key in any real deployment.</li>
        <li><strong>HttpOnly session cookie</strong> -- dashboard auth uses an HttpOnly session cookie; the JWT is also kept in <code>localStorage</code> for client-side API calls.</li>
        <li><strong>Row-Level Security (RLS)</strong> policies on every tenant-scoped table (<code>USING</code> + <code>WITH CHECK</code>), guarded by a catalog gate-test — a new tenant table without RLS (or an explicit exemption) fails CI. Enforcement is staged per-environment via <code>LANTERN_RLS_ENFORCE=1</code>; the handler cutover is complete and <code>make rls-validate</code> proves the policies end-to-end against a live database.</li>
        <li><strong>gRPC service-token auth</strong> on every internal gRPC port -- control-plane <code>:50051</code>, workflow-engine <code>:50052</code>, model-router <code>:50053</code>, runtime-manager <code>:50054</code> and runtime-scheduler <code>:50055</code>. Constant-time check, runs before tenant extraction, fail-closed in production.</li>
        <li><strong>Runtime report binding</strong> -- step events and exit reports from a microVM are bound to that VM&apos;s own run: a report carrying another run&apos;s <code>run_id</code> is rejected with 403, so a compromised harness cannot spoof another tenant&apos;s audit or log stream.</li>
        <li><strong>Signed run receipts</strong> -- issued on request for a completed run (<code>POST /v1/runs/&#123;id&#125;/receipt</code>); a SHA-256 of the run&apos;s full <code>journal_events</code> stream is signed with Ed25519 when <code>LANTERN_RECEIPT_ED25519_SEED</code> is set (verifiable with no Lantern account at <code>/proof</code> against the key at <code>/.well-known/lantern-receipts</code>), HMAC-SHA256 dev fallback otherwise (verifiable only by the deployment).</li>
        <li><strong>Per-endpoint API-key scopes</strong> -- mutating endpoints are annotated with required scopes (<code>agents:write</code>, <code>runs:execute</code>, …). Enforcement is flag-gated via <code>LANTERN_AUTHZ_ENFORCE</code> and default-OFF today; when off, missing scopes are logged, not rejected.</li>
        <li><strong>Fail-closed token gates</strong> -- the gateway&apos;s API-key introspection endpoint refuses (403) in production when <code>LANTERN_GRPC_SERVICE_TOKEN</code> is unset (dev allows it with a warning); the personal <code>/v1/signals</code> endpoint refuses (401) whenever <code>LANTERN_SIGNAL_TOKEN</code> is unset. Both validate with constant-time compares when set.</li>
        <li><strong>A2A tenant isolation</strong> -- <code>GetAgentCard</code> / <code>InvokeAgent</code> gate on <code>is_public OR caller-tenant</code>; private agents return 404 to cross-tenant callers.</li>
        <li><strong>Bridge retry + surface-gateway tenant resolution</strong> -- the surface gateway resolves a real Lantern <code>LANTERN_TENANT_ID</code> instead of using platform IDs; unknown installs are rejected.</li>
        <li><strong>LLM idempotency keys</strong> on all provider calls -- derived from <code>(run_id, step_id, attempt)</code>, reused across same-provider retries.</li>
        <li><strong>Dependency vuln gate</strong> -- <code>govulncheck</code>, <code>cargo-audit</code>, and <code>npm audit</code> run on every CI build.</li>
        <li><strong>OTel traces with tenant_id</strong> -- every control-plane HTTP request and gRPC call carries a span enriched with <code>tenant_id</code>, <code>run_id</code>, and <code>step_id</code>.</li>
      </ul>

      <h2 id="privacy">Privacy levels <em style={{color: "var(--lx-flame)", fontSize: "0.85em"}}>(planned)</em></h2>
      <p>
        The following privacy levels are part of the architecture design and are
        not yet implemented. They are documented here for reference.
      </p>
      <ul>
        <li>
          <strong>Standard</strong> -- default level. Data is encrypted at rest
          and in transit. Logs include input/output for debugging. Suitable for
          most use cases.
        </li>
        <li>
          <strong>Strict</strong> <em>(planned)</em> -- inputs and outputs are not logged. PII is
          automatically detected and redacted in traces. Audit log entries are
          created for all data access.
        </li>
        <li>
          <strong>Paranoid</strong> <em>(planned)</em> -- end-to-end encryption. Data is encrypted
          before leaving the client and decrypted only inside the microVM. The
          control plane never sees plaintext data. Designed for healthcare,
          finance, and legal use cases.
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Privacy levels can be set per agent and per
        connector once the feature ships.
      </div>

      <h2 id="guardrails">Runtime controls</h2>
      <p>
        These constraints are enforced by the platform, outside the model, so a prompt injection cannot talk its way
        past them.
      </p>
      <ul>
        <li>
          <strong>Budgets</strong>: per-agent caps on cost per day and runs per day, and a tenant-wide daily cost cap.
          A hard-fail budget returns HTTP 402 before the run starts. Tokens/day is enforced at the same gates. The per-run cap is enforced mid-run in workflows and reported after the fact elsewhere; per-tool limits apply to workflow tool and connector nodes. Hard-fail budgets fail closed (503 on run create) when the budget cannot be read.
        </li>
        <li>
          <strong>Egress allowlist</strong>: declared per spawn. In broker mode anything not on the allowlist is denied
          structurally (there is no network device). In default mode the allowlist binds only when the VM host/image
          installs the iptables REDIRECT rule. See{" "}
          <Link href="/runtime/egress">Egress and credentials</Link>.
        </li>
        <li>
          <strong>Human approval</strong>: workflow <code>approval</code> nodes block on a takeover request until an
          operator grants it. Nested approvals inside child runs fail today rather than wait.
        </li>
        <li>
          <strong>Confidence gate</strong>: low-confidence tool and connector steps divert to approval. Off by default
          (<code>LANTERN_CONFIDENCE_GATE</code>).
        </li>
      </ul>
      <p>
        The dashboard also has output filters (blocked topics and similar). These run in the browser on displayed
        output. They are a convenience, not a security control.
      </p>

      <h2>PII redaction <em style={{color: "var(--lx-flame)", fontSize: "0.85em"}}>(planned)</em></h2>
      <p>
        Automatic PII detection and redaction in agent inputs, outputs and traces is not implemented. Do not rely on it.
      </p>

      <h2 id="encryption">Data encryption</h2>

      <h3>At rest</h3>
      <ul>
        <li>
          <strong>Connector credentials</strong> and{" "}
          <strong>LLM provider API keys</strong> are AES-256-GCM encrypted
          at the application layer when <code>LANTERN_CREDENTIAL_KEY</code> is
          configured; when it is unset they are stored unencrypted
          (plaintext pass-through). Other Postgres columns use
          standard Postgres storage — disk-level encryption is the
          responsibility of the host.
        </li>
        <li>
          S3/MinIO objects (agent bundles, snapshots): encryption is a bucket setting you configure on your storage. Lantern does not set it.
        </li>
      </ul>

      <h3>In transit</h3>
      <ul>
        <li>
          All external traffic uses modern TLS — the gateway is built on
          rustls safe defaults (TLS 1.2 and 1.3)
        </li>
        <li>
          Internal gRPC traffic is authenticated with a pre-shared service
          token (<code>LANTERN_GRPC_SERVICE_TOKEN</code>) validated via
          constant-time compare — a <code>UnaryServiceAuthInterceptor</code>{" "}
          runs before tenant extraction, fail-closed in production. mTLS is the
          planned stronger follow-up and is not yet implemented.
        </li>
        <li>
          Default egress mode: in-VM secret vending uses kernel-attested peer auth (
          <code>SO_PEERCRED</code>) on the Unix domain socket — only the
          expected workload uid may receive secrets, and the harness refuses any
          other peer at the kernel level.
        </li>
      </ul>

      <h3>Bring your own key (BYOK) <em style={{color: "var(--lx-flame)", fontSize: "0.85em"}}>(planned)</em></h3>
      <p>
        Enterprise customers will be able to provide their own encryption keys via AWS KMS,
        Google Cloud KMS, or Azure Key Vault. This feature is on the roadmap and not yet
        available.
      </p>

      <h2 id="audit">Audit logging <em style={{color: "var(--lx-flame)", fontSize: "0.85em"}}>(partial)</em></h2>
      <p>
        Run-level events are recorded in <code>journal_events</code> (the run event journal).
        A full immutable audit log covering secret access, role changes, and
        dashboard actions is on the roadmap. The following are tracked today:
      </p>
      <ul>
        <li>Run start, completion, and failure (via <code>journal_events</code>)</li>
        <li>A2A agent card access (tenant-scoped; cross-tenant requests return 404)</li>
      </ul>
      <p>
        SIEM export via webhook or S3 is planned but not yet available.
      </p>

      <h2>Isolation</h2>
      <p>
        Agent runs execute inside isolated sandboxes. The isolation class depends
        on the workload type. The default backend is Kubernetes
        (<code>RUNTIME_BACKEND=k8s</code>); Docker is available for local
        development (<code>RUNTIME_BACKEND=docker</code>). In production,
        the runtime-manager supports gVisor (standard), Kata microVM (hostile),
        and Firecracker-backed Kata for the highest isolation tier. Fail-closed:
        untrusted/hostile workloads are refused unless the appropriate
        RuntimeClass is configured -- never silently downgraded to a bare pod.
      </p>
      <p>All isolation tiers provide:</p>
      <ul>
        <li>
          <strong>Process isolation</strong> -- separate filesystem and network namespace per run; microVM classes add their own guest kernel
        </li>
        <li>
          <strong>seccomp filtering</strong> -- syscall restriction is a
          property of the configured RuntimeClass (gVisor / Kata), not a
          Lantern-shipped profile
        </li>
        <li>
          <strong>Egress control</strong> -- default mode: an in-guest allowlist CONNECT proxy, fail-closed in production, which needs the iptables REDIRECT rule on the VM host/image (proxy env vars alone are advisory). Opt-in broker mode (<code>LANTERN_EGRESS_MODE=broker</code>, Firecracker only): the VM has no network device and a host broker enforces the allowlist and injects credentials, so they never enter the VM
        </li>
        <li>
          <strong>Resource limits</strong> -- CPU, memory, and disk are capped
          per run
        </li>
      </ul>

      <div className="callout callout-danger">
        <strong>Important:</strong> User-supplied code, Python exec, browser
        automation, and anything that loads packages from the internet MUST run
        inside a microVM. This is an architectural invariant. Never run
        untrusted code in a bare container.
      </div>

      <h2>Secret management</h2>
      <p>
        Secrets (API keys, OAuth tokens, credentials) are referenced via the{" "}
        <code>lantern.secret/...</code> form and resolved at execution time by
        the runtime-manager&apos;s secret resolver (via the control-plane relay); stored credentials are
        AES-256-GCM encrypted when <code>LANTERN_CREDENTIAL_KEY</code> is
        configured. Resolved values never appear in:
      </p>
      <ul>
        <li>Logs or traces</li>
        <li>Run state or step outputs</li>
        <li>Dashboard UI</li>
        <li>API responses</li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Rotate LLM provider keys from{" "}
        <strong>Settings &gt; LLM Providers</strong>; rotate connector
        credentials by re-installing the connector from{" "}
        <strong>Integrations</strong>.
      </div>
    </>
  );
}
