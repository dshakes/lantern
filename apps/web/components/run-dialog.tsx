"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { X, Play, AlertCircle } from "lucide-react";
import clsx from "clsx";
import {
  agents,
  modelOptions,
  agentInputExamples,
} from "@/lib/mock-data";
import { api } from "@/lib/api";

interface RunDialogProps {
  open: boolean;
  onClose: () => void;
  defaultAgentName?: string;
  agentNames?: string[];
}

function isValidJson(str: string): boolean {
  if (!str.trim()) return true;
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
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
  const [inputJson, setInputJson] = useState(
    JSON.stringify(agentInputExamples[defaultAgent] || {}, null, 2)
  );
  const [model, setModel] = useState("auto");
  const [stream, setStream] = useState(true);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [destination, setDestination] = useState<"inspector" | "playground">(
    "inspector"
  );
  const [submitting, setSubmitting] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      const agent = defaultAgentName || resolvedNames[0] || "";
      setAgentName(agent);
      setInputJson(
        JSON.stringify(agentInputExamples[agent] || {}, null, 2)
      );
      setModel("auto");
      setStream(true);
      setJsonError(null);
    }
  }, [open, defaultAgentName, resolvedNames]);

  // Validate JSON on change
  const validateJson = useCallback((value: string) => {
    setInputJson(value);
    try {
      JSON.parse(value);
      setJsonError(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, []);

  // Update input when agent changes
  const handleAgentChange = useCallback((name: string) => {
    setAgentName(name);
    const example = agentInputExamples[name];
    if (example) {
      setInputJson(JSON.stringify(example, null, 2));
      setJsonError(null);
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!agentName.trim() || jsonError) return;

    if (destination === "playground") {
      router.push("/playground");
      onClose();
      return;
    }

    // Call the API to create a run
    setSubmitting(true);
    try {
      let parsedInput: unknown = {};
      try {
        parsedInput = JSON.parse(inputJson);
      } catch {
        // Already validated above, but fallback
      }
      const run = await api.createRun({
        agentName: agentName.trim(),
        input: parsedInput,
        model: model !== "auto" ? model : undefined,
        stream,
      });
      onClose();
      router.push(`/runs/${run.id}`);
    } catch {
      // Fallback: navigate to demo run if API unavailable
      onClose();
      router.push("/runs/run_01hqa1b2c3d4");
    } finally {
      setSubmitting(false);
    }
  }, [agentName, jsonError, destination, inputJson, model, stream, router, onClose]);

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
            className="rounded-lg p-1 text-zinc-500 hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <div className="space-y-5 px-6 py-5">
          {/* Agent name */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Agent
            </label>
            <select
              value={agentName}
              onChange={(e) => handleAgentChange(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500 focus:ring-1 focus:ring-lantern-500/30"
            >
              <option value="">Select an agent...</option>
              {resolvedNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* Input JSON */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Input (JSON)
            </label>
            <textarea
              value={inputJson}
              onChange={(e) => validateJson(e.target.value)}
              rows={5}
              spellCheck={false}
              className={clsx(
                "w-full resize-none rounded-lg border bg-surface-2 px-3 py-2 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus:ring-1",
                jsonError
                  ? "border-red-500/50 focus:border-red-500 focus:ring-red-500/30"
                  : "border-zinc-700 focus:border-lantern-500 focus:ring-lantern-500/30"
              )}
            />
            {jsonError && (
              <div className="mt-1 flex items-center gap-1.5 text-xs text-red-400">
                <AlertCircle className="h-3 w-3" />
                {jsonError}
              </div>
            )}
          </div>

          {/* Model override */}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-zinc-300">
              Model override
            </label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-surface-2 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-lantern-500"
            >
              {modelOptions.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {/* Stream toggle + destination */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div>
                <span className="text-sm font-medium text-zinc-300">
                  Stream events
                </span>
                <p className="text-xs text-zinc-500">
                  See events in real-time
                </p>
              </div>
              <button
                onClick={() => setStream(!stream)}
                className={clsx(
                  "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                  stream ? "bg-lantern-500" : "bg-surface-4"
                )}
              >
                <span
                  className={clsx(
                    "inline-block h-4 w-4 rounded-full bg-white transition-transform",
                    stream ? "translate-x-6" : "translate-x-1"
                  )}
                />
              </button>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500">Open in:</label>
              <div className="flex overflow-hidden rounded-lg border border-zinc-700">
                <button
                  onClick={() => setDestination("inspector")}
                  className={clsx(
                    "px-2.5 py-1 text-[11px] font-medium transition-colors",
                    destination === "inspector"
                      ? "bg-surface-3 text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  Inspector
                </button>
                <button
                  onClick={() => setDestination("playground")}
                  className={clsx(
                    "px-2.5 py-1 text-[11px] font-medium transition-colors",
                    destination === "playground"
                      ? "bg-surface-3 text-zinc-200"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  Playground
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-zinc-800 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!agentName.trim() || !!jsonError || submitting}
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
