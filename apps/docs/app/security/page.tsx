export default function SecurityPage() {
  return (
    <>
      <h1>Security</h1>
      <p>
        Lantern is designed for production workloads that handle sensitive data.
        Security is not an add-on -- it is built into every layer of the
        architecture, from the microVM runtime to the model router.
      </p>

      <div className="callout callout-warning">
        <strong>Status note (2026-06-23):</strong> The controls described below
        reflect what is shipped and what is planned. Items marked
        <em> (planned)</em> are designed and documented but not yet implemented.
        Do not rely on planned features for compliance decisions.
      </div>

      <h2 id="what-is-shipped">What is shipped today</h2>
      <ul>
        <li><strong>AES-256-GCM encryption at rest</strong> for connector credentials and LLM provider keys (<code>LANTERN_CREDENTIAL_KEY</code>).</li>
        <li><strong>HttpOnly JWT cookies</strong> -- dashboard auth tokens are issued server-side and never exposed to client-side JavaScript.</li>
        <li><strong>Row-Level Security (RLS)</strong> policies on all 34 tenant tables (<code>USING</code> + <code>WITH CHECK</code>). Enforcement is staged: policies are installed and tested, and will be activated per-environment via <code>LANTERN_RLS_ENFORCE=1</code> as handler cutovers complete.</li>
        <li><strong>gRPC service-token auth</strong> on <code>:50051</code> -- constant-time check, runs before tenant extraction, fail-closed in production.</li>
        <li><strong>A2A tenant isolation</strong> -- <code>GetAgentCard</code> / <code>InvokeAgent</code> gate on <code>is_public OR caller-tenant</code>; private agents return 404 to cross-tenant callers.</li>
        <li><strong>Bridge retry + surface-gateway tenant resolution</strong> -- the surface gateway resolves a real Lantern <code>LANTERN_TENANT_ID</code> instead of using platform IDs; unknown installs are rejected.</li>
        <li><strong>LLM idempotency keys</strong> on all provider calls -- derived from <code>(run_id, step_id, attempt)</code>, reused across same-provider retries.</li>
        <li><strong>Dependency vuln gate</strong> -- <code>govulncheck</code>, <code>cargo-audit</code>, and <code>npm audit</code> run on every CI build.</li>
        <li><strong>OTel traces with tenant_id</strong> -- every HTTP request and gRPC call carries a span enriched with <code>tenant_id</code>, <code>run_id</code>, and <code>step_id</code>.</li>
      </ul>

      <h2 id="privacy">Privacy levels <em style={{color: "#f59e0b", fontSize: "0.85em"}}>(planned)</em></h2>
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

      <h2 id="guardrails">Guardrails <em style={{color: "#f59e0b", fontSize: "0.85em"}}>(partial)</em></h2>
      <p>
        Guardrails are rules that constrain what an agent can do. They are
        enforced at the runtime level, not by the LLM -- so they cannot be
        bypassed by prompt injection.
      </p>

      <h3>Built-in guardrails</h3>
      <ul>
        <li>
          <strong>Output validation</strong> -- verify that agent outputs
          conform to a schema before delivery
        </li>
        <li>
          <strong>Domain restrictions</strong> -- limit which external URLs
          the agent can access
        </li>
        <li>
          <strong>Token limits</strong> -- cap the maximum tokens per step
          and per run
        </li>
        <li>
          <strong>Cost limits</strong> -- set a maximum dollar amount per run
          to prevent runaway costs
        </li>
        <li>
          <strong>Human-in-the-loop</strong> -- require human approval before
          executing certain actions (sending emails, creating issues, etc.)
        </li>
      </ul>

      <h3>Configuring guardrails</h3>
      <p>
        Guardrails are configured in the agent&apos;s{" "}
        <strong>Security</strong> tab:
      </p>
      <pre>
        <code>{`{
  "guardrails": {
    "max_tokens_per_step": 4096,
    "max_cost_per_run": 1.00,
    "allowed_domains": ["*.github.com", "*.google.com"],
    "require_approval": ["gmail.send", "github.createIssue"],
    "block_pii": true
  }
}`}</code>
      </pre>

      <h2>PII blocking <em style={{color: "#f59e0b", fontSize: "0.85em"}}>(planned)</em></h2>
      <p>
        When <code>block_pii</code> is enabled, Lantern automatically detects
        and redacts personally identifiable information in agent inputs and
        outputs:
      </p>
      <ul>
        <li>Email addresses</li>
        <li>Phone numbers</li>
        <li>Social Security numbers</li>
        <li>Credit card numbers</li>
        <li>Physical addresses</li>
        <li>IP addresses</li>
      </ul>
      <p>
        PII detection runs inside the microVM before data is logged or stored.
        Redacted values are replaced with tokens like{" "}
        <code>[EMAIL_REDACTED]</code> in logs and traces.
      </p>

      <div className="callout callout-warning">
        <strong>Warning:</strong> PII blocking is a defense-in-depth measure,
        not a guarantee. For regulated industries, combine PII blocking with
        the &quot;paranoid&quot; privacy level and your own compliance controls.
      </div>

      <h2 id="encryption">Data encryption</h2>

      <h3>At rest</h3>
      <ul>
        <li>
          All data in Postgres is encrypted using AES-256
        </li>
        <li>
          Secrets and API keys use envelope encryption with tenant-specific
          keys
        </li>
        <li>
          S3 objects use server-side encryption (SSE-S3 or SSE-KMS)
        </li>
      </ul>

      <h3>In transit</h3>
      <ul>
        <li>
          All external traffic uses TLS 1.3
        </li>
        <li>
          Internal gRPC traffic between control plane and data plane uses
          mutual TLS (mTLS)
        </li>
        <li>
          The &quot;paranoid&quot; privacy level adds end-to-end encryption on
          top of TLS
        </li>
      </ul>

      <h3>Bring your own key (BYOK) <em style={{color: "#f59e0b", fontSize: "0.85em"}}>(planned)</em></h3>
      <p>
        Enterprise customers will be able to provide their own encryption keys via AWS KMS,
        Google Cloud KMS, or Azure Key Vault. This feature is on the roadmap and not yet
        available.
      </p>

      <h2 id="audit">Audit logging <em style={{color: "#f59e0b", fontSize: "0.85em"}}>(partial)</em></h2>
      <p>
        Run-level events are recorded in <code>journal_events</code> (the run event journal).
        A full immutable audit log covering secret access, role changes, and
        dashboard actions is on the roadmap. The following are tracked today:
      </p>
      <ul>
        <li>Run start, completion, and failure (via <code>journal_events</code>)</li>
        <li>A2A agent card access (tenant-scoped, cross-tenant denials logged)</li>
      </ul>
      <p>
        SIEM export via webhook or S3 is planned but not yet available.
      </p>

      <h2>Isolation</h2>
      <p>
        Agent runs execute inside isolated sandboxes. The isolation class depends
        on the workload type. In local development, Docker containers are the
        default backend (<code>RUNTIME_BACKEND=docker</code>). In production,
        the runtime-manager supports gVisor (standard), Kata microVM (hostile),
        and Firecracker-backed Kata for the highest isolation tier. Fail-closed:
        untrusted/hostile workloads are refused unless the appropriate
        RuntimeClass is configured -- never silently downgraded to a bare pod.
      </p>
      <p>All isolation tiers provide:</p>
      <ul>
        <li>
          <strong>Process isolation</strong> -- each run has its own kernel,
          filesystem, and network namespace
        </li>
        <li>
          <strong>seccomp filtering</strong> -- only allowed syscalls can
          execute
        </li>
        <li>
          <strong>Egress control</strong> -- network access is restricted to
          explicitly allowed domains
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
        Secrets (API keys, OAuth tokens, credentials) are never stored in
        plaintext. Lantern uses the <code>lantern.secret/...</code> reference
        form throughout the system. Secrets are resolved at execution time
        inside the microVM, and never appear in:
      </p>
      <ul>
        <li>Logs or traces</li>
        <li>Run state or step outputs</li>
        <li>Dashboard UI</li>
        <li>API responses</li>
      </ul>

      <div className="callout callout-tip">
        <strong>Tip:</strong> Rotate secrets from{" "}
        <strong>Settings &gt; Secrets</strong>. Old versions are retained for
        running agents to complete, then automatically purged.
      </div>
    </>
  );
}
