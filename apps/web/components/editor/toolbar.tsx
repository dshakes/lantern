"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Save,
  Rocket,
  Play,
  Check,
  Loader2,
} from "lucide-react";
import clsx from "clsx";

interface ToolbarProps {
  agentName: string;
  onSave: () => void;
  onDeploy: () => void;
  onTestRun: () => void;
}

export function Toolbar({
  agentName,
  onSave,
  onDeploy,
  onTestRun,
}: ToolbarProps) {
  const router = useRouter();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle"
  );

  function handleSave() {
    setSaveState("saving");
    onSave();
    // Simulate save completing
    setTimeout(() => {
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    }, 600);
  }

  return (
    <div className="flex h-12 items-center justify-between border-b border-zinc-800 bg-surface-1 px-4">
      {/* Left: back + agent name */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push(`/agents/${agentName}`)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-surface-3 hover:text-zinc-300"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="h-4 w-px bg-zinc-800" />
        <span className="text-sm font-medium text-zinc-300">{agentName}</span>
        <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
          EDITOR
        </span>
      </div>

      {/* Center: auto-save indicator */}
      <div className="flex items-center gap-1.5">
        {saveState === "saving" && (
          <>
            <Loader2 className="h-3 w-3 animate-spin text-zinc-500" />
            <span className="text-xs text-zinc-500">Saving...</span>
          </>
        )}
        {saveState === "saved" && (
          <>
            <Check className="h-3 w-3 text-emerald-400" />
            <span className="text-xs text-emerald-400">Saved</span>
          </>
        )}
        {saveState === "idle" && (
          <span className="text-xs text-zinc-600">All changes saved</span>
        )}
      </div>

      {/* Right: actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={onTestRun}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-surface-3"
        >
          <Play className="h-3 w-3" />
          Test Run
        </button>
        <button
          onClick={handleSave}
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
            saveState === "saving"
              ? "border-zinc-700 text-zinc-500"
              : "border-zinc-700 text-zinc-300 hover:bg-surface-3"
          )}
          disabled={saveState === "saving"}
        >
          <Save className="h-3 w-3" />
          Save
        </button>
        <button
          onClick={onDeploy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-lantern-500 px-3 py-1.5 text-xs font-medium text-black transition-colors hover:bg-lantern-400"
        >
          <Rocket className="h-3 w-3" />
          Deploy
        </button>
      </div>
    </div>
  );
}
