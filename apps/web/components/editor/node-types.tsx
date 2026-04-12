"use client";

import { memo, type ReactNode } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Zap,
  Brain,
  Wrench,
  GitBranch,
  Repeat,
  ShieldCheck,
  Plug,
  Bot,
  CircleStop,
} from "lucide-react";
import clsx from "clsx";
import type {
  TriggerData,
  AiStepData,
  ToolData,
  ConditionData,
  LoopData,
  ApprovalData,
  ConnectorData,
  SubagentData,
  EndData,
  NodeType,
} from "@/lib/workflow-types";

// ---- Icon map --------------------------------------------------------------

const iconMap: Record<NodeType, ReactNode> = {
  trigger: <Zap className="h-3.5 w-3.5" />,
  "ai-step": <Brain className="h-3.5 w-3.5" />,
  tool: <Wrench className="h-3.5 w-3.5" />,
  condition: <GitBranch className="h-3.5 w-3.5" />,
  loop: <Repeat className="h-3.5 w-3.5" />,
  approval: <ShieldCheck className="h-3.5 w-3.5" />,
  connector: <Plug className="h-3.5 w-3.5" />,
  subagent: <Bot className="h-3.5 w-3.5" />,
  end: <CircleStop className="h-3.5 w-3.5" />,
};

// ---- Color map (border + icon bg) ------------------------------------------

const colorMap: Record<
  NodeType,
  { border: string; iconBg: string; iconText: string; ring: string }
> = {
  trigger: {
    border: "border-l-emerald-500",
    iconBg: "bg-emerald-500/10",
    iconText: "text-emerald-400",
    ring: "ring-emerald-500/50",
  },
  "ai-step": {
    border: "border-l-indigo-500",
    iconBg: "bg-indigo-500/10",
    iconText: "text-indigo-400",
    ring: "ring-indigo-500/50",
  },
  tool: {
    border: "border-l-blue-500",
    iconBg: "bg-blue-500/10",
    iconText: "text-blue-400",
    ring: "ring-blue-500/50",
  },
  condition: {
    border: "border-l-yellow-500",
    iconBg: "bg-yellow-500/10",
    iconText: "text-yellow-400",
    ring: "ring-yellow-500/50",
  },
  loop: {
    border: "border-l-purple-500",
    iconBg: "bg-purple-500/10",
    iconText: "text-purple-400",
    ring: "ring-purple-500/50",
  },
  approval: {
    border: "border-l-red-500",
    iconBg: "bg-red-500/10",
    iconText: "text-red-400",
    ring: "ring-red-500/50",
  },
  connector: {
    border: "border-l-teal-500",
    iconBg: "bg-teal-500/10",
    iconText: "text-teal-400",
    ring: "ring-teal-500/50",
  },
  subagent: {
    border: "border-l-orange-500",
    iconBg: "bg-orange-500/10",
    iconText: "text-orange-400",
    ring: "ring-orange-500/50",
  },
  end: {
    border: "border-l-zinc-500",
    iconBg: "bg-zinc-500/10",
    iconText: "text-zinc-400",
    ring: "ring-zinc-500/50",
  },
};

// ---- Base node shell -------------------------------------------------------

function NodeShell({
  nodeType,
  label,
  selected,
  preview,
  children,
}: {
  nodeType: NodeType;
  label: string;
  selected: boolean;
  preview?: string;
  children?: ReactNode;
}) {
  const colors = colorMap[nodeType];
  const icon = iconMap[nodeType];

  return (
    <div
      className={clsx(
        "min-w-[200px] max-w-[260px] rounded-lg border border-zinc-700/80 border-l-[3px] bg-surface-1 shadow-lg shadow-black/20 transition-shadow",
        colors.border,
        selected && `ring-2 ${colors.ring}`
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div
          className={clsx(
            "flex h-6 w-6 items-center justify-center rounded-md",
            colors.iconBg,
            colors.iconText
          )}
        >
          {icon}
        </div>
        <span className="truncate text-xs font-medium text-zinc-200">
          {label}
        </span>
      </div>

      {/* Preview / body */}
      {(preview || children) && (
        <div className="border-t border-zinc-700/50 px-3 py-2">
          {preview && (
            <p className="truncate text-[11px] text-zinc-500">{preview}</p>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

// ---- Trigger node ----------------------------------------------------------

function TriggerNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as TriggerData;
  const kindLabels: Record<string, string> = {
    schedule: "Schedule",
    webhook: "Webhook",
    manual: "Manual",
    chat: "Chat surface",
  };
  const preview =
    d.triggerKind === "schedule" && d.cron
      ? `cron: ${d.cron}`
      : kindLabels[d.triggerKind] ?? d.triggerKind;

  return (
    <>
      <NodeShell
        nodeType="trigger"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- AI Step node ----------------------------------------------------------

function AiStepNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as AiStepData;
  const preview = d.prompt
    ? d.prompt.slice(0, 60) + (d.prompt.length > 60 ? "..." : "")
    : "No prompt set";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="ai-step"
        label={d.label}
        selected={!!selected}
        preview={preview}
      >
        <div className="mt-1 flex items-center gap-2">
          <span className="rounded bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400">
            {d.capability}
          </span>
          <span className="text-[10px] text-zinc-600">
            temp {d.temperature}
          </span>
        </div>
      </NodeShell>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- Tool node -------------------------------------------------------------

function ToolNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ToolData;
  const preview = d.tool || "No tool selected";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="tool"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- Condition node --------------------------------------------------------

function ConditionNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ConditionData;
  const preview = d.expression || "No condition set";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="condition"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="true"
        style={{ left: "30%" }}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-emerald-600 !bg-emerald-400"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        id="false"
        style={{ left: "70%" }}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-red-600 !bg-red-400"
      />
    </>
  );
}

// ---- Loop node -------------------------------------------------------------

function LoopNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as LoopData;
  const preview = d.arrayExpression
    ? `for each in ${d.arrayExpression}`
    : "No array expression";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="loop"
        label={d.label}
        selected={!!selected}
        preview={preview}
      >
        <span className="text-[10px] text-zinc-600">
          concurrency: {d.concurrency}
        </span>
      </NodeShell>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- Approval node ---------------------------------------------------------

function ApprovalNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ApprovalData;
  const preview = d.approvers
    ? `Approvers: ${d.approvers}`
    : "No approvers set";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="approval"
        label={d.label}
        selected={!!selected}
        preview={preview}
      >
        <span className="text-[10px] text-zinc-600">
          timeout: {d.timeoutMinutes}m
        </span>
      </NodeShell>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- Connector node --------------------------------------------------------

function ConnectorNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as ConnectorData;
  const preview =
    d.connector && d.action
      ? `${d.connector}.${d.action}`
      : d.connector || "No connector selected";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="connector"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- Subagent node ---------------------------------------------------------

function SubagentNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as SubagentData;
  const preview = d.agentName || "No agent selected";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="subagent"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
    </>
  );
}

// ---- End node --------------------------------------------------------------

function EndNodeComponent({ data, selected }: NodeProps) {
  const d = data as unknown as EndData;
  const preview = d.outputExpression || "No output";

  return (
    <>
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2.5 !w-2.5 !rounded-full !border-2 !border-zinc-600 !bg-zinc-400"
      />
      <NodeShell
        nodeType="end"
        label={d.label}
        selected={!!selected}
        preview={preview}
      />
    </>
  );
}

// ---- Exports ---------------------------------------------------------------

export const TriggerNode = memo(TriggerNodeComponent);
export const AiStepNode = memo(AiStepNodeComponent);
export const ToolNode = memo(ToolNodeComponent);
export const ConditionNode = memo(ConditionNodeComponent);
export const LoopNode = memo(LoopNodeComponent);
export const ApprovalNode = memo(ApprovalNodeComponent);
export const ConnectorNode = memo(ConnectorNodeComponent);
export const SubagentNode = memo(SubagentNodeComponent);
export const EndNode = memo(EndNodeComponent);

export const nodeTypes = {
  trigger: TriggerNode,
  "ai-step": AiStepNode,
  tool: ToolNode,
  condition: ConditionNode,
  loop: LoopNode,
  approval: ApprovalNode,
  connector: ConnectorNode,
  subagent: SubagentNode,
  end: EndNode,
};
