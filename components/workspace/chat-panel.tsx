"use client";

import { useAssistantRuntime } from "@assistant-ui/react";
import React from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { scrollMessageIntoView } from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import { ROOT_NODE_ID } from "@/components/assistant-ui/thread-graph/graph-types";
import { useGraphBranchIntent } from "@/components/context/graph-branch-intent";
import { useSessionUiState } from "@/components/context/session-ui-state";
import { focusCanvasMessageBranch } from "@/lib/canvas-chat-navigation";

export const ChatPanel = () => {
  const runtime = useAssistantRuntime();
  const runtimeRef = React.useRef(runtime);
  runtimeRef.current = runtime;
  const { draft } = useGraphBranchIntent();
  const {
    focusedMessageId,
    setFocusedMessageId,
    setSplitPaneOpen,
    setViewMode,
  } = useSessionUiState();
  const anchorId = draft?.anchorId ?? null;
  const operation = draft?.operation ?? null;

  const revealMessageInChat = React.useCallback(
    (messageId: string) => {
      if (!messageId || messageId === ROOT_NODE_ID) return;
      const thread = runtimeRef.current.threads.main;
      try {
        const isAlreadyVisible = thread
          .getState()
          .messages.some((message) => message.id === messageId);
        if (!isAlreadyVisible) {
          const repository = thread.export();
          const nextRepository = focusCanvasMessageBranch(repository, messageId);
          if (nextRepository) {
            thread.import(nextRepository);
          }
        }
      } catch {
        // Keep the UI responsive even if the runtime is reconciling a branch.
      }

      setSplitPaneOpen("chat", true);
      setViewMode("split");
      scrollMessageIntoView(messageId, 40);
    },
    [setSplitPaneOpen, setViewMode],
  );

  React.useEffect(() => {
    if (!focusedMessageId || focusedMessageId === ROOT_NODE_ID) return;
    revealMessageInChat(focusedMessageId);
  }, [focusedMessageId, revealMessageInChat]);

  React.useEffect(() => {
    if (!anchorId || anchorId === ROOT_NODE_ID) return;
    if (
      operation !== "create-follow-up-prompt" &&
      operation !== "create-sibling-prompt"
    ) {
      return;
    }

    setFocusedMessageId(anchorId);
    revealMessageInChat(anchorId);
  }, [anchorId, operation, revealMessageInChat, setFocusedMessageId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[24px] border border-border/70 bg-[radial-gradient(circle_at_top,rgba(59,130,246,0.10),transparent_42%),radial-gradient(circle_at_bottom,rgba(236,72,153,0.06),transparent_46%),linear-gradient(180deg,rgba(248,250,252,0.96),rgba(241,245,249,0.92))] shadow-[0_35px_90px_-70px_rgba(2,6,23,0.5)] dark:border-white/10 dark:bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.12),transparent_44%),radial-gradient(circle_at_bottom,rgba(168,85,247,0.10),transparent_48%),linear-gradient(180deg,rgba(2,6,23,0.92),rgba(15,23,42,0.86))]">
      <Thread />
    </div>
  );
};
