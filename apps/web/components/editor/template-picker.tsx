"use client";

import {
  Zap,
  Brain,
  Wrench,
  GitBranch,
  Repeat,
  ShieldCheck,
  Plug,
  CircleStop,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import clsx from "clsx";
import type { WorkflowTemplate } from "@/lib/sample-workflows";

// ---- Node type icon + color maps -------------------------------------------

const iconMap: Record<string, LucideIcon> = {
  trigger: Zap,
  "ai-step": Brain,
  tool: Wrench,
  condition: GitBranch,
  loop: Repeat,
  approval: ShieldCheck,
  connector: Plug,
  end: CircleStop,
};

const dotColorMap: Record<string, string> = {
  trigger: "bg-emerald-400",
  "ai-step": "bg-indigo-400",
  tool: "bg-blue-400",
  condition: "bg-yellow-400",
  loop: "bg-purple-400",
  approval: "bg-red-400",
  connector: "bg-teal-400",
  end: "bg-zinc-400",
};

// ---- Mini diagram component -------------------------------------------------

function MiniDiagram({ nodeTypes }: { nodeTypes: string[] }) {
  return (
    <div className="flex items-center gap-1.5 py-3">
      {nodeTypes.map((type, i) => {
        const Icon = iconMap[type];
        return (
          <div key={`${type}-${i}`} className="flex items-center gap-1.5">
            <div
              className={clsx(
                "flex h-6 w-6 items-center justify-center rounded",
                dotColorMap[type]
                  ? `${dotColorMap[type].replace("bg-", "bg-").replace("400", "500/20")}`
                  : "bg-zinc-500/20"
              )}
            >
              {Icon && (
                <Icon
                  className={clsx(
                    "h-3 w-3",
                    dotColorMap[type]
                      ? dotColorMap[type].replace("bg-", "text-")
                      : "text-zinc-400"
                  )}
                />
              )}
            </div>
            {i < nodeTypes.length - 1 && (
              <ArrowRight className="h-3 w-3 text-zinc-600" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---- Template card ----------------------------------------------------------

function TemplateCard({
  template,
  onSelect,
}: {
  template: WorkflowTemplate;
  onSelect: (template: WorkflowTemplate) => void;
}) {
  return (
    <button
      onClick={() => onSelect(template)}
      className={clsx(
        "flex flex-col items-start rounded-xl border p-4 text-left transition-all",
        "border-zinc-700/80 bg-surface-1 hover:border-zinc-600 hover:bg-surface-2",
        "focus:outline-none focus:ring-2 focus:ring-lantern-500/50"
      )}
    >
      <MiniDiagram nodeTypes={template.nodeTypes} />
      <h3 className="mt-2 text-sm font-semibold text-zinc-200">
        {template.name}
      </h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        {template.description}
      </p>
    </button>
  );
}

// ---- Main component ---------------------------------------------------------

interface TemplatePickerProps {
  templates: WorkflowTemplate[];
  onSelect: (template: WorkflowTemplate) => void;
}

export function TemplatePicker({ templates, onSelect }: TemplatePickerProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-surface-0 p-8">
      <div className="w-full max-w-3xl">
        <h1 className="text-xl font-bold text-zinc-100">
          Choose a template
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          Pick a starting point for your workflow, or start from scratch.
        </p>
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onSelect={onSelect}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
