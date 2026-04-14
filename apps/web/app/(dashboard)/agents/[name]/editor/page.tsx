"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { EditorCanvas } from "@/components/editor/editor-canvas";
import { TemplatePicker } from "@/components/editor/template-picker";
import { getSampleWorkflow, workflowTemplates } from "@/lib/sample-workflows";
import { api } from "@/lib/api";
import type { WorkflowDefinition, WorkflowNode, WorkflowEdge } from "@/lib/workflow-types";
import type { WorkflowTemplate } from "@/lib/sample-workflows";

/** Build a basic workflow from an agent's stored prompt */
function buildWorkflowFromAgent(agentName: string): WorkflowDefinition | null {
  // Check localStorage for agent prompt and settings
  const promptsRaw = typeof window !== "undefined" ? localStorage.getItem("lantern_agent_prompts") : null;
  const prompts = promptsRaw ? JSON.parse(promptsRaw) : {};
  const prompt = prompts[agentName];
  if (!prompt) return null;

  const settingsRaw = typeof window !== "undefined" ? localStorage.getItem(`lantern_agent_settings_${agentName}`) : null;
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};

  const isEmailAgent = agentName.toLowerCase().includes("email") || agentName.toLowerCase().includes("gmail");
  const hasSchedule = settings.cron && settings.cron.length > 0;

  // Build nodes based on what we know about the agent
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let y = 0;

  // Trigger node
  const triggerId = "trigger-1";
  nodes.push({
    id: triggerId,
    type: "trigger",
    position: { x: 300, y },
    data: {
      label: hasSchedule ? "Scheduled Trigger" : "Manual Trigger",
      triggerKind: hasSchedule ? "schedule" as const : "manual" as const,
      cron: hasSchedule ? settings.cron : undefined,
    },
  });
  y += 150;

  // If email agent, add a fetch-emails step
  let lastNodeId = triggerId;
  if (isEmailAgent) {
    const fetchId = "tool-fetch-emails";
    nodes.push({
      id: fetchId,
      type: "tool",
      position: { x: 300, y },
      data: { label: "Fetch Emails", tool: "" as any, parameters: JSON.stringify({ connector: "gmail", action: "list_messages", limit: 20 }, null, 2) },
    });
    edges.push({ id: `e-${lastNodeId}-${fetchId}`, source: lastNodeId, target: fetchId });
    lastNodeId = fetchId;
    y += 150;
  }

  // AI processing step (uses the system prompt)
  const aiId = "ai-process";
  const truncatedPrompt = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
  nodes.push({
    id: aiId,
    type: "ai-step",
    position: { x: 300, y },
    data: {
      label: "Process with AI",
      capability: "auto" as const,
      prompt: prompt,
      temperature: 1.0,
      maxTokens: settings.maxTokens || 4096,
    },
  });
  edges.push({ id: `e-${lastNodeId}-${aiId}`, source: lastNodeId, target: aiId });
  lastNodeId = aiId;
  y += 150;

  // If email delivery is configured, add a send step
  if (settings.deliveryEmail) {
    const sendId = "connector-send-email";
    nodes.push({
      id: sendId,
      type: "connector",
      position: { x: 300, y },
      data: { label: "Send Email", connector: "gmail", action: "send_message" } as any,
    });
    edges.push({ id: `e-${lastNodeId}-${sendId}`, source: lastNodeId, target: sendId });
    lastNodeId = sendId;
    y += 150;
  }

  // End node
  const endId = "end-1";
  nodes.push({
    id: endId,
    type: "end",
    position: { x: 300, y },
    data: { label: "Output", expression: "" } as any,
  });
  edges.push({ id: `e-${lastNodeId}-${endId}`, source: lastNodeId, target: endId });

  return {
    nodes,
    edges,
    metadata: { name: agentName, version: "0.1.0", description: `Workflow for ${agentName}` },
  };
}

export default function EditorPage() {
  const params = useParams();
  const name = params.name as string;

  // Try to load: 1) sample workflow, 2) workflow from agent config, 3) null (show picker)
  const [selectedWorkflow, setSelectedWorkflow] = useState<WorkflowDefinition | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function loadWorkflow() {
      // 1) Try loading from backend API
      try {
        const backendWorkflow = await api.getWorkflow(name);
        if (backendWorkflow && typeof backendWorkflow === "object" && "nodes" in (backendWorkflow as Record<string, unknown>)) {
          setSelectedWorkflow(backendWorkflow as WorkflowDefinition);
          setLoaded(true);
          return;
        }
      } catch {
        // Backend unavailable, continue to fallbacks
      }

      // 2) Try loading from localStorage
      try {
        const localRaw = typeof window !== "undefined" ? localStorage.getItem(`lantern_workflow_${name}`) : null;
        if (localRaw) {
          const localWorkflow = JSON.parse(localRaw) as WorkflowDefinition;
          if (localWorkflow.nodes && localWorkflow.nodes.length > 0) {
            setSelectedWorkflow(localWorkflow);
            setLoaded(true);
            return;
          }
        }
      } catch {
        // Invalid localStorage data, continue
      }

      // 3) Try sample workflow
      const sample = getSampleWorkflow(name);
      if (sample) {
        setSelectedWorkflow(sample);
      } else {
        // 4) Generate from agent config
        const generated = buildWorkflowFromAgent(name);
        if (generated) {
          setSelectedWorkflow(generated);
        }
      }
      setLoaded(true);
    }
    loadWorkflow();
  }, [name]);

  function handleTemplateSelect(template: WorkflowTemplate) {
    const workflow: WorkflowDefinition = {
      ...template.workflow,
      metadata: { ...template.workflow.metadata, name },
    };
    setSelectedWorkflow(workflow);
  }

  if (!loaded) return null;

  // Show template picker only if no workflow could be generated
  if (!selectedWorkflow) {
    return (
      <TemplatePicker
        templates={workflowTemplates}
        onSelect={handleTemplateSelect}
      />
    );
  }

  return (
    <ReactFlowProvider>
      <EditorCanvas agentName={name} initialWorkflow={selectedWorkflow} />
    </ReactFlowProvider>
  );
}
