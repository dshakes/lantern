"use client";

// /proof — public receipt verifier.
//
// Lives outside the (dashboard) route group so it's reachable without
// auth. Paste a Lantern signed receipt JSON; the page verifies it
// against the control-plane's public key (exposed at
// /v1/.well-known/lantern-receipts) and shows whether the signature
// matches. This is the consumer-visible side of verifiable receipts:
// when an agent runs against a user's WhatsApp, the receipt is what
// the user can later show to prove what happened.

import { useState } from "react";
import Link from "next/link";
import {
  Shield,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import clsx from "clsx";
import { api, type SignedReceipt } from "@/lib/api";

interface VerifyResult {
  valid: boolean;
  reason?: string;
  agentName?: string;
  issuedAt?: string;
  algorithm?: string;
  fingerprint?: string;
  journalHash?: string;
}

export default function ProofPage() {
  const [json, setJson] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);

  const verify = async () => {
    setParseError(null);
    setResult(null);
    let parsed: SignedReceipt;
    try {
      parsed = JSON.parse(json) as SignedReceipt;
    } catch (err) {
      setParseError(
        err instanceof Error ? err.message : "Not valid JSON. Paste the full receipt object."
      );
      return;
    }
    if (!parsed.signature || !parsed.payload) {
      setParseError("Receipt must include `signature` and `payload` fields.");
      return;
    }
    setVerifying(true);
    try {
      const verifyRes = await api.verifyReceipt(parsed);
      setResult({
        valid: verifyRes.valid,
        reason: verifyRes.reason,
        agentName: parsed.payload.agentName as string | undefined,
        issuedAt: parsed.payload.issuedAt,
        algorithm: parsed.algorithm,
        // keyFingerprint isn't part of the strict SignedReceipt type but
        // is included in receipts emitted by control-plane — read it
        // permissively so older + newer receipts both render.
        fingerprint: (parsed as unknown as { keyFingerprint?: string }).keyFingerprint,
        journalHash: parsed.payload.journalHash,
      });
    } catch (err) {
      setResult({
        valid: false,
        reason: err instanceof Error ? err.message : "Verification request failed",
      });
    } finally {
      setVerifying(false);
    }
  };

  const reset = () => {
    setJson("");
    setResult(null);
    setParseError(null);
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <header className="border-b border-zinc-800">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-lantern-400 to-lantern-600">
            <span className="text-sm font-bold text-white">L</span>
          </div>
          <div className="flex-1">
            <h1 className="text-sm font-semibold text-zinc-100">Lantern · Proof</h1>
            <p className="text-[11px] text-zinc-500">Verify a signed agent receipt</p>
          </div>
          <Link
            href="/"
            className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-300"
          >
            <ArrowLeft className="inline h-3 w-3" /> Home
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10 space-y-6">
        <section>
          <h2 className="text-xl font-semibold tracking-tight text-zinc-100">
            Verifiable agent receipts
          </h2>
          <p className="mt-2 max-w-prose text-sm text-zinc-400 leading-relaxed">
            Every run on Lantern can issue an HMAC-signed receipt containing the
            agent name, timestamp, and a hash of the run&apos;s entire event journal.
            Paste a receipt here to check that it was actually signed by this
            Lantern installation — any tampering with the events invalidates the
            signature.
          </p>
        </section>

        <section className="space-y-3 rounded-xl border border-zinc-800 bg-surface-1 p-5">
          <label className="block text-[12px] font-semibold text-zinc-200">
            Paste a receipt JSON
          </label>
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={`{
  "signature": "...",
  "algorithm": "HMAC-SHA256",
  "keyFingerprint": "...",
  "payload": {
    "runId": "run_...",
    "agentName": "...",
    "issuedAt": "...",
    "journalHash": "..."
  }
}`}
            className="block w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-700 outline-none focus:border-lantern-500/40"
          />

          {parseError && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              {parseError}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={verify}
              disabled={!json.trim() || verifying}
              className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-lantern-400 disabled:opacity-50"
            >
              {verifying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Shield className="h-3.5 w-3.5" />
              )}
              Verify signature
            </button>
            {(json || result) && (
              <button
                onClick={reset}
                className="rounded-lg border border-zinc-800 px-3 py-2 text-[12px] text-zinc-400 transition-colors hover:bg-surface-3 hover:text-zinc-200"
              >
                Clear
              </button>
            )}
          </div>
        </section>

        {result && <ResultCard result={result} />}

        <section className="text-[11px] text-zinc-500">
          The signing key fingerprint is published at{" "}
          <code className="rounded bg-surface-2 px-1 text-zinc-400">
            /.well-known/lantern-receipts
          </code>
          . External verifiers can replicate the algorithm offline using the
          published JWS / HMAC scheme.
        </section>
      </main>
    </div>
  );
}

function ResultCard({ result }: { result: VerifyResult }) {
  const ok = result.valid;
  return (
    <section
      className={clsx(
        "rounded-xl border p-5",
        ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
      )}
    >
      <div className="flex items-center gap-2">
        {ok ? (
          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
        ) : (
          <XCircle className="h-5 w-5 text-red-400" />
        )}
        <h3 className={clsx("text-sm font-semibold", ok ? "text-emerald-200" : "text-red-200")}>
          {ok ? "Signature valid" : "Signature invalid"}
        </h3>
      </div>
      {result.reason && !ok && (
        <p className="mt-2 text-[12px] text-red-300/80">{result.reason}</p>
      )}
      <dl className="mt-4 grid grid-cols-1 gap-y-2 text-[12px] sm:grid-cols-[140px_1fr]">
        {result.agentName && (
          <>
            <dt className="text-zinc-500">Agent</dt>
            <dd className="font-mono text-zinc-200">{result.agentName}</dd>
          </>
        )}
        {result.issuedAt && (
          <>
            <dt className="text-zinc-500">Issued at</dt>
            <dd className="font-mono text-zinc-200">
              {new Date(result.issuedAt).toISOString().slice(0, 19)}Z
            </dd>
          </>
        )}
        {result.algorithm && (
          <>
            <dt className="text-zinc-500">Algorithm</dt>
            <dd className="font-mono text-zinc-200">{result.algorithm}</dd>
          </>
        )}
        {result.fingerprint && (
          <>
            <dt className="text-zinc-500">Key fingerprint</dt>
            <dd className="break-all font-mono text-zinc-400">{result.fingerprint}</dd>
          </>
        )}
        {result.journalHash && (
          <>
            <dt className="text-zinc-500">Journal hash</dt>
            <dd className="break-all font-mono text-zinc-400">{result.journalHash}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
