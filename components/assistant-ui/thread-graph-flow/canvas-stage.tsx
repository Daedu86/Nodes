"use client";

import dynamic from "next/dynamic";
import React from "react";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { ArtifactGraphNode } from "@/components/assistant-ui/thread-graph-flow/artifact-node";
import { CanvasPromptNode } from "@/components/assistant-ui/thread-graph-flow/canvas-prompt-node";
import { CanvasResponseNode } from "@/components/assistant-ui/thread-graph-flow/canvas-response-node";
import { CodexAgentActivityNode } from "@/components/assistant-ui/thread-graph-flow/codex-agent-activity-node";
import { CodexAgentRunNode } from "@/components/assistant-ui/thread-graph-flow/codex-agent-run-node";
import { ThreadGraphEdge } from "@/components/assistant-ui/thread-graph-flow/thread-graph-edge";
import { ThreadGraphNode } from "@/components/assistant-ui/thread-graph-flow/thread-graph-node";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";
import {
  isFlowViewport,
  type FlowRenderMode,
} from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import { ROOT_NODE_ID } from "@/components/assistant-ui/thread-graph/graph-types";

const ThreadGraph3D = dynamic(
  () =>
    import("@/components/assistant-ui/thread-graph-flow/thread-graph-3d").then(
      (module) => module.ThreadGraph3D,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        role="status"
        aria-live="polite"
        className="flex h-full min-h-[28rem] items-center justify-center rounded-[32px] border border-white/70 bg-background/80 text-sm text-muted-foreground dark:border-white/10"
      >
        Loading 3D canvas…
      </div>
    ),
  },
);

const nodeTypes: NodeTypes = {
  agentActivityNode: CodexAgentActivityNode,
  agentRunNode: CodexAgentRunNode,
  artifactNode: ArtifactGraphNode,
  canvasResponseNode: CanvasResponseNode,
  promptNode: CanvasPromptNode,
  threadNode: ThreadGraphNode,
};

const edgeTypes: EdgeTypes = {
  threadEdge: ThreadGraphEdge,
};

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const FIT_VIEW_OPTIONS = { padding: 0.18 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;
const DEFAULT_EDGE_OPTIONS = { animated: false } as const;
const VISIBLE_ELEMENT_NODE_THRESHOLD = 80;
const VISIBLE_ELEMENT_EDGE_THRESHOLD = 150;

type StoredNodePosition = { x: number; y: number };
type StoredNodePositions = Record<string, StoredNodePosition>;

const isStoredNodePosition = (value: unknown): value is StoredNodePosition => {
  if (!value || typeof value !== "object") return false;
  const position = value as { x?: unknown; y?: unknown };
  return (
    typeof position.x === "number" &&
    Number.isFinite(position.x) &&
    typeof position.y === "number" &&
    Number.isFinite(position.y)
  );
};

const readStoredNodePositions = (storageKey: string): StoredNodePositions => {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(storageKey) ?? "{}",
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, StoredNodePosition] =>
          isStoredNodePosition(entry[1]),
      ),
    );
  } catch {
    return {};
  }
};

const positionsEqual = (
  left: StoredNodePosition | undefined,
  right: StoredNodePosition | undefined,
) => left?.x === right?.x && left?.y === right?.y;

const shouldUseStoredPosition = (node: ThreadGraphFlowNode) =>
  node.data?.kind !== "prompt-draft" && node.data?.kind !== "agent-activity";

const mergeRenderedNodes = (
  currentNodes: ThreadGraphFlowNode[],
  incomingNodes: ThreadGraphFlowNode[],
  storedPositions: StoredNodePositions,
) => {
  const currentById = new Map(
    currentNodes.map((node) => [node.id, node] as const),
  );
  let changed = currentNodes.length !== incomingNodes.length;

  const nextNodes = incomingNodes.map((incomingNode, index) => {
    const currentNode = currentById.get(incomingNode.id);
    const desiredPosition = shouldUseStoredPosition(incomingNode)
      ? storedPositions[incomingNode.id] ??
        currentNode?.position ??
        incomingNode.position
      : incomingNode.position;

    if (
      currentNode &&
      currentNode.type === incomingNode.type &&
      currentNode.data === incomingNode.data &&
      currentNode.selected === incomingNode.selected &&
      currentNode.hidden === incomingNode.hidden &&
      positionsEqual(currentNode.position, desiredPosition)
    ) {
      if (currentNodes[index] !== currentNode) changed = true;
      return currentNode;
    }

    changed = true;
    return positionsEqual(incomingNode.position, desiredPosition)
      ? incomingNode
      : { ...incomingNode, position: desiredPosition };
  });

  return changed ? nextNodes : currentNodes;
};

type CanvasStageProps = {
  activeSessionId: string | null;
  agentEdges: ThreadGraphFlowEdge[];
  agentNodes: ThreadGraphFlowNode[];
  edges: ThreadGraphFlowEdge[];
  flowRenderMode: FlowRenderMode;
  graphStructureSignature: string;
  nodes: ThreadGraphFlowNode[];
  onArtifactPositionChange: (
    artifactId: string,
    position: { x: number; y: number },
  ) => void;
  onCanvasConnect: (connection: Connection) => void;
  onCanvasDragOver: React.DragEventHandler<HTMLDivElement>;
  onCanvasDrop: React.DragEventHandler<HTMLDivElement>;
  onDraftPositionChange: (position: { x: number; y: number }) => void;
  onInit: (
    instance: ReactFlowInstance<ThreadGraphFlowNode, ThreadGraphFlowEdge>,
  ) => void;
  onMessageOpen: (messageId: string) => void;
  onFlowRenderModeChange: (mode: FlowRenderMode) => void;
  onAgentPositionChange: (
    nodeId: string,
    position: { x: number; y: number },
  ) => void;
  onNodeSelect: (nodeId: string | null) => void;
  onViewportChange: (viewport: Viewport) => void;
  selectedNodeId: string | null;
  storedViewport: Viewport | null;
  viewportRef: React.RefObject<HTMLDivElement | null>;
};

export function CanvasStage({
  activeSessionId,
  agentEdges,
  agentNodes,
  edges,
  flowRenderMode,
  graphStructureSignature,
  nodes,
  onArtifactPositionChange,
  onCanvasConnect,
  onCanvasDragOver,
  onCanvasDrop,
  onDraftPositionChange,
  onInit,
  onMessageOpen,
  onFlowRenderModeChange,
  onAgentPositionChange,
  onNodeSelect,
  onViewportChange,
  selectedNodeId,
  storedViewport,
  viewportRef,
}: CanvasStageProps) {
  const combinedNodes = React.useMemo(
    () => [...nodes, ...agentNodes],
    [agentNodes, nodes],
  );
  const combinedEdges = React.useMemo(
    () => [...edges, ...agentEdges],
    [agentEdges, edges],
  );
  const combinedGraphStructureSignature = React.useMemo(
    () => `${graphStructureSignature}|codex:${agentNodes.map((node) => node.id).join(",")}`,
    [agentNodes, graphStructureSignature],
  );
  const positionStorageKey = `nodes.canvas-message-positions.v1:${activeSessionId ?? "default"}`;
  const [storedNodePositions, setStoredNodePositions] =
    React.useState<StoredNodePositions>({});
  const [isInteracting, setIsInteracting] = React.useState(false);
  const [renderedNodes, setRenderedNodes, onNodesChange] =
    useNodesState<ThreadGraphFlowNode>(combinedNodes);

  React.useLayoutEffect(() => {
    setStoredNodePositions(readStoredNodePositions(positionStorageKey));
  }, [positionStorageKey]);

  React.useEffect(() => {
    setRenderedNodes((currentNodes) =>
      mergeRenderedNodes(currentNodes, combinedNodes, storedNodePositions),
    );
  }, [combinedNodes, setRenderedNodes, storedNodePositions]);

  const persistNodePosition = React.useCallback(
    (nodeId: string, position: StoredNodePosition) => {
      setStoredNodePositions((current) => {
        if (positionsEqual(current[nodeId], position)) return current;
        const next = { ...current, [nodeId]: position };
        try {
          window.localStorage.setItem(
            positionStorageKey,
            JSON.stringify(next),
          );
        } catch {
          // The node remains movable even when browser storage is unavailable.
        }
        return next;
      });
    },
    [positionStorageKey],
  );

  const handleInteractionStart = React.useCallback(() => {
    setIsInteracting(true);
  }, []);

  const handleMoveEnd = React.useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      setIsInteracting(false);
      onViewportChange(viewport);
    },
    [onViewportChange],
  );

  const handleNodeDragStop = React.useCallback(
    (_event: MouseEvent | TouchEvent, node: ThreadGraphFlowNode) => {
      setIsInteracting(false);
      const position = { x: node.position.x, y: node.position.y };

      if (node.data?.kind === "prompt-draft") {
        onDraftPositionChange(position);
        return;
      }
      if (node.data?.kind === "agent-activity") return;

      persistNodePosition(node.id, position);

      if (node.data?.kind === "agent-run") {
        onAgentPositionChange(node.id, position);
        return;
      }
      if (
        node.data?.kind === "artifact" ||
        node.data?.kind === "canvas-prompt"
      ) {
        onArtifactPositionChange(node.id, position);
      }
    },
    [
      onArtifactPositionChange,
      onDraftPositionChange,
      persistNodePosition,
      onAgentPositionChange,
    ],
  );

  const handleSelectionChange = React.useCallback(
    ({ nodes: selectedNodes }: { nodes: ThreadGraphFlowNode[] }) => {
      if (selectedNodes[0]?.id) onNodeSelect(selectedNodes[0].id);
    },
    [onNodeSelect],
  );

  const handleNodeClick = React.useCallback(
    (_event: React.MouseEvent, node: ThreadGraphFlowNode) =>
      onNodeSelect(node.id),
    [onNodeSelect],
  );

  const handleNodeDoubleClick = React.useCallback(
    (_event: React.MouseEvent, node: ThreadGraphFlowNode) => {
      if (
        node.data.kind === "artifact" ||
        node.data.kind === "canvas-prompt" ||
        node.data.kind === "canvas-response" ||
        node.data.kind === "agent-run" ||
        node.data.kind === "agent-activity" ||
        node.id === ROOT_NODE_ID
      ) {
        return;
      }
      onNodeSelect(node.id);
      onMessageOpen(node.id);
    },
    [onMessageOpen, onNodeSelect],
  );

  const handlePaneClick = React.useCallback(
    () => onNodeSelect(null),
    [onNodeSelect],
  );

  const shouldCull =
    renderedNodes.length > VISIBLE_ELEMENT_NODE_THRESHOLD ||
    combinedEdges.length > VISIBLE_ELEMENT_EDGE_THRESHOLD;

  return (
    <div
      ref={viewportRef}
      role="region"
      aria-label="Conversation canvas"
      aria-describedby="canvas-stage-instructions"
      data-canvas-interacting={isInteracting ? "true" : "false"}
      className="relative min-h-[28rem] flex-1 lg:min-h-0"
      onDragOver={onCanvasDragOver}
      onDrop={onCanvasDrop}
    >
      <div
        role="group"
        aria-label="Canvas render mode"
        className="absolute right-5 top-5 z-20 flex items-center rounded-full border border-white/70 bg-white/92 p-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur dark:border-white/10 dark:bg-slate-950/92"
      >
        {(["2d", "3d"] as FlowRenderMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={flowRenderMode === mode}
            onClick={() => onFlowRenderModeChange(mode)}
            className={`rounded-full px-3 py-2 transition-colors ${
              flowRenderMode === mode
                ? "bg-foreground text-background"
                : "hover:text-foreground"
            }`}
          >
            {mode.toUpperCase()}
          </button>
        ))}
      </div>

      <p id="canvas-stage-instructions" className="sr-only">
        Use Tab to reach canvas controls and graph elements. Select or drag a
        node to reorganize the canvas. Double-click a conversation node to open
        it in Chat.
      </p>

      {flowRenderMode === "3d" ? (
        <ThreadGraph3D
          nodes={combinedNodes}
          edges={combinedEdges}
          selectedNodeId={selectedNodeId}
          onSelectNode={onNodeSelect}
        />
      ) : (
        <>
          <ReactFlow
            key={`flow:${activeSessionId}`}
            aria-label="Conversation graph"
            data-graph-structure={combinedGraphStructureSignature}
            nodes={renderedNodes}
            edges={combinedEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView={!isFlowViewport(storedViewport)}
            defaultViewport={storedViewport ?? DEFAULT_VIEWPORT}
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.3}
            maxZoom={1.6}
            onlyRenderVisibleElements={shouldCull}
            nodesDraggable
            elementsSelectable
            proOptions={PRO_OPTIONS}
            onInit={onInit}
            onNodesChange={onNodesChange}
            onConnect={onCanvasConnect}
            onMoveStart={handleInteractionStart}
            onMoveEnd={handleMoveEnd}
            onNodeDragStart={handleInteractionStart}
            onNodeDragStop={handleNodeDragStop}
            onSelectionChange={handleSelectionChange}
            onNodeClick={handleNodeClick}
            onNodeDoubleClick={handleNodeDoubleClick}
            onPaneClick={handlePaneClick}
            className="overflow-hidden rounded-[32px] border border-white/70 bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.12),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(168,85,247,0.06),transparent_18%),linear-gradient(180deg,rgba(255,255,255,0.88),rgba(248,250,252,0.92))] shadow-[0_30px_110px_-60px_rgba(15,23,42,0.5)] dark:border-white/10 dark:bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.1),transparent_22%),radial-gradient(circle_at_bottom_right,rgba(168,85,247,0.08),transparent_18%),linear-gradient(180deg,rgba(15,23,42,0.9),rgba(2,6,23,0.92))]"
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          >
            <Background
              color="rgba(148,163,184,0.18)"
              gap={24}
              size={1.15}
            />
            {!isInteracting && renderedNodes.length <= 160 ? (
              <MiniMap
                pannable
                zoomable
                className="!pointer-events-none !bottom-5 !right-5 !rounded-[20px] !border !border-white/70 !bg-white/85 !shadow-[0_24px_70px_-45px_rgba(15,23,42,0.45)] dark:!border-white/10 dark:!bg-slate-950/85"
                nodeColor={(node) =>
                  String(
                    (node.data as { accent?: string } | undefined)?.accent ??
                      "rgba(100,116,139,0.85)",
                  )
                }
                maskColor="rgba(15,23,42,0.05)"
              />
            ) : null}
            <Controls
              className="!bottom-5 !left-5 !right-auto !top-auto [&>button]:!border-white/70 [&>button]:!bg-white/92 [&>button]:!text-foreground [&>button]:!shadow-sm dark:[&>button]:!border-white/10 dark:[&>button]:!bg-slate-950/92"
              showInteractive={false}
            />
          </ReactFlow>

          <div className="pointer-events-none absolute bottom-5 left-20 z-10 hidden items-center gap-2 md:flex">
            <div className="pointer-events-none rounded-full border border-white/70 bg-white/82 px-3 py-1 text-[11px] text-muted-foreground shadow-[0_18px_48px_-36px_rgba(15,23,42,0.45)] backdrop-blur dark:border-white/10 dark:bg-slate-950/72">
              Drag nodes directly on the stage. Their positions are saved for
              this session.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
