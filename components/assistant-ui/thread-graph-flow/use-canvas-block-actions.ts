"use client";

import type { ReactFlowInstance } from "@xyflow/react";
import React from "react";
import {
  CANVAS_BLOCK_DRAG_MIME,
  getCanvasBlockDefinition,
  type CanvasBlockDefinition,
} from "@/components/assistant-ui/thread-graph-flow/block-library";
import {
  buildImagePreviewDataUrl,
  getArtifactUploadLimit,
  getFileStem,
  isTextLikeFile,
  trimStoredArtifactContent,
} from "@/components/assistant-ui/thread-graph-flow/canvas-upload-utils";
import {
  artifactDefaultTitle,
  CANVAS_PROMPT_DRAFT_NODE_ID,
  type FlowRenderMode,
} from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";
import type { Node as ThreadGraphNodeModel } from "@/components/assistant-ui/thread-graph/graph-types";
import type { GraphBranchIntent } from "@/components/context/graph-branch-intent";
import { formatBytes, type ContextBudgetPolicy } from "@/lib/context-budget";
import {
  parseArtifactOutput,
  type SessionArtifact,
  type SessionArtifactSemanticType,
  type SessionCanvasEndpoint,
} from "@/lib/session-artifacts";

type SessionArtifactsApi = ReturnType<
  typeof import("@/components/context/session-artifacts").useSessionArtifacts
>;

type UseCanvasBlockActionsParams = {
  activeSessionId: string | null;
  artifacts: SessionArtifact[];
  artifactIndex: ReadonlyMap<string, SessionArtifact>;
  canvasPrompts: SessionArtifact[];
  clearRequestError: () => void;
  connectCanvasBlocks: SessionArtifactsApi["connectCanvasBlocks"];
  contextBudgetPolicy: ContextBudgetPolicy;
  createArtifact: SessionArtifactsApi["createArtifact"];
  draft: GraphBranchIntent | null;
  fileUploadInputRef: React.RefObject<HTMLInputElement | null>;
  flowViewportRef: React.RefObject<HTMLDivElement | null>;
  imageUploadInputRef: React.RefObject<HTMLInputElement | null>;
  isArtifactLinkedToTarget: SessionArtifactsApi["isArtifactLinkedToTarget"];
  linkArtifactToTarget: SessionArtifactsApi["linkArtifactToTarget"];
  nodeIndex: ReadonlyMap<string, ThreadGraphNodeModel>;
  onCreateConversationRoot: (position: { x: number; y: number } | null) => void;
  promptIndex: ReadonlyMap<string, SessionArtifact>;
  reactFlowInstance: ReactFlowInstance<ThreadGraphFlowNode, ThreadGraphFlowEdge> | null;
  selectedArtifact: SessionArtifact | null;
  setCanvasDraftError: (message: string | null) => void;
  setCanvasSelectionId: (nodeId: string | null) => void;
  setConnectionError: (message: string | null) => void;
  setFlowRenderMode: (mode: FlowRenderMode) => void;
  setFocusedMessageId: (messageId: string | null) => void;
  setRequestError: (message: string | null) => void;
  setSelectedNodeId: (nodeId: string | null) => void;
  toggleDraftArtifact: (relation: "input" | "output", artifactId: string) => void;
  unlinkArtifactFromTarget: SessionArtifactsApi["unlinkArtifactFromTarget"];
  updateArtifact: SessionArtifactsApi["updateArtifact"];
};

export function useCanvasBlockActions({
  activeSessionId,
  artifacts,
  artifactIndex,
  canvasPrompts,
  clearRequestError,
  connectCanvasBlocks,
  contextBudgetPolicy,
  createArtifact,
  draft,
  fileUploadInputRef,
  flowViewportRef,
  imageUploadInputRef,
  isArtifactLinkedToTarget,
  linkArtifactToTarget,
  nodeIndex,
  onCreateConversationRoot,
  promptIndex,
  reactFlowInstance,
  selectedArtifact,
  setCanvasDraftError,
  setCanvasSelectionId,
  setConnectionError,
  setFlowRenderMode,
  setFocusedMessageId,
  setRequestError,
  setSelectedNodeId,
  toggleDraftArtifact,
  unlinkArtifactFromTarget,
  updateArtifact,
}: UseCanvasBlockActionsParams) {
  const pendingUploadPlacementRef = React.useRef<{
    position: { x: number; y: number } | null;
    relation: "input" | "output" | null;
  } | null>(null);

  const handleCreatePromptNode = React.useCallback(
    (position?: { x: number; y: number } | null) => {
      clearRequestError();
      setCanvasDraftError(null);
      const prompt = createArtifact({
        artifactType: "prompt",
        content: "",
        position: position ?? null,
        semanticType: null,
        title: `Prompt ${canvasPrompts.length + 1}`,
      });
      setFlowRenderMode("2d");
      setSelectedNodeId(prompt.id);
      setCanvasSelectionId(prompt.id);
      setFocusedMessageId(null);
    },
    [
      canvasPrompts.length,
      clearRequestError,
      createArtifact,
      setCanvasDraftError,
      setCanvasSelectionId,
      setFlowRenderMode,
      setFocusedMessageId,
      setSelectedNodeId,
    ],
  );

  const handleCreateArtifact = React.useCallback(
    (
      artifactType: SessionArtifact["artifactType"],
      options?: {
        semanticType?: SessionArtifactSemanticType | null;
        position?: { x: number; y: number } | null;
      },
    ) => {
      const created = createArtifact({
        artifactType,
        semanticType: options?.semanticType ?? null,
        title: artifactDefaultTitle(artifactType, artifacts, options?.semanticType ?? null),
        content: "",
        language: artifactType === "code" ? "ts" : null,
        position: options?.position ?? null,
      });
      setSelectedNodeId(created.id);
      setCanvasSelectionId(created.id);
      setFocusedMessageId(null);
      return created;
    },
    [
      artifacts,
      createArtifact,
      setCanvasSelectionId,
      setFocusedMessageId,
      setSelectedNodeId,
    ],
  );

  const handleCreateArtifactFromFile = React.useCallback(
    async (artifactType: "image" | "file", file: File) => {
      try {
        clearRequestError();
        if (!activeSessionId) {
          throw new Error("No active session available for artifact upload");
        }
        const maxUploadBytes = getArtifactUploadLimit(artifactType, contextBudgetPolicy);
        if (file.size > maxUploadBytes) {
          setRequestError(
            `Selected ${artifactType} is ${formatBytes(file.size)}. The app limit is ${formatBytes(maxUploadBytes)} to keep session context stable.`,
          );
          return;
        }

        const uploadFormData = new FormData();
        uploadFormData.append("file", file);
        const uploadResponse = await fetch(`/api/sessions/${activeSessionId}/artifacts`, {
          method: "POST",
          body: uploadFormData,
        });
        if (!uploadResponse.ok) {
          const reason = await uploadResponse.text();
          throw new Error(reason || `Artifact upload failed: ${uploadResponse.status}`);
        }
        const uploadData = (await uploadResponse.json()) as {
          blobRef?: string;
          byteSize?: number;
          fileName?: string;
          mimeType?: string | null;
        };

        const content =
          artifactType === "file" && isTextLikeFile(file)
            ? trimStoredArtifactContent(
                await file.text(),
                contextBudgetPolicy.maxCharsPerArtifact,
              )
            : "";
        const sourceDataUrl =
          artifactType === "image"
            ? await buildImagePreviewDataUrl(
                file,
                contextBudgetPolicy.maxImagePreviewBytes,
                contextBudgetPolicy.maxImagePreviewDimension,
              )
            : null;
        const title = getFileStem(file.name) || artifactDefaultTitle(artifactType, artifacts);
        const pendingPlacement = pendingUploadPlacementRef.current;
        const created = createArtifact({
          artifactType,
          blobRef: uploadData.blobRef ?? null,
          byteSize: uploadData.byteSize ?? file.size,
          content,
          fileName: uploadData.fileName ?? file.name,
          mimeType: uploadData.mimeType ?? (file.type || null),
          sourceDataUrl,
          title,
          position: pendingPlacement?.position ?? null,
        });
        setSelectedNodeId(created.id);
        setCanvasSelectionId(created.id);
        setFocusedMessageId(null);
        if (pendingPlacement?.relation && draft) {
          const source: SessionCanvasEndpoint =
            pendingPlacement.relation === "input"
              ? { id: created.id, kind: "artifact" }
              : { id: CANVAS_PROMPT_DRAFT_NODE_ID, kind: "draft" };
          const target: SessionCanvasEndpoint =
            pendingPlacement.relation === "input"
              ? { id: CANVAS_PROMPT_DRAFT_NODE_ID, kind: "draft" }
              : { id: created.id, kind: "artifact" };
          const result = connectCanvasBlocks(source, target);
          if (result.ok) toggleDraftArtifact(pendingPlacement.relation, created.id);
        }
        pendingUploadPlacementRef.current = null;
      } catch (error) {
        console.error(`Failed to create ${artifactType} artifact`, error);
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : `Could not read the selected ${artifactType}. Try another file.`;
        setRequestError(message);
      }
    },
    [
      activeSessionId,
      artifacts,
      clearRequestError,
      connectCanvasBlocks,
      contextBudgetPolicy,
      createArtifact,
      draft,
      setCanvasSelectionId,
      setFocusedMessageId,
      setRequestError,
      setSelectedNodeId,
      toggleDraftArtifact,
    ],
  );

  const handleImageUploadChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      await handleCreateArtifactFromFile("image", file);
    },
    [handleCreateArtifactFromFile],
  );

  const handleFileUploadChange = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      await handleCreateArtifactFromFile("file", file);
    },
    [handleCreateArtifactFromFile],
  );

  const handleToggleArtifactLink = React.useCallback(
    (artifactId: string, targetMessageId: string) => {
      if (isArtifactLinkedToTarget(artifactId, targetMessageId)) {
        unlinkArtifactFromTarget(artifactId, targetMessageId);
        return;
      }
      linkArtifactToTarget(artifactId, targetMessageId);
    },
    [isArtifactLinkedToTarget, linkArtifactToTarget, unlinkArtifactFromTarget],
  );

  const getCanvasCenterPosition = React.useCallback(() => {
    const rect = flowViewportRef.current?.getBoundingClientRect();
    if (!rect || !reactFlowInstance) return null;
    return reactFlowInstance.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  }, [flowViewportRef, reactFlowInstance]);

  const connectCreatedArtifactToDraft = React.useCallback(
    (artifactId: string, relation: "input" | "output") => {
      if (!draft) return;
      const source: SessionCanvasEndpoint =
        relation === "input"
          ? { id: artifactId, kind: "artifact" }
          : { id: CANVAS_PROMPT_DRAFT_NODE_ID, kind: "draft" };
      const target: SessionCanvasEndpoint =
        relation === "input"
          ? { id: CANVAS_PROMPT_DRAFT_NODE_ID, kind: "draft" }
          : { id: artifactId, kind: "artifact" };
      const result = connectCanvasBlocks(source, target);
      if (result.ok) {
        toggleDraftArtifact(relation, artifactId);
        setConnectionError(null);
      } else {
        setConnectionError(result.message);
      }
    },
    [connectCanvasBlocks, draft, setConnectionError, toggleDraftArtifact],
  );

  const handleAddCanvasBlock = React.useCallback(
    (block: CanvasBlockDefinition, position?: { x: number; y: number } | null) => {
      const resolvedPosition = position ?? getCanvasCenterPosition();
      setFlowRenderMode("2d");
      setConnectionError(null);
      if (block.action === "root") {
        onCreateConversationRoot(resolvedPosition);
        return;
      }
      if (block.action === "prompt") {
        handleCreatePromptNode(resolvedPosition);
        return;
      }
      if (block.action === "upload-file" || block.action === "upload-image") {
        pendingUploadPlacementRef.current = {
          position: resolvedPosition,
          relation: draft && block.category === "inputs" ? "input" : null,
        };
        if (block.category === "outputs") {
          pendingUploadPlacementRef.current.relation = "output";
        }
        if (block.action === "upload-image") imageUploadInputRef.current?.click();
        else fileUploadInputRef.current?.click();
        return;
      }
      const created = handleCreateArtifact(block.artifactType ?? "text", {
        semanticType: block.semanticType ?? null,
        position: resolvedPosition,
      });
      if (draft && block.category === "inputs") {
        connectCreatedArtifactToDraft(created.id, "input");
      }
      if (draft && block.category === "outputs") {
        connectCreatedArtifactToDraft(created.id, "output");
      }
    },
    [
      connectCreatedArtifactToDraft,
      draft,
      fileUploadInputRef,
      getCanvasCenterPosition,
      handleCreateArtifact,
      handleCreatePromptNode,
      imageUploadInputRef,
      onCreateConversationRoot,
      setConnectionError,
      setFlowRenderMode,
    ],
  );

  const handleCanvasDragOver = React.useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(CANVAS_BLOCK_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleCanvasDrop = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const blockId = event.dataTransfer.getData(CANVAS_BLOCK_DRAG_MIME);
      if (!blockId || !reactFlowInstance) return;
      event.preventDefault();
      const block = getCanvasBlockDefinition(blockId);
      if (!block) return;
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      handleAddCanvasBlock(block, position);
    },
    [handleAddCanvasBlock, reactFlowInstance],
  );

  const endpointForNode = React.useCallback(
    (nodeId: string | null | undefined): SessionCanvasEndpoint | null => {
      if (!nodeId) return null;
      if (nodeId === CANVAS_PROMPT_DRAFT_NODE_ID) return { id: nodeId, kind: "draft" };
      if (promptIndex.has(nodeId)) return { id: nodeId, kind: "prompt" };
      if (artifactIndex.has(nodeId)) return { id: nodeId, kind: "artifact" };
      const node = nodeIndex.get(nodeId);
      if (!node) return null;
      return { id: nodeId, kind: node.role === "assistant" ? "response" : "prompt" };
    },
    [artifactIndex, nodeIndex, promptIndex],
  );

  const handleCanvasConnect = React.useCallback(
    (connection: { source: string | null; target: string | null }) => {
      const source = endpointForNode(connection.source);
      const target = endpointForNode(connection.target);
      if (!source || !target) {
        setConnectionError("Choose compatible block handles.");
        return;
      }
      const result = connectCanvasBlocks(source, target);
      if (!result.ok) {
        setConnectionError(result.message);
        return;
      }
      setConnectionError(null);
      if (source.kind === "artifact" && target.kind === "draft") {
        toggleDraftArtifact("input", source.id);
      }
      if (source.kind === "draft" && target.kind === "artifact") {
        toggleDraftArtifact("output", target.id);
      }
      if (source.kind === "response" && target.kind === "artifact") {
        const responseNode = nodeIndex.get(source.id);
        const artifact = artifactIndex.get(target.id);
        if (responseNode && artifact) {
          updateArtifact(
            artifact.id,
            { content: parseArtifactOutput(artifact.semanticType, responseNode.text) },
            {
              revisionOrigin: "automatic",
              revisionAuthor: "model",
              promptId: responseNode.parentId,
              responseId: responseNode.id,
            },
          );
        }
      }
    },
    [
      artifactIndex,
      connectCanvasBlocks,
      endpointForNode,
      nodeIndex,
      setConnectionError,
      toggleDraftArtifact,
      updateArtifact,
    ],
  );

  const handleArtifactConnectFromInspector = React.useCallback(
    (value: string) => {
      if (!selectedArtifact || !value) return;
      const [kind, id] = value.split(":", 2);
      if (!id) return;
      if (kind === "prompt") {
        const result = connectCanvasBlocks(
          { id: selectedArtifact.id, kind: "artifact" },
          { id, kind: "prompt" },
        );
        setConnectionError(result.ok ? null : result.message);
        return;
      }
      if (kind === "response") {
        handleCanvasConnect({ source: id, target: selectedArtifact.id });
      }
    },
    [connectCanvasBlocks, handleCanvasConnect, selectedArtifact, setConnectionError],
  );

  return {
    handleAddCanvasBlock,
    handleArtifactConnectFromInspector,
    handleCanvasConnect,
    handleCanvasDragOver,
    handleCanvasDrop,
    handleCreatePromptNode,
    handleFileUploadChange,
    handleImageUploadChange,
    handleToggleArtifactLink,
  };
}
