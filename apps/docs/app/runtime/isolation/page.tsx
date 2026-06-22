export default function RuntimeIsolationPage() {
  return (
    <>
      <h1>Isolation Classes</h1>
      <p>
        Every headless agent declares an <strong>isolation class</strong> in its{" "}
        <code>agent.yaml</code>. The class is the security boundary the workload
        runs behind. On Kubernetes it maps to a <code>runtimeClassName</code> —
        isolation is a tier on the pod, not a separate backend (
        <a href="https://github.com/dshakes/lantern/blob/master/docs/adr/0009-kubernetes-default-runtime-substrate.md" target="_blank" rel="noopener noreferrer">ADR 0009</a>).
      </p>

      <h2 id="decision">The decision tree</h2>
      <p>
        Pick the <strong>least-privileged class the workload can tolerate</strong>.
        Walk it top to bottom and stop at the first match:
      </p>
      <pre><code>{`Is the code first-party and signed?                 ── yes ─▶  TRUSTED   (runc)
   │ no
Does it load packages from the internet,
or drive a browser, or run user/LLM-generated code? ── yes ─▶  UNTRUSTED (gVisor + egress-deny)
   │ no
Is the *input* adversarial / hostile?               ── yes ─▶  HOSTILE   (Kata microVM)
   │ no
                                                    ────────▶  STANDARD  (gVisor, default)`}</code></pre>

      <h2 id="classes">The classes</h2>
      <table>
        <thead>
          <tr><th>Class</th><th>RuntimeClass</th><th>Use when</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>trusted</code></td>
            <td><code>runc</code></td>
            <td>Signed first-party code only. Runs on shared nodes. No untrusted package loading, no LLM-generated code path.</td>
          </tr>
          <tr>
            <td><code>standard</code></td>
            <td><code>gvisor</code></td>
            <td><strong>Default.</strong> Your own code on shared, gVisor-isolated nodes. Used when the class is left unset.</td>
          </tr>
          <tr>
            <td><code>untrusted</code></td>
            <td><code>gvisor</code> + egress-deny</td>
            <td>Loads internet packages (PyPI/npm), drives a browser, or runs LLM-generated code. Adds an egress allowlist and seccomp deny-default.</td>
          </tr>
          <tr>
            <td><code>hostile</code></td>
            <td><code>kata-qemu</code> (or <code>kata-fc</code>)</td>
            <td>Adversarial workloads. Full-kernel microVM via Kubernetes on a <strong>dedicated node pool with no co-tenancy</strong>.</td>
          </tr>
          <tr>
            <td><code>wasm</code></td>
            <td><code>crun+wasm</code></td>
            <td>WebAssembly workloads (or in-process Wasmtime on trusted hosts).</td>
          </tr>
          <tr>
            <td><code>devcontainer</code></td>
            <td><code>gvisor</code></td>
            <td>Long-lived workspace: a persistent pod + PVC that survives across calls.</td>
          </tr>
        </tbody>
      </table>

      <h2 id="defaults">Defaults &amp; forced classes</h2>
      <ul>
        <li>An <strong>unset</strong> class resolves to <code>standard</code>.</li>
        <li>Marketplace bundles and LLM-generated bundles are <strong>forced to <code>untrusted</code></strong> — they cannot opt down.</li>
        <li><code>trusted</code> requires the signing key; a bundle without it cannot claim <code>trusted</code>.</li>
      </ul>

      <h2 id="fail-closed">The fail-closed gate</h2>
      <p>
        This is the load-bearing invariant. Untrusted and hostile code{" "}
        <strong>never runs in a bare pod</strong>:
      </p>
      <ul>
        <li>A node may satisfy <code>untrusted</code> <strong>only if it advertises the <code>gvisor</code> RuntimeClass</strong>.</li>
        <li>A node may satisfy <code>hostile</code> <strong>only if it advertises <code>kata-qemu</code> / <code>kata-fc</code></strong>.</li>
        <li>A node that lacks the required hardened RuntimeClass <strong>fails closed</strong> — the run is refused. It is never downgraded to <code>runc</code>.</li>
      </ul>
      <p>
        The requirement is enforced in two places: the manager (which builds
        the pod spec) and the scheduler&apos;s node-capability filter (which only
        places onto nodes advertising the needed RuntimeClass).
      </p>

      <div className="callout callout-danger">
        <strong>Important:</strong> If your cluster has not provisioned the{" "}
        <code>gvisor</code> / <code>kata</code> RuntimeClasses, untrusted and
        hostile workloads are refused — correct, but operationally visible. The
        data-plane installer provisions them and a preflight check surfaces the
        gap before traffic.
      </div>

      <div className="callout callout-info">
        <strong>Note:</strong> <code>gvisor</code> intercepts syscalls in
        user space — a minority of workloads hit an unimplemented syscall.
        Declare <code>hostile</code> (full kernel via Kata) for those, or get a{" "}
        <code>runc</code>-on-trusted exception via the admin override.
      </div>

      <h2 id="example">In a spec</h2>
      <p>
        Demo 02 (<code>web-scraper</code>) declares <code>untrusted</code>
        because it pulls third-party packages, and pairs it with an egress
        allowlist:
      </p>
      <pre><code>{`spec:
  isolation: untrusted
  network: allowlist_domain
  egress_rules:
    - pattern: "*.wikipedia.org"
      http_methods: ["GET"]
      rate_bps: 1048576      # 1 MiB/s`}</code></pre>
      <p>
        Egress enforcement and secret vending for untrusted workloads are
        covered in <a href="/runtime/identity">Identity &amp; secrets</a>.
      </p>
    </>
  );
}
