"use client";

import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
  ConnectionLineType,
  MarkerType,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { nodeTypes } from "./node-types";
import { NodePalette } from "./node-palette";
import { PropertiesPanel } from "./properties-panel";
import { Toolbar } from "./toolbar";
import { EditorMinimap } from "./minimap";
import { Map, EyeOff } from "lucide-react";

import type {
  WorkflowDefinition,
  NodeType,
  NodeData,
} from "@/lib/workflow-types";
import { getNodeTypeConfig } from "@/lib/workflow-types";

// ---- Helpers ---------------------------------------------------------------

let nodeIdCounter = 0;
function generateNodeId(): string {
  nodeIdCounter += 1;
  return `node-${Date.now()}-${nodeIdCounter}`;
}

function workflowToReactFlowNodes(def: WorkflowDefinition): Node[] {
  return def.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position,
    data: { ...n.data } as unknown as Record<string, unknown>,
    selected: false,
  }));
}

function workflowToReactFlowEdges(def: WorkflowDefinition): Edge[] {
  return def.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    label: e.label,
    type: "smoothstep",
    animated: false,
    style: { stroke: "#52525b", strokeWidth: 2 },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#52525b",
      width: 16,
      height: 16,
    },
  }));
}

// ---- Connection validation -------------------------------------------------

const validTargetTypes: Record<NodeType, NodeType[]> = {
  trigger: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  "ai-step": [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  tool: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  condition: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  loop: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  approval: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  connector: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  subagent: [
    "ai-step",
    "tool",
    "condition",
    "loop",
    "approval",
    "connector",
    "subagent",
    "end",
  ],
  end: [], // End nodes cannot connect to anything
};

// ---- Main component --------------------------------------------------------

interface EditorCanvasProps {
  agentName: string;
  initialWorkflow: WorkflowDefinition;
}

export function EditorCanvas({
  agentName,
  initialWorkflow,
}: EditorCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [rfInstance, setRfInstance] = useState<ReactFlowInstance | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState(
    workflowToReactFlowNodes(initialWorkflow)
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    workflowToReactFlowEdges(initialWorkflow)
  );

  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [minimapVisible, setMinimapVisible] = useState(true);

  // ---- Connection handling --------------------------------------------------

  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source);
      const targetNode = nodes.find((n) => n.id === connection.target);
      if (!sourceNode || !targetNode) return false;
      if (connection.source === connection.target) return false;

      const sourceType = sourceNode.type as NodeType;
      const targetType = targetNode.type as NodeType;

      // Target cannot be a trigger (triggers are entry points)
      if (targetType === "trigger") return false;

      return validTargetTypes[sourceType]?.includes(targetType) ?? false;
    },
    [nodes]
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: Edge = {
        ...connection,
        id: `e-${connection.source}-${connection.target}-${Date.now()}`,
        type: "smoothstep",
        animated: false,
        style: { stroke: "#52525b", strokeWidth: 2 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: "#52525b",
          width: 16,
          height: 16,
        },
      } as Edge;

      setEdges((eds) => addEdge(newEdge, eds));
    },
    [setEdges]
  );

  // ---- Drag & drop from palette --------------------------------------------

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData(
        "application/reactflow-type"
      ) as NodeType;
      if (!type) return;

      const config = getNodeTypeConfig(type);
      if (!config || !rfInstance || !reactFlowWrapper.current) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = rfInstance.screenToFlowPosition({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      // Snap to 20px grid
      position.x = Math.round(position.x / 20) * 20;
      position.y = Math.round(position.y / 20) * 20;

      const newNode: Node = {
        id: generateNodeId(),
        type,
        position,
        data: { ...config.defaultData } as unknown as Record<string, unknown>,
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [rfInstance, setNodes]
  );

  // ---- Node selection -------------------------------------------------------

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setSelectedNode(node);
    },
    []
  );

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // Keep selectedNode in sync with actual node data
  const actualSelectedNode = selectedNode
    ? nodes.find((n) => n.id === selectedNode.id) ?? null
    : null;

  // ---- Save / Deploy / Test handlers ----------------------------------------

  const handleSave = useCallback(() => {
    // In production this would persist via gRPC to control-plane
    if (rfInstance) {
      const flow = rfInstance.toObject();
      // eslint-disable-next-line no-console
      console.log("[editor] Saved workflow:", flow);
    }
  }, [rfInstance]);

  const handleDeploy = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log("[editor] Deploy triggered for", agentName);
  }, [agentName]);

  const handleTestRun = useCallback(() => {
    // eslint-disable-next-line no-console
    console.log("[editor] Test run triggered for", agentName);
  }, [agentName]);

  // ---- Render ---------------------------------------------------------------

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <Toolbar
        agentName={agentName}
        onSave={handleSave}
        onDeploy={handleDeploy}
        onTestRun={handleTestRun}
      />
      <div className="flex flex-1 overflow-hidden">
        <NodePalette />
        <div ref={reactFlowWrapper} className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setRfInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            isValidConnection={isValidConnection}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: "#6e5dce", strokeWidth: 2 }}
            snapToGrid
            snapGrid={[20, 20]}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
              type: "smoothstep",
              style: { stroke: "#52525b", strokeWidth: 2 },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: "#52525b",
                width: 16,
                height: 16,
              },
            }}
            proOptions={{ hideAttribution: true }}
            className="editor-canvas"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1}
              color="#27272a"
            />
            <Controls
              showInteractive={false}
              className="editor-controls"
            />
            <EditorMinimap visible={minimapVisible} />

            {/* Bottom bar: minimap toggle */}
            <Panel position="bottom-right" className="!m-3">
              <button
                onClick={() => setMinimapVisible((v) => !v)}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-surface-1 px-3 text-xs font-medium text-zinc-400 shadow-lg transition-colors hover:bg-surface-3 hover:text-zinc-200"
              >
                {minimapVisible ? (
                  <>
                    <EyeOff className="h-3 w-3" />
                    Hide Map
                  </>
                ) : (
                  <>
                    <Map className="h-3 w-3" />
                    Show Map
                  </>
                )}
              </button>
            </Panel>
          </ReactFlow>
        </div>
        <PropertiesPanel
          selectedNode={actualSelectedNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>
    </div>
  );
}
