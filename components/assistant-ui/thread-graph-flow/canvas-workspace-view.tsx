"use client";

import React from "react";
import { CanvasBlockLibrary } from "@/components/assistant-ui/thread-graph-flow/block-library";
import { CanvasArtifactInspector } from "@/components/assistant-ui/thread-graph-flow/canvas-artifact-inspector";
import { CanvasMessageInspector } from "@/components/assistant-ui/thread-graph-flow/canvas-message-inspector";
import { CanvasSidebar } from "@/components/assistant-ui/thread-graph-flow/canvas-sidebar";
import { CanvasStage } from "@/components/assistant-ui/thread-graph-flow/canvas-stage";
import { useCodexAgentRuns } from "@/components/assistant-ui/thread-graph-flow/use-codex-agent-runs";

type CanvasWorkspaceViewProps = {
  artifactInspectorProps: React.ComponentProps<typeof CanvasArtifactInspector> | null;
  blockLibraryProps: Omit<
    React.ComponentProps<typeof CanvasBlockLibrary>,
    "onAddAgent"
  >;
  fileUploadInputRef: React.RefObject<HTMLInputElement | null>;
  imageUploadInputRef: React.RefObject<HTMLInputElement | null>;
  inspectorScrollRef: React.RefObject<HTMLDivElement | null>;
  messageInspectorProps: React.ComponentProps<typeof CanvasMessageInspector> | null;
  onFileUploadChange: React.ChangeEventHandler<HTMLInputElement>;
  onImageUploadChange: React.ChangeEventHandler<HTMLInputElement>;
  sidebarProps: Omit<React.ComponentProps<typeof CanvasSidebar>, "children">;
  stageProps: Omit<
    React.ComponentProps<typeof CanvasStage>,
    "agentEdges" | "agentNodes" | "onAgentPositionChange"
  >;
};

export function CanvasWorkspaceView({
  blockLibraryProps,
  fileUploadInputRef,
  imageUploadInputRef,
  onFileUploadChange,
  onImageUploadChange,
  stageProps,
}: CanvasWorkspaceViewProps) {
  const { onCollapsedChange } = blockLibraryProps;
  const { addAgent, agentEdges, agentNodes, updateAgentPosition } =
    useCodexAgentRuns({ sessionId: stageProps.activeSessionId });
  const handleAddAgent = React.useCallback(
    () => addAgent(null),
    [addAgent],
  );

  React.useLayoutEffect(() => {
    onCollapsedChange(true);
  }, [onCollapsedChange]);

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,rgba(125,211,252,0.12),transparent_28%),radial-gradient(circle_at_top_right,rgba(244,114,182,0.08),transparent_24%),linear-gradient(180deg,rgba(248,250,252,0.98),rgba(241,245,249,0.96))] dark:bg-[radial-gradient(circle_at_top_left,rgba(14,165,233,0.16),transparent_28%),radial-gradient(circle_at_top_right,rgba(168,85,247,0.12),transparent_22%),linear-gradient(180deg,rgba(15,23,42,0.88),rgba(2,6,23,0.9))]">
      <input
        ref={imageUploadInputRef}
        type="file"
        accept="image/*"
        data-testid="artifact-image-upload-input"
        className="hidden"
        onChange={onImageUploadChange}
      />
      <input
        ref={fileUploadInputRef}
        type="file"
        className="hidden"
        onChange={onFileUploadChange}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 gap-3 p-3">
          <CanvasBlockLibrary
            {...blockLibraryProps}
            onAddAgent={handleAddAgent}
          />
          <CanvasStage
            {...stageProps}
            agentEdges={agentEdges}
            agentNodes={agentNodes}
            onAgentPositionChange={updateAgentPosition}
          />
        </div>
      </div>
    </section>
  );
}
