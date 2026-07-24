import Link from "next/link";

export default function RuntimeIdentityPage() {
  return (
    <>
      <h1>Identity &amp; Secrets</h1>
      <p>
        Every headless agent spawn gets its own cryptographic identity, and
        secrets are vended to it at execution time over a mutually-authenticated
        channel — never baked into the image, never sitting in an environment
        variable on disk. The two are linked: the per-instance identity is what
        authenticates the secret-vending call.
      </p>

      <h2 id="identity">Per-instance Ed25519 identity</h2>
      <p>
        At spawn, the runtime issues the instance its own{" "}
        <strong>Ed25519 keypair</strong>. The identity is scoped to that single
        spawn — two runs of the same agent have different keys — and it is what
        the <Link href="/runtime/observability">observability</Link> layer uses as{" "}
        <code>agent_instance_id</code> to keep traces from colliding.
      </p>

      <h3>Externally verifiable</h3>
      <p>
        The instance&apos;s public identity is verifiable at a well-known
        endpoint, so a downstream service can confirm it is talking to a genuine
        Lantern-issued instance:
      </p>
      <pre><code>{`GET /.well-known/lantern-agent-identity`}</code></pre>

      <h2 id="vending">Short-TTL secret vending</h2>
      <p>
        The workload never ships with secrets. Instead it requests them at
        runtime via the harness&apos;s secrets socket (
        <code>/run/lantern/secrets.sock</code>), which authenticates every
        connecting peer with <code>SO_PEERCRED</code> — kernel-attested uid
        and pid, not spoofable. The harness only vends to the workload uid
        injected by the manager as <code>LANTERN_WORKLOAD_UID</code>. Secrets
        have a 300-second TTL.
      </p>
      <p>
        The control-plane resolves <code>lantern.secret/...</code> references
        through a relay endpoint protected by a pre-shared
        <code>X-Lantern-Runtime-Token</code> header (SHA-256 compared, set via{" "}
        <code>LANTERN_RUNTIME_SECRET_TOKEN</code>; the endpoint returns 403
        when unset). mTLS between the runtime-manager and control-plane is the
        planned stronger follow-up and is not yet implemented.
      </p>
      <ul>
        <li><strong><code>SO_PEERCRED</code> peer auth.</strong> The kernel attests uid/pid on every socket connection; no credential the workload can forge.</li>
        <li><strong>Short TTL (300 s).</strong> A leaked value has a small blast radius — the workload re-requests as needed.</li>
        <li><strong>Pre-shared token on the relay.</strong> The manager authenticates to the control-plane relay via <code>X-Lantern-Runtime-Token</code>; fail-closed when unset.</li>
      </ul>

      <h2 id="ref-form">The <code>lantern.secret/...</code> ref form</h2>
      <p>
        In the spec you reference a secret, you do not embed it. The runtime
        resolves the reference at execution time and hands the value to the
        workload — typically at a path like{" "}
        <code>/run/lantern/secrets/&lt;NAME&gt;</code> — so the raw value never
        appears in the image, the environment, logs, traces, or run state. From
        demo 02:
      </p>
      <pre><code>{`secrets:
  - env_name: USER_AGENT
    secret_uri: lantern.secret://__tenant__/key/scraper-user-agent`}</code></pre>
      <div className="callout callout-info">
        <strong>Note:</strong> The <code>lantern.secret/...</code> ref form is
        the same convention used across the platform — see{" "}
        <Link href="/security">Security</Link>. The runtime is where it is resolved,
        inside the isolation boundary, at the moment the workload needs it.
      </div>

      <div className="callout callout-danger">
        <strong>Important:</strong> Pair secret vending with the right{" "}
        <Link href="/runtime/isolation">isolation class</Link>. A workload that loads
        internet packages and also holds a secret should be{" "}
        <code>untrusted</code> with an egress allowlist, so a compromised
        dependency can&apos;t exfiltrate the vended value to an arbitrary host.
      </div>

      <h2 id="takeaway">What you get</h2>
      <ul>
        <li><strong>Per-spawn Ed25519 identity</strong>, externally verifiable at <code>/.well-known/lantern-agent-identity</code>.</li>
        <li><strong>SO_PEERCRED peer-auth, short-TTL secret vending</strong> via harness Unix socket.</li>
        <li><strong>Reference-form secrets</strong> resolved inside the isolation boundary — raw values never touch the image, env, logs, or run state.</li>
      </ul>
    </>
  );
}
