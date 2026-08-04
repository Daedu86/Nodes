import {
  getGraphModelLabel,
  getGraphModelPalette,
} from "@/components/assistant-ui/thread-graph/graph-models";
import {
  ROOT_NODE_ID,
  type Node as ThreadGraphNodeModel,
} from "@/components/assistant-ui/thread-graph/graph-types";
import {
  artifactAccent,
  CANVAS_BRANCH_RUN_NOTICE,
  CANVAS_PROMPT_DRAFT_NODE_ID,
  providerDisplay,
} from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import type {
  CanvasFlowElementsParams,
  CanvasPromptLinkCount,
} from "@/components/assistant-ui/thread-graph-flow/canvas-flow-elements-types";
import type { ThreadGraphFlowNode } from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";

export type CanvasModelVisual = {
  accent: string;
  modelLabel: string;
  providerLabel: string | undefined;
};

export const createCanvasModelVisualResolver = () => {
  const cache = new Map<string, CanvasModelVisual>();
  return (node: Pick<ThreadGraphNodeModel, "model" | "provider">) => {
    const key = `${node.provider ?? ""}\u0000${node.model ?? ""}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const palette = getGraphModelPalette({
      defaultFill: "rgba(255,255,255,0.94)",
      defaultStroke: "rgba(15,23,42,0.08)",
      isDarkBg: false,
      model: node.model,
      provider: node.provider,
    });
    const visual: CanvasModelVisual = {
      accent: palette.swatch,
      modelLabel: getGraphModelLabel(node.model, node.provider),
      providerLabel: providerDisplay(node.provider),
    };
    cache.set(key, visual);
    return visual;
  };
};

export function buildConversationFlowNodes({
  canvasConversationNodes,
  linkedArtifactCountByTarget,
  overrides,
  resolveModelVisual,
  handleNodeBranchOperation,
  onNodeContextScopeChange,
}: Pick<CanvasFlowElementsParams, "canvasConversationNodes" | "overrides" | "handleNodeBranchOperation" | "onNodeContextScopeChange"> & {
  linkedArtifactCountByTarget: ReadonlyMap<string, number>;
  resolveModelVisual: ReturnType<typeof createCanvasModelVisualResolver>;
}): ThreadGraphFlowNode[] {
  return canvasConversationNodes.map((node) => {
    const visual = resolveModelVisual(node);
    return {
      id: node.id,
      type: "threadNode",
      position:
        typeof node.x === "number" && typeof node.y === "number"
          ? { x: node.x, y: node.y }
          : { x: 0, y: 0 },
      selectable: true,
      draggable: true,
      data: {
        accent: visual.accent,
        branchId:
          typeof node.branchId === "string" || typeof node.branchId === "number"
            ? node.branchId
            : null,
        contextScope: node.contextScope ?? null,
        depth: node.depth,
        editedFromId: node.editedFromId ?? null,
        emphasis: "normal",
        filterMatched: true,
        isBridge: Boolean(node.isBridge),
        isCut: overrides.has(node.id),
        isRoot: node.id === ROOT_NODE_ID,
        kind: node.id === ROOT_NODE_ID ? "root" : node.isBridge ? "bridge" : "message",
        language: null,
        linkedArtifactCount: linkedArtifactCountByTarget.get(node.id) ?? 0,
        model: node.model ?? null,
        modelLabel: visual.modelLabel,
        position:
          typeof node.x === "number" && typeof node.y === "number"
            ? { x: node.x, y: node.y }
            : null,
        preview: node.text,
        provider: node.provider ?? null,
        providerLabel: visual.providerLabel,
        role: node.role,
        idx: node.idx,
        title: null,
        onBranchOperation: handleNodeBranchOperation
          ? (operation) => handleNodeBranchOperation(node.id, operation)
          : undefined,
        onContextScopeChange: onNodeContextScopeChange
          ? (scope) => onNodeContextScopeChange(node.id, scope)
          : undefined,
      },
    } satisfies ThreadGraphFlowNode;
  });
}

export function buildArtifactFlowNodes({
  artifacts,
  linkedTargetCountByArtifact,
}: Pick<CanvasFlowElementsParams, "artifacts" | "linkedTargetCountByArtifact">): ThreadGraphFlowNode[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    type: "artifactNode",
    position: artifact.position ?? { x: 0, y: 0 },
    selectable: true,
    draggable: true,
    data: {
      accent: artifactAccent(artifact),
      artifactType: artifact.artifactType,
      byteSize: artifact.byteSize ?? null,
      emphasis: "normal",
      fileName: artifact.fileName ?? null,
      filterMatched: true,
      kind: "artifact",
      language: artifact.language ?? null,
      linkedArtifactCount: linkedTargetCountByArtifact.get(artifact.id) ?? 0,
      mimeType: artifact.mimeType ?? null,
      position: artifact.position ?? null,
      preview: artifact.content,
      revisionCount: artifact.revisions?.length ?? 0,
      role: "artifact",
      semanticType: artifact.semanticType ?? null,
      sourceDataUrl: artifact.sourceDataUrl ?? null,
      syncMode: artifact.syncMode ?? "auto",
      title: artifact.title,
    },
  }));
}

export function buildCanvasPromptFlowNodes({
  canvasPrompts,
  cancelCanvasPrompt,
  deleteArtifact,
  llmEnabled,
  promptLinkCountById,
  runCanvasPrompt,
  updateArtifact,
}: Pick<
  CanvasFlowElementsParams,
  | "canvasPrompts"
  | "cancelCanvasPrompt"
  | "deleteArtifact"
  | "llmEnabled"
  | "runCanvasPrompt"
  | "updateArtifact"
> & {
  promptLinkCountById: ReadonlyMap<string, CanvasPromptLinkCount>;
}): ThreadGraphFlowNode[] {
  return canvasPrompts.map((prompt) => {
    const counts = promptLinkCountById.get(prompt.id) ?? { context: 0, output: 0 };
    const status = prompt.promptStatus ?? "idle";
    const isBusy = status === "running" || status === "queued";
    return {
      id: prompt.id,
      type: "promptNode",
      position: prompt.position ?? { x: 0, y: 0 },
      selectable: true,
      draggable: true,
      data: {
        accent: "#0f766e",
        draftBusy: isBusy,
        draftContextCount: counts.context,
        draftDisabled: !llmEnabled,
        draftError: prompt.promptError ?? null,
        draftOutputCount: counts.output,
        draftText: prompt.content,
        emphasis: "normal",
        filterMatched: true,
        kind: "canvas-prompt",
        position: prompt.position ?? null,
        preview: prompt.content || "Independent canvas prompt",
        promptStatus: status,
        role: "prompt",
        title: prompt.title,
        onDraftCancel: () => deleteArtifact(prompt.id),
        onDraftCancelRun: isBusy ? () => cancelCanvasPrompt(prompt.id) : undefined,
        onDraftSubmit: () => runCanvasPrompt(prompt.id),
        onDraftTextChange: (value: string) =>
          updateArtifact(
            prompt.id,
            { content: value },
            { revisionOrigin: "manual", revisionAuthor: "user" },
          ),
      },
    } satisfies ThreadGraphFlowNode;
  });
}

export function buildCanvasResponseFlowNodes({
  canvasPrompts,
}: Pick<CanvasFlowElementsParams, "canvasPrompts">): ThreadGraphFlowNode[] {
  return canvasPrompts.flatMap((prompt) => {
    const responseId = prompt.promptRunId;
    const responseText = prompt.promptResult?.trim();
    if (!responseId || !responseText || prompt.promptStatus !== "completed") return [];

    return [
      {
        id: responseId,
        type: "canvasResponseNode",
        position: { x: 0, y: 0 },
        selectable: true,
        draggable: true,
        data: {
          accent: "#2563eb",
          emphasis: "normal",
          filterMatched: true,
          kind: "canvas-response",
          model: prompt.promptModel ?? null,
          modelLabel: getGraphModelLabel(
            prompt.promptModel ?? null,
            prompt.promptProvider ?? null,
          ),
          preview: responseText,
          provider: prompt.promptProvider ?? null,
          providerLabel: providerDisplay(prompt.promptProvider ?? null),
          role: "assistant",
          title: "Assistant response",
        },
      } satisfies ThreadGraphFlowNode,
    ];
  });
}

export function buildDraftFlowNodes({
  canvasDraftError,
  draft,
  draftAnchorNode,
  draftBranchSpec,
  draftContextCount,
  draftDetail,
  handleCancelPromptDraft,
  handleCancelRun,
  handleSubmitBranchDraft,
  isSubmittingBranch,
  isThreadRunning,
  llmEnabled,
  nodeIndex,
  requestError,
  setDraftText,
  setDraftContextScope,
}: Pick<
  CanvasFlowElementsParams,
  | "canvasDraftError"
  | "draft"
  | "draftAnchorNode"
  | "draftBranchSpec"
  | "draftContextCount"
  | "draftDetail"
  | "handleCancelPromptDraft"
  | "handleCancelRun"
  | "handleSubmitBranchDraft"
  | "isSubmittingBranch"
  | "isThreadRunning"
  | "llmEnabled"
  | "nodeIndex"
  | "requestError"
  | "setDraftText"
  | "setDraftContextScope"
>): ThreadGraphFlowNode[] {
  if (!draft || !draftBranchSpec || !draftDetail) return [];
  const sourceNode =
    nodeIndex.get(draftBranchSpec.parentId ?? ROOT_NODE_ID) ?? draftAnchorNode;
  return [
    {
      id: CANVAS_PROMPT_DRAFT_NODE_ID,
      type: "promptNode",
      position: { x: 0, y: 0 },
      selectable: true,
      draggable: false,
      data: {
        accent: "#0f766e",
        depth: (sourceNode?.depth ?? 0) + 1,
        draftBusy: isSubmittingBranch,
        draftContextCount,
        draftOutputCount: draft.outputArtifactIds.length,
        draftDetail,
        draftDisabled: !llmEnabled,
        draftError: canvasDraftError ?? requestError,
        draftOperation: draft.operation,
        draftRunInterruptionNote: isThreadRunning ? CANVAS_BRANCH_RUN_NOTICE : null,
        draftText: draft.text,
        draftContextScope: draft.contextScope,
        emphasis: "normal",
        filterMatched: true,
        kind: "prompt-draft",
        position: draft.position ?? null,
        preview: draft.text || "Draft prompt",
        role: "draft",
        title: "Draft prompt",
        onDraftCancel: handleCancelPromptDraft,
        onDraftCancelRun: isThreadRunning ? handleCancelRun : undefined,
        onDraftSubmit: handleSubmitBranchDraft,
        onDraftTextChange: setDraftText,
        onDraftContextScopeChange: setDraftContextScope,
      },
    },
  ];
}
