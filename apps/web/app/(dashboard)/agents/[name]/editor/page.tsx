"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { EditorCanvas } from "@/components/editor/editor-canvas";
import { TemplatePicker } from "@/components/editor/template-picker";
import { getSampleWorkflow, workflowTemplates } from "@/lib/sample-workflows";
import type { WorkflowDefinition } from "@/lib/workflow-types";
import type { WorkflowTemplate } from "@/lib/sample-workflows";

export default function EditorPage() {
  const params = useParams();
  const name = params.name as string;

  // If the agent has an existing sample workflow, load it directly.
  const existingWorkflow = getSampleWorkflow(name);

  const [selectedWorkflow, setSelectedWorkflow] =
    useState<WorkflowDefinition | null>(existingWorkflow ?? null);

  function handleTemplateSelect(template: WorkflowTemplate) {
    // Clone the template workflow and set the agent name
    const workflow: WorkflowDefinition = {
      ...template.workflow,
      metadata: {
        ...template.workflow.metadata,
        name,
      },
    };
    setSelectedWorkflow(workflow);
  }

  // Show template picker if no workflow is loaded yet
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
