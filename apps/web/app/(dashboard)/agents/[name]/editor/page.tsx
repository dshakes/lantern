"use client";

import { useParams } from "next/navigation";
import { ReactFlowProvider } from "@xyflow/react";
import { EditorCanvas } from "@/components/editor/editor-canvas";
import { getSampleWorkflow } from "@/lib/sample-workflows";
import type { WorkflowDefinition } from "@/lib/workflow-types";

const emptyWorkflow = (name: string): WorkflowDefinition => ({
  metadata: { name, version: "0.1.0", description: "" },
  nodes: [],
  edges: [],
});

export default function EditorPage() {
  const params = useParams();
  const name = params.name as string;

  const workflow = getSampleWorkflow(name) ?? emptyWorkflow(name);

  return (
    <ReactFlowProvider>
      <EditorCanvas agentName={name} initialWorkflow={workflow} />
    </ReactFlowProvider>
  );
}
