// ---------------------------------------------------------------------------
// workflow-compiler.ts — Compile a visual workflow into a Lantern agent config
//
// Converts the React Flow graph into an agent.yaml + step sequence that the
// SDK understands. This is the "code = visual" bridge described in
// docs/architecture/14-visual-builder.md.
// ---------------------------------------------------------------------------

import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowEdge,
  NodeType,
  TriggerData,
  AiStepData,
  ToolData,
  ConditionData,
  LoopData,
  ApprovalData,
  ConnectorData,
  SubagentData,
  EndData,
} from "./workflow-types";

// ---- Output types ----------------------------------------------------------

export interface AgentYaml {
  name: string;
  version: string;
  description: string;
  triggers: AgentTrigger[];
  steps: AgentStep[];
}

export interface AgentTrigger {
  kind: string;
  config: Record<string, unknown>;
}

export interface AgentStep {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  next?: string | { true: string; false: string };
}

// ---- Compilation -----------------------------------------------------------

/**
 * Topologically sort workflow nodes starting from trigger nodes, following edges.
 */
function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    adjacency.set(node.id, []);
    inDegree.set(node.id, 0);
  }

  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  // Start with nodes that have no incoming edges (triggers)
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  return sorted.map((id) => nodeMap.get(id)!).filter(Boolean);
}

/**
 * Build a map from source node id (+ optional handle) to target node id.
 */
function buildNextMap(
  edges: WorkflowEdge[]
): Map<string, string | { true: string; false: string }> {
  const grouped = new Map<string, WorkflowEdge[]>();
  for (const edge of edges) {
    const list = grouped.get(edge.source) ?? [];
    list.push(edge);
    grouped.set(edge.source, list);
  }

  const nextMap = new Map<string, string | { true: string; false: string }>();

  for (const [source, sourceEdges] of grouped) {
    if (sourceEdges.length === 1) {
      nextMap.set(source, sourceEdges[0].target);
    } else {
      // Condition node: edges labeled "true" / "false"
      const trueEdge = sourceEdges.find(
        (e) => e.sourceHandle === "true" || e.label === "true"
      );
      const falseEdge = sourceEdges.find(
        (e) => e.sourceHandle === "false" || e.label === "false"
      );
      if (trueEdge && falseEdge) {
        nextMap.set(source, {
          true: trueEdge.target,
          false: falseEdge.target,
        });
      } else {
        // Fallback: just use first
        nextMap.set(source, sourceEdges[0].target);
      }
    }
  }

  return nextMap;
}

function compileTrigger(data: TriggerData): AgentTrigger {
  const config: Record<string, unknown> = { kind: data.triggerKind };
  if (data.triggerKind === "schedule" && data.cron) {
    config.cron = data.cron;
  }
  if (data.triggerKind === "webhook" && data.webhookUrl) {
    config.url = data.webhookUrl;
  }
  if (data.triggerKind === "chat" && data.surface) {
    config.surface = data.surface;
  }
  return { kind: data.triggerKind, config };
}

function compileStep(
  node: WorkflowNode,
  next: string | { true: string; false: string } | undefined
): AgentStep | null {
  const base: AgentStep = {
    id: node.id,
    kind: node.type,
    config: {},
    next,
  };

  switch (node.type) {
    case "ai-step": {
      const d = node.data as AiStepData;
      base.config = {
        prompt: d.prompt,
        capability: d.capability,
        temperature: d.temperature,
        maxTokens: d.maxTokens,
      };
      break;
    }
    case "tool": {
      const d = node.data as ToolData;
      base.config = {
        tool: d.tool,
        parameters: safeJsonParse(d.parameters),
      };
      break;
    }
    case "condition": {
      const d = node.data as ConditionData;
      base.config = { expression: d.expression };
      break;
    }
    case "loop": {
      const d = node.data as LoopData;
      base.config = {
        array: d.arrayExpression,
        concurrency: d.concurrency,
      };
      break;
    }
    case "approval": {
      const d = node.data as ApprovalData;
      base.config = {
        approvers: d.approvers
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        timeoutMinutes: d.timeoutMinutes,
        reason: d.reason,
      };
      break;
    }
    case "connector": {
      const d = node.data as ConnectorData;
      base.config = {
        connector: d.connector,
        action: d.action,
        input: safeJsonParse(d.inputMapping),
      };
      break;
    }
    case "subagent": {
      const d = node.data as SubagentData;
      base.config = {
        agent: d.agentName,
        input: safeJsonParse(d.inputMapping),
      };
      break;
    }
    case "end": {
      const d = node.data as EndData;
      base.config = { output: d.outputExpression };
      break;
    }
    case "trigger":
      // Triggers are compiled separately
      return null;
    default:
      break;
  }

  return base;
}

function safeJsonParse(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// ---- Public API ------------------------------------------------------------

export function compileWorkflow(definition: WorkflowDefinition): AgentYaml {
  const sorted = topologicalSort(definition.nodes, definition.edges);
  const nextMap = buildNextMap(definition.edges);

  const triggers: AgentTrigger[] = [];
  const steps: AgentStep[] = [];

  for (const node of sorted) {
    if (node.type === "trigger") {
      triggers.push(compileTrigger(node.data as TriggerData));
      continue;
    }

    const step = compileStep(node, nextMap.get(node.id));
    if (step) steps.push(step);
  }

  return {
    name: definition.metadata.name,
    version: definition.metadata.version,
    description: definition.metadata.description,
    triggers,
    steps,
  };
}

/**
 * Serialize the compiled agent config as YAML-like text (simplified).
 * In production this would use a proper YAML serializer.
 */
export function compileToYamlString(definition: WorkflowDefinition): string {
  const config = compileWorkflow(definition);
  return JSON.stringify(config, null, 2);
}
