import Link from "next/link";
import { Concept } from "../../_components/Concept";

export default function RuntimeReceiptsPage() {
  return (
    <>
      <h1>Verifiable receipts</h1>
      <p>
        When a headless agent finishes, you can ask the runtime for a{" "}
        <strong>signed receipt</strong> — tamper-evident, offline-verifiable
        proof of what actually ran. The receipt is signed over the run&apos;s
        journal hash, so any post-hoc edit to the run&apos;s event log
        invalidates the signature.
      </p>

      <Concept>
        A receipt is proof, not a promise. When an agent claims &quot;I did
        the task&quot;, the receipt lets anyone — an auditor, a customer, a
        counterparty who doesn&apos;t trust you — check that claim
        mathematically: which agent ran, what steps it took, what it cost, and
        that nobody edited the record afterward. Verification needs no Lantern
        account and no running server; the signature either checks out or it
        doesn&apos;t.
      </Concept>

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
        The signature (<strong>Ed25519</strong> when{" "}
        <code>LANTERN_RECEIPT_ED25519_SEED</code> is set) covers the canonical JSON of a{" "}
        <code>receiptPayload</code> struct with these fields (alphabetically
        sorted keys, compact JSON, no whitespace):
      </p>
      <ul>
        <li><code>agentName</code> — always present</li>
        <li><code>agentVersion</code> — omitted when blank</li>
        <li><code>costUsd</code> — accumulated cost for the run</li>
        <li><code>issuedAt</code> — RFC3339 timestamp</li>
        <li><code>journalHash</code> — SHA-256 of the ordered <code>journal_events</code> rows</li>
        <li><code>model</code> / <code>provider</code> — reserved; currently always omitted</li>
        <li><code>runId</code> — always present</li>
        <li><code>status</code> — the run&apos;s status at issuance (e.g. <code>succeeded</code>, <code>failed</code>, <code>cancelled</code>; issuing on a non-terminal run is not refused)</li>
        <li><code>tenantId</code> — always present</li>
        <li><code>tokensIn</code> / <code>tokensOut</code> — prompt and completion token counts</li>
        <li><code>version</code> — schema version (currently <code>1</code>)</li>
        <li><code>confidentialCompute</code> — present only for confidential runs (<code>attested: false</code>: the launch measurement is recorded, not verified)</li>
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
      <p>
        Verify with <code>POST /v1/runs/receipts/verify</code> (no auth required). If{" "}
        <code>LANTERN_RECEIPT_ED25519_SEED</code> is unset, the control plane falls back to an HMAC-SHA256 signature for
        dev. Set the seed in any real deployment.
      </p>

      <h2 id="verify">Verifying offline</h2>
      <p>
        Verification needs no privileged access. The signing key&apos;s
        algorithm, fingerprint and (for Ed25519) public key are published at a
        well-known endpoint, so an
        external party can verify a receipt without calling back into your
        control plane:
      </p>
      <pre><code>{`GET /.well-known/lantern-receipts`}</code></pre>
      <p>
        Anyone holding an Ed25519 receipt and the public key published there
        can confirm the receipt was signed by this deployment&apos;s key.
        Matching the journal hash against the run&apos;s actual event log (i.e.
        nothing was altered after the fact) additionally requires the run&apos;s
        journal export. An HMAC-SHA256 receipt can only be checked by the
        deployment that holds the secret.
      </p>

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
