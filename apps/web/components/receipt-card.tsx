"use client";

import { useState } from "react";
import { Shield, Loader2, Download, Check, Copy } from "lucide-react";
import { api, type SignedReceipt } from "@/lib/api";
import { useToast } from "@/components/toast";

interface ReceiptCardProps {
  runId: string;
  /** When true, hides the issue button (e.g. for non-completed runs) */
  disabled?: boolean;
}

export function ReceiptCard({ runId, disabled }: ReceiptCardProps) {
  const toast = useToast();
  const [issuing, setIssuing] = useState(false);
  const [receipt, setReceipt] = useState<SignedReceipt | null>(null);
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    setIssuing(true);
    try {
      const r = await api.issueReceipt(runId);
      setReceipt(r);
      toast.success("Receipt issued and signed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to issue receipt");
    } finally {
      setIssuing(false);
    }
  };

  const copy = async () => {
    if (!receipt) return;
    await navigator.clipboard.writeText(JSON.stringify(receipt, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    if (!receipt) return;
    const blob = new Blob([JSON.stringify(receipt, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `lantern-receipt-${receipt.payload.runId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!receipt) {
    return (
      <button
        onClick={issue}
        disabled={issuing || disabled}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-surface-2/50 px-4 py-2.5 text-xs font-medium text-zinc-300 transition-colors hover:border-lantern-500/30 hover:bg-lantern-500/5 hover:text-lantern-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {issuing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Shield className="h-3.5 w-3.5" />
        )}
        Issue verifiable receipt
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Shield className="h-3.5 w-3.5 text-emerald-400" />
        <span className="text-xs font-medium text-emerald-300">Receipt issued</span>
        <span className="ml-auto rounded bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300">
          {receipt.algorithm}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <dt className="text-zinc-500">Journal hash</dt>
        <dd className="truncate font-mono text-zinc-300" title={receipt.payload.journalHash}>
          {receipt.payload.journalHash.slice(0, 16)}…
        </dd>
        <dt className="text-zinc-500">Signature</dt>
        <dd className="truncate font-mono text-zinc-300" title={receipt.signature}>
          {receipt.signature.slice(0, 16)}…
        </dd>
        <dt className="text-zinc-500">Issued at</dt>
        <dd className="font-mono text-zinc-400">
          {new Date(receipt.payload.issuedAt).toISOString().slice(0, 19)}Z
        </dd>
      </dl>
      <div className="flex items-center gap-2 border-t border-emerald-500/10 pt-3">
        <button
          onClick={copy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-800 bg-surface-1 px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button
          onClick={download}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-zinc-800 bg-surface-1 px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
        >
          <Download className="h-3 w-3" />
          Download
        </button>
      </div>
    </div>
  );
}
