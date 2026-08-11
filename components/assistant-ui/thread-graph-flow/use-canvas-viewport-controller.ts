"use client";

import {
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import React from "react";
import {
  type FlowDensityMode,
  type FlowRenderMode,
  CANVAS_PROMPT_DRAFT_NODE_ID,
} from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";
import type { Node as ThreadGraphNodeModel } from "@/components/assistant-ui/thread-graph/graph-types";

type CanvasFlowInstance = ReactFlowInstance<
  ThreadGraphFlowNode,
  ThreadGraphFlowEdge
>;

type UseCanvasViewportControllerOptions = {
  decoratedNodeCount: number;
  densityMode: FlowDensityMode;
  draftActive: boolean;
  flowRenderMode: FlowRenderMode;
  focusedMessageId: string | null;
  nodeIndex: ReadonlyMap<string, ThreadGraphNodeModel>;
  selectedNodeId: string | null;
  setStoredViewport: (viewport: Viewport) => void;
  treeStructureSignature: string;
  visibleNodeCount: number;
};

const MIN_AUTOFIT_ZOOM = 0.52;

export const shouldRefitCanvasTree = (
  previousSignature: string | null,
  nextSignature: string,
) => previousSignature !== null && previousSignature !== nextSignature;

export function useCanvasViewportController({
  decoratedNodeCount,
  draftActive,
  flowRenderMode,
  selectedNodeId,
  setStoredViewport,
  treeStructureSignature,
}: UseCanvasViewportControllerOptions) {
  const [reactFlowInstance, setReactFlowInstance] =
    React.useState<CanvasFlowInstance | null>(null);
  const treeSignatureRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!reactFlowInstance || decoratedNodeCount === 0) return;

    const previousSignature = treeSignatureRef.current;
    treeSignatureRef.current = treeStructureSignature;

    if (!shouldRefitCanvasTree(previousSignature, treeStructureSignature)) return;

    const animationFrame = window.requestAnimationFrame(() => {
      void reactFlowInstance
        .fitView({
          duration: 420,
          padding: 0.22,
          minZoom: MIN_AUTOFIT_ZOOM,
        })
        .then(() => {
          setStoredViewport(reactFlowInstance.getViewport());
        });
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [
    decoratedNodeCount,
    reactFlowInstance,
    setStoredViewport,
    treeStructureSignature,
  ]);

  React.useEffect(() => {
    if (!reactFlowInstance || !draftActive || flowRenderMode !== "2d") return;
    const animationFrame = window.requestAnimationFrame(() => {
      void reactFlowInstance
        .fitView({
          duration: 320,
          padding: 0.34,
          nodes: [{ id: CANVAS_PROMPT_DRAFT_NODE_ID }],
        })
        .then(() => {
          setStoredViewport(reactFlowInstance.getViewport());
        });
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [draftActive, flowRenderMode, reactFlowInstance, setStoredViewport]);

  const handleFocusSelected = React.useCallback(async () => {
    if (!reactFlowInstance || !selectedNodeId) return;
    await reactFlowInstance.fitView({
      duration: 500,
      padding: 0.4,
      nodes: [{ id: selectedNodeId }],
    });
    setStoredViewport(reactFlowInstance.getViewport());
  }, [reactFlowInstance, selectedNodeId, setStoredViewport]);

  const handleResetView = React.useCallback(async () => {
    if (!reactFlowInstance) return;
    await reactFlowInstance.fitView({
      duration: 450,
      padding: 0.18,
      minZoom: MIN_AUTOFIT_ZOOM,
    });
    setStoredViewport(reactFlowInstance.getViewport());
  }, [reactFlowInstance, setStoredViewport]);

  return {
    handleFocusSelected,
    handleResetView,
    reactFlowInstance,
    setReactFlowInstance,
  };
}
