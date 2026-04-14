"use client";

import {
  useCallback,
  useEffect,
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
import { ExportCodeModal } from "./export-code-modal";
import { DeployModal } from "./deploy-modal";
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

// ---- Undo/Redo history -----------------------------------------------------

interface HistorySnapshot {
  nodes: Node[];
  edges: Edge[];
}

function useUndoRedo(initialNodes: Node[], initialEdges: Edge[]) {
  const historyRef = useRef<HistorySnapshot[]>([
    { nodes: structuredClone(initialNodes), edges: structuredClone(initialEdges) },
  ]);
  const pointerRef = useRef(0);

  const pushSnapshot = useCallback((nodes: Node[], edges: Edge[]) => {
    // Discard any forward history when a new action is taken
    historyRef.current = historyRef.current.slice(0, pointerRef.current + 1);
    historyRef.current.push({
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
    });
    // Keep history bounded to 50 entries
    if (historyRef.current.length > 50) {
      historyRef.current.shift();
    } else {
      pointerRef.current += 1;
    }
  }, []);

  const undo = useCallback((): HistorySnapshot | null => {
    if (pointerRef.current <= 0) return null;
    pointerRef.current -= 1;
    return structuredClone(historyRef.current[pointerRef.current]);
  }, []);

  const redo = useCallback((): HistorySnapshot | null => {
    if (pointerRef.current >= historyRef.current.length - 1) return null;
    pointerRef.current += 1;
    return structuredClone(historyRef.current[pointerRef.current]);
  }, []);

  const canUndo = useCallback(() => pointerRef.current > 0, []);
  const canRedo = useCallback(
    () => pointerRef.current < historyRef.current.length - 1,
    []
  );

  return { pushSnapshot, undo, redo, canUndo, canRedo };
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

  const initialRfNodes = workflowToReactFlowNodes(initialWorkflow);
  const initialRfEdges = workflowToReactFlowEdges(initialWorkflow);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialRfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialRfEdges);

  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [minimapVisible, setMinimapVisible] = useState(true);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [deployModalOpen, setDeployModalOpen] = useState(false);

  // Track undo/redo eligibility for re-render
  const [undoRedoTick, setUndoRedoTick] = useState(0);

  // Undo/redo
  const { pushSnapshot, undo, redo, canUndo, canRedo } = useUndoRedo(
    initialRfNodes,
    initialRfEdges
  );

  // Push a snapshot after meaningful mutations (debounced via a stable ref)
  const snapshotTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSnapshot = useCallback(() => {
    if (snapshotTimeoutRef.current) clearTimeout(snapshotTimeoutRef.current);
    snapshotTimeoutRef.current = setTimeout(() => {
      // Capture current state at the time the timeout fires
      setNodes((currentNodes) => {
        setEdges((currentEdges) => {
          pushSnapshot(currentNodes, currentEdges);
          setUndoRedoTick((t) => t + 1);
          return currentEdges;
        });
        return currentNodes;
      });
    }, 300);
  }, [pushSnapshot, setNodes, setEdges]);

  const handleUndo = useCallback(() => {
    const snapshot = undo();
    if (snapshot) {
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      setUndoRedoTick((t) => t + 1);
    }
  }, [undo, setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    const snapshot = redo();
    if (snapshot) {
      setNodes(snapshot.nodes);
      setEdges(snapshot.edges);
      setUndoRedoTick((t) => t + 1);
    }
  }, [redo, setNodes, setEdges]);

  // ---- Build current workflow definition for modals -------------------------

  const getCurrentWorkflow = useCallback((): WorkflowDefinition => {
    return {
      metadata: { ...initialWorkflow.metadata },
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type as NodeType,
        position: n.position,
        data: n.data as unknown as NodeData,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        label: e.label as string | undefined,
      })),
    };
  }, [nodes, edges, initialWorkflow.metadata]);

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
      scheduleSnapshot();
    },
    [setEdges, scheduleSnapshot]
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
      scheduleSnapshot();
    },
    [rfInstance, setNodes, scheduleSnapshot]
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

  // Track node moves for undo
  const onNodeDragStop = useCallback(() => {
    scheduleSnapshot();
  }, [scheduleSnapshot]);

  // Keep selectedNode in sync with actual node data
  const actualSelectedNode = selectedNode
    ? nodes.find((n) => n.id === selectedNode.id) ?? null
    : null;

  // ---- Keyboard shortcuts ---------------------------------------------------

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;

      // Ctrl+Z / Cmd+Z — undo
      if (isMod && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Ctrl+Shift+Z / Cmd+Shift+Z — redo
      if (isMod && e.shiftKey && e.key === "z") {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Ctrl+S / Cmd+S — save
      if (isMod && e.key === "s") {
        e.preventDefault();
        handleSave();
        return;
      }

      // Ctrl+A / Cmd+A — select all
      if (isMod && e.key === "a") {
        e.preventDefault();
        setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        return;
      }

      // Ctrl+D / Cmd+D — duplicate selected
      if (isMod && e.key === "d") {
        e.preventDefault();
        if (actualSelectedNode) {
          const newNode: Node = {
            ...actualSelectedNode,
            id: generateNodeId(),
            position: {
              x: actualSelectedNode.position.x + 40,
              y: actualSelectedNode.position.y + 40,
            },
            selected: true,
            data: { ...actualSelectedNode.data },
          };
          setNodes((nds) => [
            ...nds.map((n) => ({ ...n, selected: false })),
            newNode,
          ]);
          setSelectedNode(newNode);
          scheduleSnapshot();
        }
        return;
      }

      // Delete / Backspace — delete selected
      if (e.key === "Delete" || e.key === "Backspace") {
        // Do not intercept if user is typing in an input
        const target = e.target as HTMLElement;
        if (
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        setNodes((nds) => {
          const toDelete = new Set(
            nds.filter((n) => n.selected).map((n) => n.id)
          );
          if (toDelete.size === 0 && actualSelectedNode) {
            toDelete.add(actualSelectedNode.id);
          }
          if (toDelete.size > 0) {
            setEdges((eds) =>
              eds.filter(
                (ed) => !toDelete.has(ed.source) && !toDelete.has(ed.target)
              )
            );
            setSelectedNode(null);
            scheduleSnapshot();
            return nds.filter((n) => !toDelete.has(n.id));
          }
          return nds;
        });
        return;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleUndo,
    handleRedo,
    actualSelectedNode,
    setNodes,
    setEdges,
    scheduleSnapshot,
  ]);

  // ---- Save / Deploy / Test handlers ----------------------------------------

  const handleSave = useCallback(async () => {
    const workflow = getCurrentWorkflow();

    // Save to localStorage as immediate fallback
    try {
      localStorage.setItem(`lantern_workflow_${agentName}`, JSON.stringify(workflow));
    } catch {
      // localStorage full or unavailable
    }

    // Save to backend API
    try {
      const { api } = await import("@/lib/api");
      await api.saveWorkflow(agentName, workflow);
      // Show success notification
      const el = document.createElement("div");
      el.className = "fixed top-4 right-4 z-[100] rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300 shadow-xl backdrop-blur-sm";
      el.textContent = "Workflow saved";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2000);
    } catch {
      // Backend unavailable — localStorage save is the fallback
      const el = document.createElement("div");
      el.className = "fixed top-4 right-4 z-[100] rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300 shadow-xl backdrop-blur-sm";
      el.textContent = "Saved locally (backend unavailable)";
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3000);
    }
  }, [agentName, getCurrentWorkflow]);

  const handleDeploy = useCallback(() => {
    setDeployModalOpen(true);
  }, []);

  const handleTestRun = useCallback(async () => {
    try {
      const { api } = await import("@/lib/api");
      const run = await api.createRun({ agentName, input: {} });
      // Navigate to agent's Runs tab to see the result
      window.location.href = `/agents/${agentName}?tab=runs`;
    } catch (err) {
      // Show error inline in toolbar instead of alert
      const msg = err instanceof Error ? err.message : String(err);
      const { useToast } = await import("@/components/toast");
      // Can't use hook here, fall back to console + simple UI feedback
      console.error("[editor] Test run failed:", msg);
      // Use a temporary DOM notification
      const el = document.createElement("div");
      el.className = "fixed top-4 right-4 z-[100] rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300 shadow-xl backdrop-blur-sm";
      el.textContent = `Run failed: ${msg}`;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }
  }, [agentName]);

  const handleExportCode = useCallback(() => {
    setExportModalOpen(true);
  }, []);

  // ---- Render ---------------------------------------------------------------

  return (
    <div className="flex h-full flex-col bg-surface-0">
      <Toolbar
        agentName={agentName}
        onSave={handleSave}
        onDeploy={handleDeploy}
        onTestRun={handleTestRun}
        onExportCode={handleExportCode}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo()}
        canRedo={canRedo()}
      />
      <div className="flex flex-1 overflow-hidden">
        <NodePalette />
        <div ref={reactFlowWrapper} className="flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(changes) => {
              onNodesChange(changes);
              // Schedule snapshot for position changes, removal, etc.
              const hasStructuralChange = changes.some(
                (c) => c.type === "remove" || c.type === "add"
              );
              if (hasStructuralChange) scheduleSnapshot();
            }}
            onEdgesChange={(changes) => {
              onEdgesChange(changes);
              const hasStructuralChange = changes.some(
                (c) => c.type === "remove" || c.type === "add"
              );
              if (hasStructuralChange) scheduleSnapshot();
            }}
            onConnect={onConnect}
            onInit={setRfInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodeDragStop={onNodeDragStop}
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
          onNodeDataChange={scheduleSnapshot}
        />
      </div>

      {/* Modals */}
      <ExportCodeModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        workflow={getCurrentWorkflow()}
      />
      <DeployModal
        open={deployModalOpen}
        onClose={() => setDeployModalOpen(false)}
        agentName={agentName}
      />
    </div>
  );
}
