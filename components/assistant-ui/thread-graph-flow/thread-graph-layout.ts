"use client";

import dagre from "dagre";
import { Position } from "@xyflow/react";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";

const ROOT_NODE_SIZE = { width: 320, height: 172 };
const MESSAGE_NODE_SIZE = { width: 360, height: 236 };
const PROMPT_DRAFT_NODE_SIZE = { width: 400, height: 300 };
const ARTIFACT_NODE_SIZE = { width: 320, height: 228 };
const ARTIFACT_LANE_X = -420;
const ARTIFACT_START_Y = 60;
const ARTIFACT_GAP_Y = 272;

type SizedFlowNode = {
  node: ThreadGraphFlowNode;
  size: { width: number; height: number };
};

const getNodeSize = (node: ThreadGraphFlowNode) => {
  const kind = node.data?.kind;
  if (kind === "root") return { ...ROOT_NODE_SIZE };
  if (kind === "artifact") return { ...ARTIFACT_NODE_SIZE };
  if (kind === "prompt-draft") return { ...PROMPT_DRAFT_NODE_SIZE };
  return { ...MESSAGE_NODE_SIZE };
};

const isConversationTreeEdge = (edge: ThreadGraphFlowEdge) =>
  edge.data?.tone !== "context" &&
  edge.data?.tone !== "output" &&
  edge.data?.tone !== "pending-output";

export const layoutThreadGraphFlow = (
  sourceNodes: ThreadGraphFlowNode[],
  sourceEdges: ThreadGraphFlowEdge[],
) => {
  const conversationNodes: SizedFlowNode[] = [];
  const artifactNodes: SizedFlowNode[] = [];

  for (const node of sourceNodes) {
    const sizedNode = { node, size: getNodeSize(node) };
    if (node.data.kind === "artifact") {
      artifactNodes.push(sizedNode);
    } else {
      conversationNodes.push(sizedNode);
    }
  }

  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: "LR",
    ranksep: 150,
    nodesep: 104,
    marginx: 48,
    marginy: 48,
  });

  for (const { node, size } of conversationNodes) {
    graph.setNode(node.id, size);
  }
  for (const edge of sourceEdges) {
    if (isConversationTreeEdge(edge)) {
      graph.setEdge(edge.source, edge.target);
    }
  }
  dagre.layout(graph);

  const laidOutConversationNodes = conversationNodes.map(({ node, size }) => {
    const dagrePosition = graph.node(node.id) as { x: number; y: number } | undefined;
    const storedDraftPosition =
      node.data.kind === "prompt-draft" ? node.data.position ?? null : null;
    const manualRootPosition =
      node.data.kind === "root" ? node.data.position ?? null : null;
    return {
      ...node,
      draggable: true,
      position:
        storedDraftPosition ??
        manualRootPosition ??
        (dagrePosition
          ? {
              x: dagrePosition.x - size.width / 2,
              y: dagrePosition.y - size.height / 2,
            }
          : node.position),
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: node.data.kind === "prompt-draft" ? { width: size.width } : node.style,
    } satisfies ThreadGraphFlowNode;
  });

  const laidOutArtifactNodes = artifactNodes.map(({ node, size }, index) => {
    const fallbackPosition = {
      x: ARTIFACT_LANE_X,
      y: ARTIFACT_START_Y + index * ARTIFACT_GAP_Y,
    };
    return {
      ...node,
      draggable: true,
      position: node.data.position ?? fallbackPosition,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: { width: size.width },
    } satisfies ThreadGraphFlowNode;
  });

  return {
    nodes: [...laidOutConversationNodes, ...laidOutArtifactNodes],
    edges: sourceEdges,
  };
};
