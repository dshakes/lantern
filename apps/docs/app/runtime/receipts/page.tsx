import Link from "next/link";

export default function RuntimeReceiptsPage() {
  return (
    <>
      <h1>Verifiable Receipts</h1>
      <p>
        When a headless agent finishes, you can ask the runtime for a{" "}
        <strong>signed receipt</strong> — tamper-evident, offline-verifiable
        proof of what actually ran. The receipt is signed over the run&apos;s
        journal hash, so any post-hoc edit to the run&apos;s event log
        invalidates the signature.
      </p>

      <h2 id="what">What a receipt attests</h2>
      <p>
        The receipt binds together the run&apos;s identity and the cryptographic
        hash of its <Link href="/runtime/durable-execution">event-sourced
        journal</Link>. Because the journal is the authoritative record of every
        step that executed, signing over its hash means the receipt attests to{" "}
        <em>the exact sequence of steps that ran</em> — not a summary that could
        drift from reality.
      </p>

      <h2 id="payload">Payload fields</h2>
      <p>
        The <strong>Ed25519</strong> signature covers the canonical JSON of a{" "}
        <code>receiptPayload</code> struct with these fields (alphabetically
        sorted keys, compact JSON, no whitespace):
      </p>
      <ul>
        <li><code>agentName</code> — always present</li>
        <li><code>agentVersion</code> — omitted when blank</li>
        <li><code>costUsd</code> — accumulated cost for the run</li>
        <li><code>issuedAt</code> — RFC3339 timestamp</li>
        <li><code>journalHash</code> — SHA-256 of the ordered <code>journal_events</code> rows</li>
        <li><code>model</code> — omitted when blank</li>
        <li><code>provider</code> — omitted when blank</li>
        <li><code>runId</code> — always present</li>
        <li><code>status</code> — <code>succeeded</code> or <code>failed</code></li>
        <li><code>tenantId</code> — always present</li>
        <li><code>tokensIn</code> / <code>tokensOut</code> — prompt and completion token counts</li>
        <li><code>version</code> — schema version (currently <code>1</code>)</li>
      </ul>
      <p>
        The canonical JSON is produced by a three-step round-trip: marshal the
        struct, unmarshal into <code>{"map[string]any"}</code>, re-marshal (Go
        sorts map keys alphabetically on re-marshal). The result is compact JSON
        with keys in alphabetical order — reproducible offline with any JSON
        library that sorts keys.
      </p>

      <h2 id="issue">Issuing a receipt</h2>
      <p>Issue and persist a signed receipt for a completed run:</p>
      <pre><code>{`POST /v1/runs/{id}/receipt`}</code></pre>
      <p>
        The receipt is an <strong>Ed25519</strong> signature over the journal
        hash. It is persisted alongside the run, so it can be retrieved and
        re-verified later.
      </p>

      <h2 id="verify">Verifying offline</h2>
      <p>
        Verification needs no privileged access. The signing key&apos;s
        algorithm and fingerprint are published at a well-known endpoint, so an
        external party can verify a receipt without calling back into your
        control plane:
      </p>
      <pre><code>{`GET /.well-known/lantern-receipts`}</code></pre>
      <p>
        Anyone holding a receipt and the published key fingerprint can confirm:
      </p>
      <ul>
        <li>the receipt was signed by this deployment&apos;s key, and</li>
        <li>the journal hash inside it matches the run&apos;s actual event log — i.e. nothing was altered after the fact.</li>
      </ul>

      <div className="callout callout-info">
        <strong>Note:</strong> A receipt is signed over the{" "}
        <strong>journal hash</strong>, so tampering with even one event after
        issuance breaks verification. The journal is also what{" "}
        <Link href="/runtime/durable-execution">durable execution</Link> replays on
        recovery — the same record underpins both crash-safety and provenance.
      </div>

      <h2 id="takeaway">Why it matters</h2>
      <ul>
        <li><strong>Provenance.</strong> Cryptographic proof of exactly which steps a run executed.</li>
        <li><strong>Tamper-evidence.</strong> Editing the journal after the fact invalidates the signature.</li>
        <li><strong>Offline verification.</strong> The key fingerprint at <code>/.well-known/lantern-receipts</code> lets external verifiers check a receipt without trusting (or contacting) your control plane.</li>
      </ul>
      <p>
        Receipts share the same signing + verification machinery as run
        receipts elsewhere on the platform — see the{" "}
        <Link href="/api">API reference</Link> for the full request/response shape.
      </p>
    </>
  );
}
