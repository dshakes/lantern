// ---------------------------------------------------------------------------
// Workflow type definitions — shared between editor, compiler, and API layer
// ---------------------------------------------------------------------------

export type NodeType =
  | "trigger"
  | "ai-step"
  | "tool"
  | "condition"
  | "loop"
  | "approval"
  | "connector"
  | "subagent"
  | "end";

// ---- Per-node data payloads ------------------------------------------------

export interface TriggerData {
  label: string;
  triggerKind: "schedule" | "webhook" | "manual" | "chat";
  cron?: string;
  webhookUrl?: string;
  surface?: string;
}

export interface AiStepData {
  label: string;
  prompt: string;
  capability: "auto" | "reasoning-large" | "reasoning-small" | "fast" | "code";
  temperature: number;
  maxTokens: number;
}

export interface ToolData {
  label: string;
  tool: "web.search" | "python.exec" | "fs.read" | "fs.write" | "";
  parameters: string;
}

export interface ConditionData {
  label: string;
  expression: string;
}

export interface LoopData {
  label: string;
  arrayExpression: string;
  concurrency: number;
}

export interface ApprovalData {
  label: string;
  approvers: string;
  timeoutMinutes: number;
  reason: string;
}

export interface ConnectorData {
  label: string;
  connector: "gmail" | "slack" | "github" | "linear" | "notion" | "stripe" | "";
  action: string;
  inputMapping: string;
}

export interface SubagentData {
  label: string;
  agentName: string;
  inputMapping: string;
}

export interface EndData {
  label: string;
  outputExpression: string;
}

export type NodeData =
  | TriggerData
  | AiStepData
  | ToolData
  | ConditionData
  | LoopData
  | ApprovalData
  | ConnectorData
  | SubagentData
  | EndData;

// ---- Graph primitives ------------------------------------------------------

export interface WorkflowNode {
  id: string;
  type: NodeType;
  position: { x: number; y: number };
  data: NodeData;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  label?: string;
}

export interface WorkflowMetadata {
  name: string;
  version: string;
  description: string;
}

export interface WorkflowDefinition {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  metadata: WorkflowMetadata;
}

// ---- Node config per type (for palette & defaults) -------------------------

export interface NodeTypeConfig {
  type: NodeType;
  label: string;
  icon: string; // lucide icon name
  color: string; // tailwind border color token
  category: "Triggers" | "AI" | "Tools" | "Logic" | "Integration";
  defaultData: NodeData;
}

export const NODE_TYPE_CONFIGS: NodeTypeConfig[] = [
  {
    type: "trigger",
    label: "Trigger",
    icon: "Zap",
    color: "emerald",
    category: "Triggers",
    defaultData: {
      label: "Trigger",
      triggerKind: "manual",
    } as TriggerData,
  },
  {
    type: "ai-step",
    label: "AI Step",
    icon: "Brain",
    color: "indigo",
    category: "AI",
    defaultData: {
      label: "AI Step",
      prompt: "",
      capability: "auto",
      temperature: 0.7,
      maxTokens: 2048,
    } as AiStepData,
  },
  {
    type: "tool",
    label: "Tool",
    icon: "Wrench",
    color: "blue",
    category: "Tools",
    defaultData: {
      label: "Tool",
      tool: "",
      parameters: "{}",
    } as ToolData,
  },
  {
    type: "condition",
    label: "Condition",
    icon: "GitBranch",
    color: "yellow",
    category: "Logic",
    defaultData: {
      label: "Condition",
      expression: "",
    } as ConditionData,
  },
  {
    type: "loop",
    label: "Loop",
    icon: "Repeat",
    color: "purple",
    category: "Logic",
    defaultData: {
      label: "Loop",
      arrayExpression: "",
      concurrency: 1,
    } as LoopData,
  },
  {
    type: "approval",
    label: "Approval",
    icon: "ShieldCheck",
    color: "red",
    category: "Logic",
    defaultData: {
      label: "Approval",
      approvers: "",
      timeoutMinutes: 60,
      reason: "",
    } as ApprovalData,
  },
  {
    type: "connector",
    label: "Connector",
    icon: "Plug",
    color: "teal",
    category: "Integration",
    defaultData: {
      label: "Connector",
      connector: "",
      action: "",
      inputMapping: "{}",
    } as ConnectorData,
  },
  {
    type: "subagent",
    label: "Sub-agent",
    icon: "Bot",
    color: "orange",
    category: "Integration",
    defaultData: {
      label: "Sub-agent",
      agentName: "",
      inputMapping: "{}",
    } as SubagentData,
  },
  {
    type: "end",
    label: "End",
    icon: "CircleStop",
    color: "gray",
    category: "Logic",
    defaultData: {
      label: "End",
      outputExpression: "",
    } as EndData,
  },
];

export function getNodeTypeConfig(type: NodeType): NodeTypeConfig {
  return NODE_TYPE_CONFIGS.find((c) => c.type === type)!;
}
