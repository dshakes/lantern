"use client";

import { Zap, FileText, Database, Mail, Brain, HardDrive, CheckCircle, Loader2, XCircle, Clock } from "lucide-react";
import clsx from "clsx";

interface Step {
  step: string;
  status: string;
  detail: string;
  ts?: string;
}

/** Map step names to proper lucide icons with colors */
function getStepVisual(stepName: string): { Icon: typeof Zap; bg: string; iconColor: string } {
  if (stepName.includes("initialize") || stepName === "initialize")
    return { Icon: Zap, bg: "bg-amber-500/15", iconColor: "text-amber-400" };
  if (stepName.includes("prompt") || stepName.includes("build"))
    return { Icon: FileText, bg: "bg-blue-500/15", iconColor: "text-blue-400" };
  if (stepName.includes("data") || stepName.includes("fetch_data"))
    return { Icon: Database, bg: "bg-cyan-500/15", iconColor: "text-cyan-400" };
  if (stepName.includes("gmail") || stepName.includes("email") || stepName.includes("fetch_gmail"))
    return { Icon: Mail, bg: "bg-red-500/15", iconColor: "text-red-400" };
  if (stepName.includes("llm") || stepName.includes("call_llm") || stepName.includes("ai"))
    return { Icon: Brain, bg: "bg-purple-500/15", iconColor: "text-purple-400" };
  if (stepName.includes("save") || stepName.includes("output"))
    return { Icon: HardDrive, bg: "bg-teal-500/15", iconColor: "text-teal-400" };
  if (stepName.includes("complete") || stepName.includes("finish"))
    return { Icon: CheckCircle, bg: "bg-emerald-500/15", iconColor: "text-emerald-400" };
  return { Icon: Zap, bg: "bg-zinc-500/15", iconColor: "text-zinc-400" };
}

/** Format step detail for display — make it user-friendly */
function formatDetail(detail: string): string {
  // "Response from openai/gpt-4o: 494 tokens" → "AI processed · GPT-4o · 494 tokens"
  const llmMatch = detail.match(/Response from (\w+)\/([\w-]+): (\d+) tokens/);
  if (llmMatch) {
    const model = llmMatch[2].replace("gpt-4o", "GPT-4o").replace("claude-sonnet-4", "Claude Sonnet 4").replace("claude-opus-4", "Claude Opus 4");
    return `AI processed · ${model} · ${llmMatch[3]} tokens`;
  }
  // "Run finished: 3772 tokens, $0.0126" → "Completed · 3,772 tokens · $0.01"
  const finishMatch = detail.match(/Run finished: (\d+) tokens, \$([\d.]+)/);
  if (finishMatch) {
    return `Completed · ${parseInt(finishMatch[1]).toLocaleString()} tokens · $${parseFloat(finishMatch[2]).toFixed(3)}`;
  }
  return detail;
}

/** Calculate duration between two ISO timestamps */
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
      <div className="flex items-center gap-3 py-4">
        <Loader2 className="h-4 w-4 animate-spin text-lantern-400" />
        <span className="text-sm text-zinc-400">Agent is running...</span>
      </div>
    );
  }
  if (steps.length === 0) return null;

  return (
    <div>
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Execution Log</p>
      <div className="relative">
        {/* Vertical timeline line */}
        <div className="absolute left-[19px] top-5 bottom-5 w-px bg-zinc-800" />

        <div className="space-y-0">
          {steps.map((s, i) => {
            const done = s.status === "completed" || (isRunDone && s.status === "running");
            const running = s.status === "running" && !isRunDone;
            const failed = s.status === "error" || s.status === "failed";
            const visual = getStepVisual(s.step);
            const dur = stepDuration(s.ts, i > 0 ? steps[i - 1].ts : undefined);
            const isLast = i === steps.length - 1;

            return (
              <div key={i} className="relative flex items-start gap-3 py-2">
                {/* Icon node */}
                <div className={clsx(
                  "relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all",
                  done ? visual.bg : running ? "bg-lantern-500/15" : failed ? "bg-red-500/15" : "bg-zinc-800/50"
                )}>
                  {running ? (
                    <Loader2 className="h-4.5 w-4.5 animate-spin text-lantern-400" />
                  ) : failed ? (
                    <XCircle className="h-4.5 w-4.5 text-red-400" />
                  ) : (
                    <visual.Icon className={clsx("h-4.5 w-4.5", done ? visual.iconColor : "text-zinc-600")} />
                  )}
                </div>

                {/* Content */}
                <div className="flex flex-1 items-center gap-2 min-h-[40px] py-1.5">
                  <span className={clsx(
                    "text-[13px] leading-tight",
                    done ? "text-zinc-200" : running ? "text-zinc-300" : "text-zinc-500"
                  )}>
                    {formatDetail(s.detail)}
                  </span>

                  {/* Duration badge */}
                  {dur && done && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-zinc-500">
                      <Clock className="h-2.5 w-2.5" />
                      {dur}
                    </span>
                  )}

                  {/* Status indicator */}
                  <div className="ml-auto shrink-0">
                    {done && !isLast && (
                      <CheckCircle className="h-4 w-4 text-emerald-500" />
                    )}
                    {done && isLast && (
                      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/20">
                        <CheckCircle className="h-4 w-4 text-emerald-400" />
                      </div>
                    )}
                    {running && (
                      <div className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                    )}
                    {failed && (
                      <XCircle className="h-4 w-4 text-red-400" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Deduplicate steps — keep only the last status for each step name */
export function deduplicateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) return [];
  const stepMap = new Map<string, Step>();
  for (const s of raw as Step[]) {
    stepMap.set(s.step, s);
  }
  return Array.from(stepMap.values());
}
