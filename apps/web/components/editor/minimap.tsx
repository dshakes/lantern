"use client";

import { MiniMap as ReactFlowMiniMap } from "@xyflow/react";
import type { NodeType } from "@/lib/workflow-types";

const nodeColorMap: Record<NodeType, string> = {
  trigger: "#10b981",
  "ai-step": "#6366f1",
  tool: "#3b82f6",
  condition: "#eab308",
  loop: "#a855f7",
  approval: "#ef4444",
  connector: "#14b8a6",
  subagent: "#f97316",
  end: "#71717a",
};

function getNodeColor(node: { type?: string }): string {
  return nodeColorMap[(node.type ?? "end") as NodeType] ?? "#71717a";
}

export function EditorMinimap({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <ReactFlowMiniMap
      nodeColor={getNodeColor}
      maskColor="rgba(9, 9, 11, 0.7)"
      style={{
        backgroundColor: "#18181b",
        border: "1px solid #27272a",
        borderRadius: 8,
      }}
      pannable
      zoomable
    />
  );
}
