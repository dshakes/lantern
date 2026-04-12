"use client";

import { useState, useCallback } from "react";
import { X, Rocket, Check, Loader2 } from "lucide-react";

type DeployEnv = "development" | "staging" | "production";
type DeployState = "idle" | "deploying" | "success" | "error";

interface DeployModalProps {
  open: boolean;
  onClose: () => void;
  agentName: string;
}

export function DeployModal({ open, onClose, agentName }: DeployModalProps) {
  const [env, setEnv] = useState<DeployEnv>("development");
  const [message, setMessage] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [deployState, setDeployState] = useState<DeployState>("idle");

  const handleDeploy = useCallback(() => {
    setDeployState("deploying");
    // Simulate deploy — in production this calls gRPC to control-plane
    setTimeout(() => {
      setDeployState("success");
    }, 1800);
  }, []);

  const handleClose = useCallback(() => {
    setDeployState("idle");
    setEnv("development");
    setMessage("");
    setConfirmed(false);
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleClose}>
      <div className="modal-content mx-4 w-full max-w-md rounded-xl border border-zinc-700 bg-surface-1 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-700 px-5 py-4">
          <div className="flex items-center gap-2">
            <Rocket className="h-4 w-4 text-lantern-400" />
            <h2 className="text-sm font-semibold text-zinc-200">
              Deploy {agentName}
            </h2>
          </div>
          <button
            onClick={handleClose}
            className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {deployState === "success" ? (
          <div className="px-5 py-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/10">
              <Check className="h-6 w-6 text-emerald-400" />
            </div>
            <p className="mt-4 text-sm font-medium text-zinc-200">
              Agent deployed to {env}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {agentName} is now live in the {env} environment.
            </p>
            <button
              onClick={handleClose}
              className="mt-6 rounded-lg bg-surface-3 px-4 py-2 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Body */}
            <div className="space-y-4 px-5 py-4">
              {/* Environment */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  Target Environment
                </label>
                <div className="flex gap-2">
                  {(
                    ["development", "staging", "production"] as DeployEnv[]
                  ).map((e) => (
                    <button
                      key={e}
                      onClick={() => setEnv(e)}
                      className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors ${
                        env === e
                          ? e === "production"
                            ? "border-red-500/50 bg-red-500/10 text-red-400"
                            : "border-lantern-500/50 bg-lantern-500/10 text-lantern-400"
                          : "border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              {/* Deploy message */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  Deploy Message (optional)
                </label>
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="What changed?"
                  className="w-full rounded-md border border-zinc-700 bg-surface-2 px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-lantern-500 focus:outline-none focus:ring-1 focus:ring-lantern-500/30"
                />
              </div>

              {/* Confirmation */}
              {env === "production" && (
                <label className="flex items-center gap-2.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="h-4 w-4 rounded border-zinc-600 bg-surface-2 accent-red-500"
                  />
                  <span className="text-xs text-red-400">
                    I confirm this is ready for production deployment
                  </span>
                </label>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end border-t border-zinc-700 px-5 py-3">
              <button
                onClick={handleClose}
                className="mr-2 rounded-lg px-4 py-2 text-xs font-medium text-zinc-400 transition-colors hover:text-zinc-200"
              >
                Cancel
              </button>
              <button
                onClick={handleDeploy}
                disabled={
                  deployState === "deploying" ||
                  (env === "production" && !confirmed)
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-4 py-2 text-xs font-medium text-black transition-colors hover:bg-lantern-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deployState === "deploying" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Deploying...
                  </>
                ) : (
                  <>
                    <Rocket className="h-3.5 w-3.5" />
                    Deploy
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
