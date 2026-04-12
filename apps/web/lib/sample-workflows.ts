// ---------------------------------------------------------------------------
// Sample workflow definitions for pre-populating the editor
// ---------------------------------------------------------------------------

import type { WorkflowDefinition } from "./workflow-types";
import type {
  TriggerData,
  AiStepData,
  LoopData,
  ToolData,
  EndData,
} from "./workflow-types";

export const researchAgentWorkflow: WorkflowDefinition = {
  metadata: {
    name: "research-agent",
    version: "0.1.0",
    description:
      "Searches the web, synthesizes findings, and produces structured research reports with citations.",
  },
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 50 },
      data: {
        label: "Manual Trigger",
        triggerKind: "manual",
      } as TriggerData,
    },
    {
      id: "ai-1",
      type: "ai-step",
      position: { x: 400, y: 200 },
      data: {
        label: "Generate Queries",
        prompt:
          "Given the research topic: {{trigger.input.query}}\n\nGenerate 3-5 specific search queries that would cover different angles of this topic. Return as a JSON array of strings.",
        capability: "reasoning-large",
        temperature: 0.7,
        maxTokens: 1024,
      } as AiStepData,
    },
    {
      id: "loop-1",
      type: "loop",
      position: { x: 400, y: 380 },
      data: {
        label: "Search Each Query",
        arrayExpression: "steps.ai-1.output.queries",
        concurrency: 3,
      } as LoopData,
    },
    {
      id: "tool-1",
      type: "tool",
      position: { x: 400, y: 530 },
      data: {
        label: "Web Search",
        tool: "web.search",
        parameters: '{"query": "{{item}}", "maxResults": 5}',
      } as ToolData,
    },
    {
      id: "ai-2",
      type: "ai-step",
      position: { x: 400, y: 700 },
      data: {
        label: "Synthesize Results",
        prompt:
          "You are a research analyst. Synthesize the following search results into a comprehensive research report with sections, citations, and an executive summary.\n\nSearch results:\n{{steps.loop-1.output}}\n\nTopic: {{trigger.input.query}}",
        capability: "reasoning-large",
        temperature: 0.3,
        maxTokens: 4096,
      } as AiStepData,
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 400, y: 880 },
      data: {
        label: "Return Report",
        outputExpression: "steps.ai-2.output",
      } as EndData,
    },
  ],
  edges: [
    {
      id: "e-trigger-ai1",
      source: "trigger-1",
      target: "ai-1",
    },
    {
      id: "e-ai1-loop",
      source: "ai-1",
      target: "loop-1",
    },
    {
      id: "e-loop-tool",
      source: "loop-1",
      target: "tool-1",
      label: "each query",
    },
    {
      id: "e-tool-ai2",
      source: "tool-1",
      target: "ai-2",
    },
    {
      id: "e-ai2-end",
      source: "ai-2",
      target: "end-1",
    },
  ],
};

export const sampleWorkflows: Record<string, WorkflowDefinition> = {
  "research-agent": researchAgentWorkflow,
};

export function getSampleWorkflow(
  agentName: string
): WorkflowDefinition | undefined {
  return sampleWorkflows[agentName];
}
