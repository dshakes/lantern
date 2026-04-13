export default function SecurityPage() {
  return (
    <>
      <h1>Security</h1>
      <p>
        Lantern is designed for production workloads that handle sensitive data.
        Security is not an add-on -- it is built into every layer of the
        architecture, from the microVM runtime to the model router.
      </p>

      <h2>Privacy levels</h2>
      <p>
        Every agent has a configurable <strong>privacy level</strong> that
        controls how data is handled:
      </p>
      <ul>
        <li>
          <strong>Standard</strong> -- default level. Data is encrypted at rest
          and in transit. Logs include input/output for debugging. Suitable for
          most use cases.
        </li>
        <li>
          <strong>Strict</strong> -- inputs and outputs are not logged. PII is
          automatically detected and redacted in traces. Audit log entries are
          created for all data access.
        </li>
        <li>
          <strong>Paranoid</strong> -- end-to-end encryption. Data is encrypted
          before leaving the client and decrypted only inside the microVM. The
          control plane never sees plaintext data. Designed for healthcare,
          finance, and legal use cases.
        </li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> Privacy levels can be set per agent and per
        connector. A strict agent with a standard connector will apply strict
        rules to all data flowing through that connector.
      </div>

      <h2>Guardrails</h2>
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

      <h2>PII blocking</h2>
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

      <h2>Data encryption</h2>

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

      <h3>Bring your own key (BYOK)</h3>
      <p>
        Enterprise customers can provide their own encryption keys via AWS KMS,
        Google Cloud KMS, or Azure Key Vault. Lantern wraps all data encryption
        with your key, giving you full control over data access.
      </p>

      <h2>Audit logging</h2>
      <p>
        Every significant action is recorded in an immutable audit log:
      </p>
      <ul>
        <li>Agent creation, update, and deletion</li>
        <li>Connector authorization and revocation</li>
        <li>Run start, completion, and failure</li>
        <li>Secret access and rotation</li>
        <li>User login, logout, and permission changes</li>
      </ul>
      <p>
        Audit logs are available in the dashboard under{" "}
        <strong>Settings &gt; Audit Log</strong>. They can also be exported to
        your SIEM (Splunk, Datadog, etc.) via webhook or S3 export.
      </p>

      <h2>MicroVM isolation</h2>
      <p>
        Every agent run executes inside its own{" "}
        <strong>Firecracker microVM</strong>. This provides:
      </p>
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
