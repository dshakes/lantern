// ---------------------------------------------------------------------------
// Sample workflow definitions for pre-populating the editor
// ---------------------------------------------------------------------------

import type { WorkflowDefinition } from "./workflow-types";
import type {
  TriggerData,
  AiStepData,
  ConditionData,
  LoopData,
  ToolData,
  ConnectorData,
  ApprovalData,
  EndData,
} from "./workflow-types";

// ---- Blank workflow --------------------------------------------------------

export const blankWorkflow: WorkflowDefinition = {
  metadata: {
    name: "blank",
    version: "0.1.0",
    description: "A blank workflow with just a trigger and end node.",
  },
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 100 },
      data: {
        label: "Manual Trigger",
        triggerKind: "manual",
      } as TriggerData,
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 400, y: 300 },
      data: {
        label: "End",
        outputExpression: "",
      } as EndData,
    },
  ],
  edges: [
    {
      id: "e-trigger-end",
      source: "trigger-1",
      target: "end-1",
    },
  ],
};

// ---- Research workflow ------------------------------------------------------

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

// ---- Chatbot workflow -------------------------------------------------------

export const chatbotWorkflow: WorkflowDefinition = {
  metadata: {
    name: "chatbot",
    version: "0.1.0",
    description:
      "WhatsApp chatbot that classifies intent, answers questions or searches for information.",
  },
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 50 },
      data: {
        label: "WhatsApp Trigger",
        triggerKind: "chat",
        surface: "whatsapp",
      } as TriggerData,
    },
    {
      id: "ai-1",
      type: "ai-step",
      position: { x: 400, y: 200 },
      data: {
        label: "Classify Intent",
        prompt:
          'Classify the user message into one of: "question", "search", "other".\n\nMessage: {{trigger.input.message}}\n\nReturn JSON: {"intent": "..."}',
        capability: "fast",
        temperature: 0.1,
        maxTokens: 256,
      } as AiStepData,
    },
    {
      id: "condition-1",
      type: "condition",
      position: { x: 400, y: 380 },
      data: {
        label: "Is Question?",
        expression: 'steps.ai-1.output.intent === "question"',
      } as ConditionData,
    },
    {
      id: "ai-2",
      type: "ai-step",
      position: { x: 200, y: 560 },
      data: {
        label: "Answer Question",
        prompt:
          "Answer the user's question concisely and helpfully.\n\nQuestion: {{trigger.input.message}}",
        capability: "reasoning-large",
        temperature: 0.5,
        maxTokens: 2048,
      } as AiStepData,
    },
    {
      id: "tool-1",
      type: "tool",
      position: { x: 600, y: 560 },
      data: {
        label: "Web Search",
        tool: "web.search",
        parameters: '{"query": "{{trigger.input.message}}"}',
      } as ToolData,
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 400, y: 740 },
      data: {
        label: "Send Response",
        outputExpression: "steps.ai-2.output || steps.tool-1.output",
      } as EndData,
    },
  ],
  edges: [
    {
      id: "e-trigger-classify",
      source: "trigger-1",
      target: "ai-1",
    },
    {
      id: "e-classify-condition",
      source: "ai-1",
      target: "condition-1",
    },
    {
      id: "e-condition-true",
      source: "condition-1",
      target: "ai-2",
      sourceHandle: "true",
      label: "true",
    },
    {
      id: "e-condition-false",
      source: "condition-1",
      target: "tool-1",
      sourceHandle: "false",
      label: "false",
    },
    {
      id: "e-answer-end",
      source: "ai-2",
      target: "end-1",
    },
    {
      id: "e-search-end",
      source: "tool-1",
      target: "end-1",
    },
  ],
};

// ---- Pipeline workflow ------------------------------------------------------

export const pipelineWorkflow: WorkflowDefinition = {
  metadata: {
    name: "pipeline",
    version: "0.1.0",
    description:
      "Scheduled data pipeline: fetches data, processes items in a loop, analyzes results, and posts to Slack.",
  },
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 50 },
      data: {
        label: "Scheduled Trigger",
        triggerKind: "schedule",
        cron: "0 9 * * MON-FRI",
      } as TriggerData,
    },
    {
      id: "tool-1",
      type: "tool",
      position: { x: 400, y: 200 },
      data: {
        label: "Fetch Data",
        tool: "web.search",
        parameters: '{"query": "latest industry reports", "maxResults": 10}',
      } as ToolData,
    },
    {
      id: "loop-1",
      type: "loop",
      position: { x: 400, y: 380 },
      data: {
        label: "Process Items",
        arrayExpression: "steps.tool-1.output.results",
        concurrency: 5,
      } as LoopData,
    },
    {
      id: "ai-1",
      type: "ai-step",
      position: { x: 400, y: 540 },
      data: {
        label: "Analyze Item",
        prompt:
          "Analyze the following data item and extract key insights, sentiment, and relevance score (0-1).\n\nItem: {{item}}",
        capability: "fast",
        temperature: 0.3,
        maxTokens: 1024,
      } as AiStepData,
    },
    {
      id: "connector-1",
      type: "connector",
      position: { x: 400, y: 720 },
      data: {
        label: "Post to Slack",
        connector: "slack",
        action: "post_message",
        inputMapping:
          '{"channel": "#data-pipeline", "text": "Daily report:\\n{{steps.loop-1.output}}"}',
      } as ConnectorData,
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 400, y: 880 },
      data: {
        label: "Done",
        outputExpression: "steps.loop-1.output",
      } as EndData,
    },
  ],
  edges: [
    {
      id: "e-trigger-fetch",
      source: "trigger-1",
      target: "tool-1",
    },
    {
      id: "e-fetch-loop",
      source: "tool-1",
      target: "loop-1",
    },
    {
      id: "e-loop-analyze",
      source: "loop-1",
      target: "ai-1",
      label: "each item",
    },
    {
      id: "e-analyze-slack",
      source: "ai-1",
      target: "connector-1",
    },
    {
      id: "e-slack-end",
      source: "connector-1",
      target: "end-1",
    },
  ],
};

// ---- Approval workflow ------------------------------------------------------

export const approvalWorkflow: WorkflowDefinition = {
  metadata: {
    name: "approval",
    version: "0.1.0",
    description:
      "Webhook-triggered deployment pipeline with AI risk analysis and manager approval for high-risk changes.",
  },
  nodes: [
    {
      id: "trigger-1",
      type: "trigger",
      position: { x: 400, y: 50 },
      data: {
        label: "Webhook Trigger",
        triggerKind: "webhook",
        webhookUrl: "https://api.lantern.dev/hooks/deploy",
      } as TriggerData,
    },
    {
      id: "ai-1",
      type: "ai-step",
      position: { x: 400, y: 200 },
      data: {
        label: "Analyze Risk",
        prompt:
          'Analyze the deployment request and assess risk level.\n\nChanges: {{trigger.input.changes}}\nEnvironment: {{trigger.input.environment}}\n\nReturn JSON: {"risk": "high" | "low", "reasons": [...]}',
        capability: "reasoning-large",
        temperature: 0.2,
        maxTokens: 1024,
      } as AiStepData,
    },
    {
      id: "condition-1",
      type: "condition",
      position: { x: 400, y: 380 },
      data: {
        label: "High Risk?",
        expression: 'steps.ai-1.output.risk === "high"',
      } as ConditionData,
    },
    {
      id: "approval-1",
      type: "approval",
      position: { x: 200, y: 560 },
      data: {
        label: "Manager Approval",
        approvers: "role:engineering-manager, role:tech-lead",
        timeoutMinutes: 120,
        reason:
          "High-risk deployment requires manager approval.\nRisk reasons: {{steps.ai-1.output.reasons}}",
      } as ApprovalData,
    },
    {
      id: "connector-1",
      type: "connector",
      position: { x: 400, y: 740 },
      data: {
        label: "Deploy",
        connector: "github",
        action: "create_pr",
        inputMapping:
          '{"repo": "{{trigger.input.repo}}", "branch": "{{trigger.input.branch}}", "title": "Deploy: {{trigger.input.description}}"}',
      } as ConnectorData,
    },
    {
      id: "end-1",
      type: "end",
      position: { x: 400, y: 900 },
      data: {
        label: "Deployment Complete",
        outputExpression: "steps.connector-1.output",
      } as EndData,
    },
  ],
  edges: [
    {
      id: "e-trigger-analyze",
      source: "trigger-1",
      target: "ai-1",
    },
    {
      id: "e-analyze-condition",
      source: "ai-1",
      target: "condition-1",
    },
    {
      id: "e-condition-true",
      source: "condition-1",
      target: "approval-1",
      sourceHandle: "true",
      label: "true",
    },
    {
      id: "e-condition-false",
      source: "condition-1",
      target: "connector-1",
      sourceHandle: "false",
      label: "false",
    },
    {
      id: "e-approval-deploy",
      source: "approval-1",
      target: "connector-1",
    },
    {
      id: "e-deploy-end",
      source: "connector-1",
      target: "end-1",
    },
  ],
};

// ---- Template metadata for the template picker ------------------------------

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  workflow: WorkflowDefinition;
  nodeTypes: string[]; // node types present, for mini-diagram rendering
}

export const workflowTemplates: WorkflowTemplate[] = [
  {
    id: "blank",
    name: "Start from Scratch",
    description: "A blank canvas with just a trigger and end node.",
    workflow: blankWorkflow,
    nodeTypes: ["trigger", "end"],
  },
  {
    id: "research",
    name: "Research Agent",
    description:
      "Search the web, synthesize findings, and produce structured reports.",
    workflow: researchAgentWorkflow,
    nodeTypes: ["trigger", "ai-step", "loop", "tool", "ai-step", "end"],
  },
  {
    id: "chatbot",
    name: "Chatbot",
    description:
      "Classify intent from a chat message, then answer or search.",
    workflow: chatbotWorkflow,
    nodeTypes: ["trigger", "ai-step", "condition", "ai-step", "tool", "end"],
  },
  {
    id: "pipeline",
    name: "Data Pipeline",
    description:
      "Scheduled data fetch, parallel processing, analysis, and Slack notification.",
    workflow: pipelineWorkflow,
    nodeTypes: ["trigger", "tool", "loop", "ai-step", "connector", "end"],
  },
  {
    id: "approval",
    name: "Approval Flow",
    description:
      "Webhook-triggered deployment with AI risk analysis and manager approval.",
    workflow: approvalWorkflow,
    nodeTypes: [
      "trigger",
      "ai-step",
      "condition",
      "approval",
      "connector",
      "end",
    ],
  },
];

// ---- Exports ---------------------------------------------------------------

export const sampleWorkflows: Record<string, WorkflowDefinition> = {
  "research-agent": researchAgentWorkflow,
};

export function getSampleWorkflow(
  agentName: string
): WorkflowDefinition | undefined {
  return sampleWorkflows[agentName];
}
