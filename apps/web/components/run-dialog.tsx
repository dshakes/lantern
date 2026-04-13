"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { X, Play, AlertCircle } from "lucide-react";
import clsx from "clsx";
import { agents, agentInputExamples } from "@/lib/mock-data";
import { api } from "@/lib/api";

interface RunDialogProps {
  open: boolean;
  onClose: () => void;
  defaultAgentName?: string;
  agentNames?: string[];
}

export function RunDialog({
  open,
  onClose,
  defaultAgentName = "",
  agentNames = [],
}: RunDialogProps) {
  const router = useRouter();
  const backdropRef = useRef<HTMLDivElement>(null);

  const resolvedNames =
    agentNames.length > 0
      ? agentNames
      : agents.filter((a) => a.status === "active").map((a) => a.name);

  const defaultAgent = defaultAgentName || resolvedNames[0] || "";

  const [agentName, setAgentName] = useState(defaultAgent);
  const [inputText, setInputText] = useState(
    JSON.stringify(agentInputExamples[defaultAgent] || {}, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      const agent = defaultAgentName || resolvedNames[0] || "";
      setAgentName(agent);
      setInputText(
        JSON.stringify(agentInputExamples[agent] || {}, null, 2),
      );
      setSubmitError(null);
    }
  }, [open, defaultAgentName, resolvedNames]);

  // Update input when agent changes
  const handleAgentChange = useCallback((name: string) => {
    setAgentName(name);
    const example = agentInputExamples[name];
    if (example) {
      setInputText(JSON.stringify(example, null, 2));
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!agentName.trim()) return;
    setSubmitError(null);
    setSubmitting(true);

    try {
      let parsedInput: unknown = {};
      try {
        parsedInput = JSON.parse(inputText);
      } catch {
        // Use raw text as input if not valid JSON
        parsedInput = { text: inputText };
      }

      const run = await api.createRun({
        agentName: agentName.trim(),
        input: parsedInput,
      });
      onClose();
      router.push(`/runs/${run.id}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create run";

      // Try to extract the actual error from the API response
      // The error format from api.ts is "API <status>: <body>"
      let displayError = message;
      const apiMatch = message.match(/^API \d+:\s*(.+)$/);
      if (apiMatch) {
        try {
          const parsed = JSON.parse(apiMatch[1]);
          displayError = parsed.error || parsed.message || apiMatch[1];
        } catch {
          displayError = apiMatch[1];
        }
      }

      if (
        message.includes("fetch") ||
        message.includes("ECONNREFUSED") ||
        err instanceof TypeError
      ) {
        setSubmitError(
          "Could not create run: API unavailable. Use the Playground to test interactively, or start the API with: make run-api",
        );
      } else {
        setSubmitError(displayError);
      }
    } finally {
      setSubmitting(false);
    }
  }, [agentName, inputText, router, onClose]);

  // Close on escape
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
    >
      <div className="modal-content w-full max-w-lg rounded-2xl border border-zinc-800 bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Play className="h-5 w-5 text-lantern-400" />
            Run Agent
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form — just 3 fields */}
        <div className="space-y-5 px-6 py-5">
          {/* Agent */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Agent
            </label>
            <select
              value={agentName}
              onChange={(e) => handleAgentChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30"
            >
              <option value="">Select an agent...</option>
              {resolvedNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* Input */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Input
            </label>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              rows={5}
              spellCheck={false}
              placeholder="Type your input or paste JSON..."
              className="w-full resize-none rounded-lg border border-zinc-800 bg-surface-0 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-lantern-500/50 focus:ring-1 focus:ring-lantern-500/30"
            />
          </div>
        </div>

        {/* Inline error */}
        {submitError && (
          <div className="mx-6 mb-2 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
            <div className="flex-1">
              <p className="text-xs text-red-400">{submitError}</p>
              <button
                onClick={() => {
                  onClose();
                  router.push("/playground");
                }}
                className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-red-300 underline underline-offset-2 transition-colors hover:text-red-200"
              >
                Try in Playground
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 transition-colors hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!agentName.trim() || submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-lantern-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-lantern-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Creating...
              </>
            ) : (
              <>
                <Play className="h-4 w-4" />
                Run
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
