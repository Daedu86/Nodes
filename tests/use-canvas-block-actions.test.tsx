// @vitest-environment jsdom

import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { useCanvasBlockActions } from "@/components/assistant-ui/thread-graph-flow/use-canvas-block-actions";
import { getCanvasBlockDefinition } from "@/components/assistant-ui/thread-graph-flow/block-library";
import type { SessionArtifact } from "@/lib/session-artifacts";

const timestamp = "2026-07-11T00:00:00.000Z";

const makeArtifact = (
  input: Partial<SessionArtifact> & Pick<SessionArtifact, "id" | "artifactType">,
): SessionArtifact => ({
  title: input.title ?? input.id,
  content: input.content ?? "",
  createdAt: input.createdAt ?? timestamp,
  updatedAt: input.updatedAt ?? timestamp,
  ...input,
});

type Actions = ReturnType<typeof useCanvasBlockActions>;
type Params = Parameters<typeof useCanvasBlockActions>[0];

function renderActions(params: Params) {
  let actions: Actions | null = null;

  function Harness() {
    actions = useCanvasBlockActions(params);
    return null;
  }

  render(<Harness />);
  if (!actions) throw new Error("Canvas actions were not initialized");
  return () => actions as Actions;
}

const createParams = () => {
  const artifact = makeArtifact({
    id: "artifact-1",
    artifactType: "text",
    semanticType: "draft",
  });
  const responseNode = {
    id: "assistant-1",
    parentId: "user-1",
    role: "assistant",
    text: "Generated answer",
    depth: 2,
    idx: 1,
  };
  const createArtifact = vi.fn((input: Parameters<Params["createArtifact"]>[0]) =>
    makeArtifact({
      ...input,
      id: "created-1",
      artifactType: input.artifactType,
    }),
  );
  const updateArtifact = vi.fn<Params["updateArtifact"]>();
  const setCanvasSelectionId = vi.fn<(nodeId: string | null) => void>();
  const setFocusedMessageId = vi.fn<(messageId: string | null) => void>();
  const setSelectedNodeId = vi.fn<(nodeId: string | null) => void>();
  const onCreateConversationRoot = vi.fn<Params["onCreateConversationRoot"]>();

  const params = {
    activeSessionId: "session-1",
    artifacts: [artifact],
    artifactIndex: new Map([[artifact.id, artifact]]),
    canvasPrompts: [],
    clearRequestError: vi.fn(),
    connectCanvasBlocks: vi.fn(() => ({
      ok: true as const,
      link: {
        id: "link-1",
        relation: "output" as const,
        artifactId: artifact.id,
        promptId: responseNode.parentId,
        responseId: responseNode.id,
        createdAt: timestamp,
      },
    })),
    contextBudgetPolicy: {
      recommendedPromptTokens: 8_000,
      maxArtifactTokensPerPrompt: 2_400,
      maxArtifactsPerPrompt: 4,
      maxCharsPerArtifact: 8_000,
      maxImagePreviewBytes: 160 * 1_024,
      maxImagePreviewDimension: 720,
      maxUploadImageBytes: 6 * 1_024 * 1_024,
      maxUploadFileBytes: 8 * 1_024 * 1_024,
      warnSessionBytes: 1_024 * 1_024,
      hardSessionBytes: 2 * 1_024 * 1_024,
      label: "Test budget",
      note: "Test budget policy",
    },
    createArtifact,
    draft: null,
    fileUploadInputRef: { current: null },
    flowViewportRef: { current: null },
    imageUploadInputRef: { current: null },
    isArtifactLinkedToTarget: vi.fn(() => false),
    linkArtifactToTarget: vi.fn(),
    nodeIndex: new Map([[responseNode.id, responseNode]]),
    onCreateConversationRoot,
    promptIndex: new Map(),
    reactFlowInstance: null,
    selectedArtifact: artifact,
    setCanvasDraftError: vi.fn(),
    setCanvasSelectionId,
    setConnectionError: vi.fn(),
    setFlowRenderMode: vi.fn(),
    setFocusedMessageId,
    setRequestError: vi.fn(),
    setSelectedNodeId,
    toggleDraftArtifact: vi.fn(),
    unlinkArtifactFromTarget: vi.fn(),
    updateArtifact,
  } satisfies Params;

  return {
    artifact,
    createArtifact,
    params,
    onCreateConversationRoot,
    setCanvasSelectionId,
    setFocusedMessageId,
    setSelectedNodeId,
    updateArtifact,
  };
};

describe("useCanvasBlockActions", () => {
  it("adds an optional conversation root at the requested position", () => {
    const fixture = createParams();
    const getActions = renderActions(fixture.params);
    const rootBlock = getCanvasBlockDefinition("process-conversation-root");
    if (!rootBlock) throw new Error("Conversation Root block is missing");

    act(() => {
      getActions().handleAddCanvasBlock(rootBlock, { x: 12, y: 34 });
    });

    expect(fixture.onCreateConversationRoot).toHaveBeenCalledWith({ x: 12, y: 34 });
  });

  it("creates an indepent prompt and selects it", () => {
    const fixture = createParams();
    const getActions = renderActions(fixture.params);

    act(() => {
      getActions().handleCreatePromptNode({ x: 10, y: 20 });
    });

    expect(fixture.createArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactType: "prompt",
        position: { x: 10, y: 20 },
      }),
    );
    expect(fixture.setSelectedNodeId).toHaveBeenCalledWith("created-1");
    expect(fixture.setCanvasSelectionId).toHaveBeenCalledWith("created-1");
    expect(fixture.setFocusedMessageId).toHaveBeenCalledWith(null);
  });

  it("captures a response into a connected output artifact", () => {
    const fixture = createParams();
    const getActions = renderActions(fixture.params);

    act(() => {
      getActions().handleCanvasConnect({
        source: "assistant-1",
        target: fixture.artifact.id,
      });
    });

    expect(fixture.updateArtifact).toHaveBeenCalledWith(
      fixture.artifact.id,
      { content: "Generated answer" },
      {
        revisionOrigin: "automatic",
        revisionAuthor: "model",
        promptId: "user-1",
        responseId: "assistant-1",
      },
    );
  });
});
