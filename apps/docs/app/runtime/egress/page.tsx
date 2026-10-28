import Link from "next/link";
import { Concept } from "../../_components/Concept";
import { Diagram } from "../../_components/Diagram";
import { Recording } from "../../_components/Recording";
import { Sequence } from "../../_components/interactive/Sequence";
import { pageMeta } from "../../_meta";

export const metadata = pageMeta("/runtime/egress");

export default function RuntimeEgressPage() {
  return (
    <>
      <h1>Egress and credentials</h1>
      <p>
        A sandbox is only as safe as its way out. Lantern ships two egress modes. The <strong>default mode</strong>{" "}
        enforces the allowlist inside the guest via an iptables-redirected CONNECT proxy. The optional{" "}
        <strong>broker mode</strong> (<code>LANTERN_EGRESS_MODE=broker</code>, Firecracker only) removes the network
        device entirely: every outbound request crosses a vsock to a broker in the runtime-manager on the host, which
        checks the sandbox&apos;s allowlist and adds the credential there. In broker mode the workload never holds the
        token it is using.
      </p>

      <Concept>
        Think of the VM as a room with no windows and one mail slot. The code inside can write a letter to any address,
        but the clerk on the other side of the slot only forwards letters to addresses on the list, and signs them with
        your name on the way out. The letter writer never learns your signature.
      </Concept>

      <h2 id="flow">The path out</h2>
      <Diagram
        name="egress-broker"
        caption="workload → 127.0.0.1:3128 → harness → vsock → host broker (allowlist, credential) → upstream"
      />
      <ol>
        <li>
          The workload sends an ordinary HTTP(S) request through <code>127.0.0.1:3128</code>. The harness injects{" "}
          <code>HTTP_PROXY</code>/<code>HTTPS_PROXY</code>, so most clients need no change.
        </li>
        <li>The harness (PID 1) forwards it over vsock, the VM&apos;s only channel to the host.</li>
        <li>The broker in the runtime-manager matches the destination against the sandbox&apos;s allowlist.</li>
        <li>
          If the rule has an <code>inject</code> entry (header + <code>secret_uri</code>), the broker resolves the secret on
          the host and sets that header, replacing any placeholder the workload sent.
        </li>
        <li>The request goes upstream. A denied request is refused and written to the audit stream.</li>
      </ol>
      <Sequence name="egress" />

      <h2 id="allowlist">Allowlist</h2>
      <p>
        Each spawn declares its egress rules (host pattern, HTTP methods, rate). Anything not listed is denied. The broker also refuses private and metadata IP ranges and allows only port 443 unless <code>LANTERN_EGRESS_ALLOWED_PORTS</code> says otherwise. In
        broker mode (<code>LANTERN_EGRESS_MODE=broker</code>) the VM has no network device, so a client that ignores
        proxy variables simply has no route. In the default mode iptables redirects all traffic to the in-guest proxy.
        Denials are security-critical audit events and are never dropped, even across a brief manager outage.
      </p>

      <h2 id="credentials">Credential injection</h2>
      <p>
        Specs reference secrets by <code>secret_uri</code>, never by value. The broker resolves the ref on the host and
        sets the header on the outbound request, so the secret exists only on the host side of the vsock. A compromised
        workload cannot exfiltrate a key it never received. For HTTPS, the broker terminates TLS only for hosts whose
        rule injects a credential, using a per-VM ephemeral CA that is name-constrained to those hosts. Every other host
        is an opaque CONNECT tunnel, end-to-end TLS.
      </p>
      <Recording
        name="egress-broker-kvm"
        alt="Terminal recording, recorded on Lima nested KVM: the broker-mode e2e test passes — no TAP and no eth0, exec over vsock, the credential injected upstream while the guest saw only a placeholder, plain-HTTP to :443 refused, a mismatched Host refused, a non-allowlisted host denied, and the secret absent from the manager log."
        caption="infra/firecracker/broker-e2e.sh against real httpbin.org on Firecracker 1.15.1, recorded on Lima nested KVM (aarch64). Unedited output, filtered to PASS lines."
      />
      <p>
        Related: <Link href="/runtime/identity">Identity and secrets</Link>,{" "}
        <Link href="/runtime/isolation">Isolation classes</Link>, <Link href="/security">Security</Link>.
      </p>
    </>
  );
}
