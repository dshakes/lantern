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
        the <a href="/runtime/observability">observability</a> layer uses as{" "}
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
        runtime via <code>VendSecret</code>, authenticating with a{" "}
        <strong>Bearer</strong> credential tied to its per-instance identity.
        Vended secrets are <strong>short-TTL</strong> — they expire quickly, so
        a leaked value has a small blast radius — and the channel is{" "}
        <strong>mTLS</strong>, so both ends are authenticated.
      </p>
      <ul>
        <li><strong>Bearer on <code>VendSecret</code>.</strong> The instance presents a credential derived from its spawn identity; an unauthenticated request gets nothing.</li>
        <li><strong>Short TTL.</strong> Secrets are vended just-in-time and expire, rather than living for the life of the pod.</li>
        <li><strong>mTLS transport.</strong> The vending channel is mutually authenticated; the secret never crosses an unauthenticated hop.</li>
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
        <a href="/security">Security</a>. The runtime is where it is resolved,
        inside the isolation boundary, at the moment the workload needs it.
      </div>

      <div className="callout callout-danger">
        <strong>Important:</strong> Pair secret vending with the right{" "}
        <a href="/runtime/isolation">isolation class</a>. A workload that loads
        internet packages and also holds a secret should be{" "}
        <code>untrusted</code> with an egress allowlist, so a compromised
        dependency can&apos;t exfiltrate the vended value to an arbitrary host.
      </div>

      <h2 id="takeaway">What you get</h2>
      <ul>
        <li><strong>Per-spawn Ed25519 identity</strong>, externally verifiable at <code>/.well-known/lantern-agent-identity</code>.</li>
        <li><strong>Bearer-authenticated, short-TTL secret vending</strong> over mTLS.</li>
        <li><strong>Reference-form secrets</strong> resolved inside the isolation boundary — raw values never touch the image, env, logs, or run state.</li>
      </ul>
    </>
  );
}
