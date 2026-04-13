"use client";

import { Zap, FileText, Database, Mail, Brain, HardDrive, CheckCircle, Loader2, XCircle, Clock } from "lucide-react";
import clsx from "clsx";

interface Step {
  step: string;
  status: string;
  detail: string;
  ts?: string;
}

function getStepVisual(stepName: string): { Icon: typeof Zap; color: string } {
  if (stepName.includes("initialize")) return { Icon: Zap, color: "text-amber-400" };
  if (stepName.includes("prompt") || stepName.includes("build")) return { Icon: FileText, color: "text-blue-400" };
  if (stepName.includes("fetch_data") || stepName.includes("data")) return { Icon: Database, color: "text-cyan-400" };
  if (stepName.includes("gmail") || stepName.includes("email") || stepName.includes("fetch_gmail")) return { Icon: Mail, color: "text-red-400" };
  if (stepName.includes("llm") || stepName.includes("call_llm")) return { Icon: Brain, color: "text-purple-400" };
  if (stepName.includes("save") || stepName.includes("output")) return { Icon: HardDrive, color: "text-teal-400" };
  if (stepName.includes("complete")) return { Icon: CheckCircle, color: "text-emerald-400" };
  return { Icon: Zap, color: "text-zinc-400" };
}

function formatDetail(detail: string): string {
  const llmMatch = detail.match(/Response from (\w+)\/([\w-]+): (\d+) tokens/);
  if (llmMatch) {
    const model = llmMatch[2].replace("gpt-4o", "GPT-4o").replace(/claude-sonnet-\d+/, "Claude Sonnet").replace(/claude-opus-\d+/, "Claude Opus");
    return `${model} · ${llmMatch[3]} tokens`;
  }
  const finishMatch = detail.match(/Run finished: (\d+) tokens, \$([\d.]+)/);
  if (finishMatch) return `Done · ${parseInt(finishMatch[1]).toLocaleString()} tokens · $${parseFloat(finishMatch[2]).toFixed(3)}`;
  return detail;
}

function stepDuration(currentTs?: string, prevTs?: string): string | null {
  if (!currentTs || !prevTs) return null;
  const ms = new Date(currentTs).getTime() - new Date(prevTs).getTime();
  if (ms < 100) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

interface ExecutionLogProps {
  steps: Step[];
  isRunDone: boolean;
  isRunning?: boolean;
}

export function ExecutionLog({ steps, isRunDone, isRunning }: ExecutionLogProps) {
  if (steps.length === 0 && isRunning) {
    return (
      <div className="flex items-center gap-2 py-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-lantern-400" />
        <span className="text-xs text-zinc-400">Running...</span>
      </div>
    );
  }
  if (steps.length === 0) return null;

  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Steps</p>
      {/* Compact horizontal-wrap layout */}
      <div className="flex flex-wrap gap-1.5">
        {steps.map((s, i) => {
          const done = s.status === "completed" || (isRunDone && s.status === "running");
          const running = s.status === "running" && !isRunDone;
          const failed = s.status === "error" || s.status === "failed";
          const visual = getStepVisual(s.step);
          const dur = stepDuration(s.ts, i > 0 ? steps[i - 1].ts : undefined);

          return (
            <div
              key={i}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition-all",
                done ? "border-zinc-800 bg-surface-0 text-zinc-300" :
                running ? "border-lantern-500/30 bg-lantern-500/5 text-lantern-300" :
                failed ? "border-red-500/30 bg-red-500/5 text-red-300" :
                "border-zinc-800 bg-surface-0 text-zinc-500"
              )}
              title={s.detail}
            >
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin text-lantern-400" />
              ) : failed ? (
                <XCircle className="h-3 w-3 text-red-400" />
              ) : (
                <visual.Icon className={clsx("h-3 w-3", done ? visual.color : "text-zinc-600")} />
              )}
              <span className="max-w-[200px] truncate">{formatDetail(s.detail)}</span>
              {dur && done && (
                <span className="flex items-center gap-0.5 text-[9px] text-zinc-600">
                  <Clock className="h-2 w-2" />{dur}
                </span>
              )}
              {done && <CheckCircle className="h-2.5 w-2.5 text-emerald-500/70" />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function deduplicateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const stepMap = new Map<string, Step>();
  for (const s of raw as Step[]) stepMap.set(s.step, s);
  return Array.from(stepMap.values());
}
