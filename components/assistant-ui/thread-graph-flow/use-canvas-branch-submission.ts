"use client";

import { useAssistantRuntime } from "@assistant-ui/react";
import {
  getExternalStoreMessages,
  type MessageFormatRepository,
  type ThreadMessage,
} from "@assistant-ui/core";
import type { UIMessage } from "ai";
import React from "react";
import type {
  ContextScope,
  GraphBranchIntent,
} from "@/components/context/graph-branch-intent";
import type { ModelProvider } from "@/components/context/model-config";
import {
  CANVAS_BRANCH_CANCEL_FAILURE,
  CANVAS_PROMPT_DRAFT_NODE_ID,
} from "@/components/assistant-ui/thread-graph-flow/canvas-workspace-utils";
import {
  appendCompletedCanvasBranch,
  buildCanvasBranchRunRequest,
  createCanvasBranchRunId,
  type CanvasBranchRunResponse,
} from "@/lib/canvas-branch-direct-run";
import { buildBranchSpec } from "@/lib/thread-branching";
import { buildBranchAppendMessage } from "@/lib/thread-branching-runtime";
import { ensureThreadIdle } from "@/lib/thread-run-control";
import { toLlmContextArtifacts, type SessionArtifact } from "@/lib/session-artifacts";
import type { SessionThreadExport } from "@/lib/session-documents";
import {
  forceSessionPersist,
  notifySessionRuntimeReplaced,
  resumeSessionPersist,
  suspendSessionPersist,
  type SessionPersistSuspensionToken,
} from "@/lib/session-persist-sync";
import type { Node as ThreadGraphNodeModel } from "@/components/assistant-ui/thread-graph/graph-types";

type AssistantRuntime = NonNullable<ReturnType<typeof useAssistantRuntime>>;
type BranchSpec = ReturnType<typeof buildBranchSpec>;
type ThreadExport = ReturnType<AssistantRuntime["threads"]["main"]["export"]>;
type ThreadExportEntry = ThreadExport["messages"][number];
type MainThreadRuntime = AssistantRuntime["threads"]["main"];
type ThreadExternalState = MessageFormatRepository<UIMessage>;

type InternalThreadControl = MainThreadRuntime & {
  __internal_threadBinding?: {
    getState?: () => {
      getMessageById?: (messageId: string) => unknown;
      switchToBranch?: (branchId: string) => void;
    };
  };
};

type CompletedResponseInput = {
  promptId: string;
  responseId: string;
  sourcePromptId?: string | null;
  text: string;
  artifactIds?: string[];
};

type UseCanvasBranchSubmissionOptions = {
  applyCompletedResponse: (input: CompletedResponseInput) => unknown;
  artifactIndex: ReadonlyMap<string, SessionArtifact>;
  cancelDraft: () => void;
  canvasConversationNodes: ThreadGraphNodeModel[];
  clearRequestError: () => void;
  draft: GraphBranchIntent | null;
  draftBranchSpec: BranchSpec | null;
  draftContextArtifacts: SessionArtifact[];
  llmEnabled: boolean;
  modelId: string;
  provider: ModelProvider;
  requestError: string | null;
  runtime: AssistantRuntime;
  setRequestError: (value: string | null) => void;
};

type PendingOutputRun = {
  sourcePromptId: string;
  artifactIds: string[];
  preSubmitSnapshot: ThreadExport;
  preSubmitExternalState: ThreadExternalState;
  persistSuspensionToken: SessionPersistSuspensionToken;
  submissionToken: number;
  abortController: AbortController;
};

const ASSISTANT_FIRST_PARENT_CONTEXT =
  "Continue from the saved assistant response below; treat it as conversation context.";

export function orderThreadSnapshotForImport(snapshot: ThreadExport): ThreadExport {
  const entryById = new Map(
    snapshot.messages.map((entry) => [entry.message.id, entry] as const),
  );
  const ordered: ThreadExportEntry[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const invalid = new Set<string>();

  const visit = (entry: ThreadExportEntry): boolean => {
    const id = entry.message.id;
    if (visited.has(id)) return true;
    if (invalid.has(id)) return false;
    if (visiting.has(id)) {
      invalid.add(id);
      return false;
    }
    visiting.add(id);
    if (entry.parentId) {
      const parent = entryById.get(entry.parentId);
      if (!parent || !visit(parent)) {
        visiting.delete(id);
        invalid.add(id);
        return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(entry);
    return true;
  };

  snapshot.messages.forEach(visit);
  if (snapshot.headId && !visited.has(snapshot.headId)) {
    throw new Error("The active Canvas branch has an invalid parent chain.");
  }
  return { ...snapshot, messages: ordered };
}

export function repairThreadSnapshotFromVisibleBranch(
  snapshot: ThreadExport,
  visibleMessages: readonly ThreadExportEntry["message"][],
): ThreadExport {
  const messages = [...snapshot.messages];
  const indexById = new Map(
    messages.map((entry, index) => [entry.message.id, index] as const),
  );

  visibleMessages.forEach((message, index) => {
    const entry = {
      parentId: visibleMessages[index - 1]?.id ?? null,
      message,
    } as ThreadExportEntry;
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, messages.length);
      messages.push(entry);
    } else {
      messages[existingIndex] = entry;
    }
  });

  return orderThreadSnapshotForImport({
    ...snapshot,
    headId: visibleMessages.at(-1)?.id ?? snapshot.headId ?? null,
    messages,
  });
}

const isUiMessage = (value: unknown): value is UIMessage =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { id?: unknown }).id === "string" &&
  ((value as { role?: unknown }).role === "user" ||
    (value as { role?: unknown }).role === "assistant" ||
    (value as { role?: unknown }).role === "system") &&
  Array.isArray((value as { parts?: unknown }).parts);

export function collectVisibleExternalMessageChain(
  visibleMessages: readonly ThreadMessage[],
  externalState: ThreadExternalState,
): UIMessage[] {
  const durableMessages = visibleMessages.filter(
    (message) => !message.id.startsWith("__error__"),
  );
  const fallbackById = new Map(
    externalState.messages
      .filter((entry) => isUiMessage(entry.message))
      .map((entry) => [entry.message.id, entry.message] as const),
  );
  const seenExternalIds = new Set<string>();

  return durableMessages.flatMap((message) => {
    const boundMessages = getExternalStoreMessages<UIMessage>(message);
    const validBoundMessages = boundMessages.every(isUiMessage)
      ? boundMessages
      : [];
    const fallbackMessage = fallbackById.get(message.id);
    const rawMessages =
      validBoundMessages.length > 0
        ? validBoundMessages
        : fallbackMessage
          ? [fallbackMessage]
          : [];

    if (rawMessages.length === 0) {
      throw new Error(
        `The external message backing Canvas node ${message.id} is unavailable.`,
      );
    }
    rawMessages.forEach((rawMessage) => {
      if (seenExternalIds.has(rawMessage.id)) {
        throw new Error(
          `The external conversation contains duplicate message ${rawMessage.id}.`,
        );
      }
      seenExternalIds.add(rawMessage.id);
    });
    return rawMessages;
  });
}

function orderExternalStateForRestore(
  externalState: ThreadExternalState,
): ThreadExternalState {
  const entryById = new Map(
    externalState.messages.map((entry) => [entry.message.id, entry] as const),
  );
  if (entryById.size !== externalState.messages.length) {
    throw new Error("The external conversation contains duplicate message ids.");
  }

  const ordered: ThreadExternalState["messages"] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error("The external conversation contains a parent cycle.");
    }
    const entry = entryById.get(id);
    if (!entry) {
      throw new Error(`The external conversation is missing parent ${id}.`);
    }
    visiting.add(id);
    if (entry.parentId) visit(entry.parentId);
    visiting.delete(id);
    visited.add(id);
    ordered.push(entry);
  };

  externalState.messages.forEach((entry) => visit(entry.message.id));
  if (externalState.headId && !entryById.has(externalState.headId)) {
    throw new Error("The external conversation head is unavailable.");
  }
  return { ...externalState, messages: ordered };
}

export function repairExternalStateFromVisibleBranch(
  externalState: ThreadExternalState,
  visibleMessages: readonly UIMessage[],
): ThreadExternalState {
  if (
    !externalState ||
    typeof externalState !== "object" ||
    !Array.isArray((externalState as { messages?: unknown }).messages)
  ) {
    throw new Error("The external conversation state is unavailable.");
  }
  const repository = externalState;
  const messages = repository.messages.filter(
    (entry) => !entry.message.id.startsWith("__error__"),
  );
  const indexById = new Map(
    messages.map((entry, index) => [entry.message.id, index] as const),
  );
  visibleMessages.forEach((message, index) => {
    const entry = {
      parentId: visibleMessages[index - 1]?.id ?? null,
      message,
    };
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, messages.length);
      messages.push(entry);
    } else {
      messages[existingIndex] = entry;
    }
  });

  return orderExternalStateForRestore({
    ...repository,
    headId: visibleMessages.at(-1)?.id ?? repository.headId ?? null,
    messages,
  });
}

const getExportedMessageText = (entry: ThreadExportEntry) =>
  entry.message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

export function findCompletedRuntimeRun(
  snapshot: ThreadExport,
  beforeMessageIds: ReadonlySet<string>,
) {
  const newEntries = snapshot.messages.filter(
    (entry) => !beforeMessageIds.has(entry.message.id),
  );
  const promptById = new Map(
    newEntries
      .filter((entry) => entry.message.role === "user")
      .map((entry) => [entry.message.id, entry] as const),
  );
  const responseEntry = [...newEntries].reverse().find((entry) => {
    if (
      entry.message.role !== "assistant" ||
      entry.message.id.startsWith("__error__") ||
      !entry.parentId
    ) {
      return false;
    }
    return (
      promptById.has(entry.parentId) &&
      (!entry.message.status || entry.message.status.type === "complete") &&
      getExportedMessageText(entry).length > 0
    );
  });
  const promptEntry = responseEntry?.parentId
    ? promptById.get(responseEntry.parentId) ?? null
    : null;

  return {
    promptEntry,
    responseEntry: responseEntry ?? null,
    responseText: responseEntry ? getExportedMessageText(responseEntry) : "",
  };
}

const waitForCanvasCommit = async () => {
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => resolve()),
  );
};

const waitForAdapterSettle = async (delayMs = 100) => {
  await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
  await waitForCanvasCommit();
};

async function restoreThreadSnapshot(
  thread: MainThreadRuntime,
  snapshot: ThreadExport,
  externalState: ThreadExternalState,
) {
  const importableSnapshot = orderThreadSnapshotForImport(snapshot);
  if (importableSnapshot.messages.length !== snapshot.messages.length) {
    throw new Error("The saved Canvas repository has an invalid parent topology.");
  }
  const importableExternalState = orderExternalStateForRestore(externalState);
  const expectedHeadId = importableSnapshot.headId ?? null;
  const expectedIds = new Set(
    importableSnapshot.messages.map((entry) => entry.message.id),
  );
  const expectedParentById = new Map(
    importableSnapshot.messages.map(
      (entry) => [entry.message.id, entry.parentId] as const,
    ),
  );

  const unexpectedVisibleIds = thread
    .getState()
    .messages.map((message) => message.id)
    .filter((id) => !expectedIds.has(id) && !id.startsWith("__error__"))
    .reverse();
  for (const messageId of unexpectedVisibleIds) {
    try {
      await thread.deleteMessage(messageId);
      await waitForAdapterSettle();
    } catch {
      // A concurrent adapter update may already have removed this message.
    }
  }

  const matchesExpectedSnapshot = () => {
    const restored = thread.export();
    const restoredEntries = restored.messages.filter(
      (entry) => !entry.message.id.startsWith("__error__"),
    );
    const restoredIds = new Set(
      restoredEntries.map((entry) => entry.message.id),
    );
    return (
      (restored.headId ?? null) === expectedHeadId &&
      expectedIds.size === restoredIds.size &&
      [...expectedIds].every((id) => restoredIds.has(id)) &&
      restoredEntries.every(
        (entry) =>
          expectedParentById.get(entry.message.id) === entry.parentId,
      )
    );
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const internalState = (thread as InternalThreadControl).__internal_threadBinding?.getState?.();
    if (
      expectedHeadId &&
      internalState?.getMessageById?.(expectedHeadId) &&
      typeof internalState.switchToBranch === "function"
    ) {
      internalState.switchToBranch(expectedHeadId);
    } else {
      thread.reset();
    }

    await waitForAdapterSettle();
    thread.importExternalState(importableExternalState);
    await waitForAdapterSettle();
    if (!matchesExpectedSnapshot()) continue;
    await waitForAdapterSettle(150);
    if (matchesExpectedSnapshot()) {
      notifySessionRuntimeReplaced(
        importableSnapshot as unknown as SessionThreadExport,
      );
      return;
    }
  }

  throw new Error("The previous Canvas branch could not be restored.");
}

export function buildCanvasContextMessages(
  nodes: ThreadGraphNodeModel[],
  parentId: string | null,
  scope: ContextScope,
  promptText: string,
) {
  type ScopedContextMessage = {
    id?: string;
    role: "user" | "assistant" | "system";
    content: string;
  };
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const toMessage = (
    node: ThreadGraphNodeModel | undefined,
  ): ScopedContextMessage | null =>
    node && (node.role === "user" || node.role === "assistant")
      ? {
          id: node.id,
          role: node.role as "user" | "assistant",
          content: node.text,
        }
      : null;
  let history: ScopedContextMessage[] = [];

  if (scope === "parent") {
    const message = parentId ? toMessage(byId.get(parentId)) : null;
    history = message
      ? message.role === "assistant"
        ? [
            { role: "user", content: ASSISTANT_FIRST_PARENT_CONTEXT },
            message,
          ]
        : [message]
      : [];
  } else if (scope === "branch") {
    const lineage: ThreadGraphNodeModel[] = [];
    const visited = new Set<string>();
    let current = parentId ? byId.get(parentId) : undefined;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      lineage.push(current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    history = lineage.reverse().flatMap((node) => {
      const message = toMessage(node);
      return message ? [message] : [];
    });
  } else {
    history = [...nodes]
      .sort((a, b) => a.idx - b.idx || a.id.localeCompare(b.id))
      .flatMap((node) => {
        const message = toMessage(node);
        return message ? [message] : [];
      });
  }

  return [
    ...history,
    { role: "user" as const, content: promptText.trim() },
  ].filter((message) => message.content.length > 0);
}

export function findCompletedCanvasRunNodes(
  currentNodes: ThreadGraphNodeModel[],
  beforeNodeIds: ReadonlySet<string>,
) {
  const newNodes = currentNodes.filter(
    (node) => !beforeNodeIds.has(node.id),
  );
  const responseNode = [...newNodes]
    .sort((a, b) => (b.idx ?? 0) - (a.idx ?? 0))
    .find((node) => node.role === "assistant");
  const promptNode = responseNode?.parentId
    ? currentNodes.find((node) => node.id === responseNode.parentId) ?? null
    : [...newNodes]
        .sort((a, b) => (b.idx ?? 0) - (a.idx ?? 0))
        .find((node) => node.role === "user") ?? null;

  return { promptNode, responseNode: responseNode ?? null };
}

export function isCompletedRuntimeResponse(
  snapshot: unknown,
  responseId: string,
) {
  if (!snapshot || typeof snapshot !== "object") return false;
  const messages = (snapshot as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  const entry = messages.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const message = (candidate as { message?: unknown }).message;
    return (
      !!message &&
      typeof message === "object" &&
      (message as { id?: unknown }).id === responseId
    );
  });
  if (!entry || typeof entry !== "object") return false;
  const message = (entry as { message?: unknown }).message;
  if (!message || typeof message !== "object") return false;
  const status = (message as { status?: unknown }).status;
  return (
    !!status &&
    typeof status === "object" &&
    (status as { type?: unknown }).type === "complete"
  );
}

export function useCanvasBranchSubmission({
  applyCompletedResponse,
  artifactIndex,
  cancelDraft,
  canvasConversationNodes,
  clearRequestError,
  draft,
  draftBranchSpec,
  draftContextArtifacts,
  llmEnabled,
  modelId,
  provider,
  requestError,
  runtime,
  setRequestError,
}: UseCanvasBranchSubmissionOptions) {
  const [isSubmittingBranch, setIsSubmittingBranch] = React.useState(false);
  const [canvasDraftError, setCanvasDraftError] = React.useState<string | null>(
    null,
  );
  const branchSubmissionLockRef = React.useRef(false);
  const pendingOutputRunRef = React.useRef<PendingOutputRun | null>(null);
  const submissionTokenRef = React.useRef(0);
  const canvasConversationNodesRef = React.useRef<ThreadGraphNodeModel[]>(
    canvasConversationNodes,
  );

  React.useEffect(() => {
    canvasConversationNodesRef.current = canvasConversationNodes;
  }, [canvasConversationNodes]);

  const rollbackPendingTransaction = React.useCallback(
    (expectedSubmissionToken: number, message: string | null) => {
      const pending = pendingOutputRunRef.current;
      if (
        !pending ||
        pending.submissionToken !== expectedSubmissionToken ||
        submissionTokenRef.current !== expectedSubmissionToken
      ) {
        return false;
      }

      pendingOutputRunRef.current = null;
      pending.abortController.abort();
      void (async () => {
        let finalMessage = message;
        try {
          if (runtime.threads.main.getState().isRunning) {
            try {
              runtime.threads.main.cancelRun();
            } catch {
              // The provider may end between the state read and cancellation.
            }
            await ensureThreadIdle(runtime.threads.main);
          }
          await restoreThreadSnapshot(
            runtime.threads.main,
            pending.preSubmitSnapshot,
            pending.preSubmitExternalState,
          );
        } catch (error) {
          console.error("Canvas branch rollback failed", error);
          finalMessage = finalMessage
            ? `${finalMessage} The provisional branch could not be rolled back; reload before retrying.`
            : "The provisional branch could not be rolled back; reload before retrying.";
        } finally {
          resumeSessionPersist(pending.persistSuspensionToken);
        }

        branchSubmissionLockRef.current = false;
        setIsSubmittingBranch(false);
        if (finalMessage) {
          setCanvasDraftError(finalMessage);
          setRequestError(finalMessage);
        }
      })();
      return true;
    },
    [runtime.threads.main, setRequestError],
  );

  const handleCancelRun = React.useCallback(() => {
    const pending = pendingOutputRunRef.current;
    if (pending) {
      rollbackPendingTransaction(pending.submissionToken, null);
      clearRequestError();
      setCanvasDraftError(null);
      return;
    }

    submissionTokenRef.current += 1;
    clearRequestError();
    setCanvasDraftError(null);
    branchSubmissionLockRef.current = false;
    setIsSubmittingBranch(false);
    try {
      runtime.threads.main.cancelRun();
    } catch {
      const message = "Unable to cancel the current run.";
      setCanvasDraftError(message);
      setRequestError(message);
    }
  }, [
    clearRequestError,
    rollbackPendingTransaction,
    runtime.threads.main,
    setRequestError,
  ]);

  const handleCancelPromptDraft = React.useCallback(() => {
    const pending = pendingOutputRunRef.current;
    if (pending) {
      rollbackPendingTransaction(pending.submissionToken, null);
    } else {
      submissionTokenRef.current += 1;
    }
    branchSubmissionLockRef.current = false;
    setIsSubmittingBranch(false);
    setCanvasDraftError(null);
    clearRequestError();
    cancelDraft();
  }, [cancelDraft, clearRequestError, rollbackPendingTransaction]);

  const handleSubmitBranchDraft = React.useCallback(() => {
    if (!draftBranchSpec || !draft || !llmEnabled) return;
    if (!draft.contextScope) {
      const message =
        "Choose Parent, Branch, or Tree context before running this draft.";
      setCanvasDraftError(message);
      setRequestError(message);
      return;
    }
    if (branchSubmissionLockRef.current) return;

    branchSubmissionLockRef.current = true;
    const submissionToken = submissionTokenRef.current + 1;
    submissionTokenRef.current = submissionToken;
    const activeDraft = { ...draft, contextScope: draft.contextScope };

    void (async () => {
      let submitted = false;
      try {
        setIsSubmittingBranch(true);
        setCanvasDraftError(null);
        clearRequestError();

        const threadReady = await ensureThreadIdle(runtime.threads.main);
        if (!threadReady) {
          branchSubmissionLockRef.current = false;
          setCanvasDraftError(CANVAS_BRANCH_CANCEL_FAILURE);
          setRequestError(CANVAS_BRANCH_CANCEL_FAILURE);
          return;
        }
        if (
          !branchSubmissionLockRef.current ||
          submissionTokenRef.current !== submissionToken
        ) {
          return;
        }

        await forceSessionPersist();
        if (
          !branchSubmissionLockRef.current ||
          submissionTokenRef.current !== submissionToken
        ) {
          return;
        }

        const persistSuspensionToken = suspendSessionPersist();
        let preSubmitSnapshot: ThreadExport;
        let preSubmitExternalState: ThreadExternalState;
        try {
          const exportedSnapshot = runtime.threads.main.export();
          const exportedExternalState =
            runtime.threads.main.exportExternalState() as ThreadExternalState;
          const visibleMessages = runtime.threads.main
            .getState()
            .messages.filter((message) => !message.id.startsWith("__error__"));
          const visibleExternalMessages = collectVisibleExternalMessageChain(
            visibleMessages,
            exportedExternalState,
          );
          const clonedSnapshot =
            typeof structuredClone === "function"
              ? structuredClone(exportedSnapshot)
              : exportedSnapshot;
          const clonedVisibleMessages =
            typeof structuredClone === "function"
              ? structuredClone(visibleMessages)
              : visibleMessages;
          preSubmitSnapshot = repairThreadSnapshotFromVisibleBranch(
            clonedSnapshot,
            clonedVisibleMessages,
          );
          preSubmitExternalState = repairExternalStateFromVisibleBranch(
            typeof structuredClone === "function"
              ? structuredClone(exportedExternalState)
              : exportedExternalState,
            typeof structuredClone === "function"
              ? structuredClone(visibleExternalMessages)
              : visibleExternalMessages,
          );
        } catch {
          resumeSessionPersist(persistSuspensionToken);
          branchSubmissionLockRef.current = false;
          const message =
            "Canvas branching could not capture the current conversation. Try again.";
          setCanvasDraftError(message);
          setRequestError(message);
          return;
        }

        const contextMessages = buildCanvasContextMessages(
          canvasConversationNodesRef.current,
          draftBranchSpec.parentId,
          activeDraft.contextScope,
          activeDraft.text,
        );
        const contextArtifacts =
          draftContextArtifacts.length > 0
            ? toLlmContextArtifacts(draftContextArtifacts)
            : undefined;
        const outputArtifactTypes = activeDraft.outputArtifactIds.map(
          (artifactId) => artifactIndex.get(artifactId)?.semanticType ?? null,
        );
        const appendMessage = buildBranchAppendMessage(draftBranchSpec, {
          contextScope: activeDraft.contextScope,
          contextMessages,
          contextArtifacts,
          contextNodeIds:
            draftContextArtifacts.length > 0
              ? draftContextArtifacts.map((artifact) => artifact.id)
              : undefined,
          historyMode:
            activeDraft.contextScope === "parent" ? "last" : "full",
          inputArtifactIds: activeDraft.inputArtifactIds,
          modelId,
          outputArtifactIds: activeDraft.outputArtifactIds,
          outputArtifactTypes,
          provider,
          requireContextScope: true,
          text: activeDraft.text,
        });

        if (!appendMessage) {
          resumeSessionPersist(persistSuspensionToken);
          branchSubmissionLockRef.current = false;
          const message =
            "Branch draft is empty. Add a prompt before creating the branch.";
          setCanvasDraftError(message);
          setRequestError(message);
          return;
        }

        const abortController = new AbortController();
        pendingOutputRunRef.current = {
          sourcePromptId: CANVAS_PROMPT_DRAFT_NODE_ID,
          artifactIds: [...activeDraft.outputArtifactIds],
          preSubmitSnapshot,
          preSubmitExternalState,
          persistSuspensionToken,
          submissionToken,
          abortController,
        };
        submitted = true;

        const runId = createCanvasBranchRunId();
        const response = await fetch("/api/canvas-branch-runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildCanvasBranchRunRequest({
              contextArtifacts,
              contextMessages,
              contextScope: activeDraft.contextScope,
              model: modelId,
              outputArtifactTypes,
              prompt: activeDraft.text,
              promptId: appendMessage.id,
              provider,
              runId,
            }),
          ),
          signal: abortController.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | CanvasBranchRunResponse
          | null;
        if (!response.ok) {
          const structuredError =
            typeof payload?.error === "object" && payload.error !== null
              ? payload.error.message
              : typeof payload?.error === "string"
                ? payload.error
                : undefined;
          throw new Error(
            structuredError ||
              payload?.message ||
              `Canvas branch run failed: ${response.status}`,
          );
        }

        const responseText = payload?.text?.trim() ?? "";
        if (!responseText) {
          throw new Error("The model returned an empty branch response.");
        }
        const responseId =
          typeof payload?.runId === "string" && payload.runId.trim()
            ? payload.runId
            : runId;

        const nextExternalState = appendCompletedCanvasBranch({
          externalState: preSubmitExternalState,
          modelId: payload?.modelId || modelId,
          provider: payload?.provider || provider,
          responseId,
          responseText,
          userMessage: appendMessage,
        });
        runtime.threads.main.importExternalState(nextExternalState);
        await waitForAdapterSettle();

        const committedSnapshot = runtime.threads.main.export();
        const promptEntry = committedSnapshot.messages.find(
          (entry) => entry.message.id === appendMessage.id,
        );
        const responseEntry = committedSnapshot.messages.find(
          (entry) => entry.message.id === responseId,
        );
        if (
          !promptEntry ||
          promptEntry.parentId !== draftBranchSpec.parentId ||
          !responseEntry ||
          responseEntry.parentId !== appendMessage.id
        ) {
          throw new Error(
            "The completed branch could not be committed to the conversation tree.",
          );
        }

        applyCompletedResponse({
          promptId: appendMessage.id,
          responseId,
          sourcePromptId: CANVAS_PROMPT_DRAFT_NODE_ID,
          artifactIds: [...activeDraft.outputArtifactIds],
          text: responseText,
        });

        pendingOutputRunRef.current = null;
        notifySessionRuntimeReplaced(
          committedSnapshot as unknown as SessionThreadExport,
        );
        resumeSessionPersist(persistSuspensionToken);
        branchSubmissionLockRef.current = false;
        setCanvasDraftError(null);
        cancelDraft();
        setIsSubmittingBranch(false);
        void forceSessionPersist();
      } catch (error) {
        const aborted =
          error instanceof DOMException && error.name === "AbortError";
        if (aborted) {
          rollbackPendingTransaction(submissionToken, null);
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : "Canvas branching failed. Try again from the selected node.";
        if (!rollbackPendingTransaction(submissionToken, message)) {
          branchSubmissionLockRef.current = false;
          pendingOutputRunRef.current = null;
          setCanvasDraftError(message);
          setRequestError(message);
        }
      } finally {
        if (!submitted) {
          setIsSubmittingBranch(false);
        }
      }
    })();
  }, [
    applyCompletedResponse,
    artifactIndex,
    cancelDraft,
    clearRequestError,
    draft,
    draftBranchSpec,
    draftContextArtifacts,
    llmEnabled,
    modelId,
    provider,
    runtime.threads.main,
    rollbackPendingTransaction,
    setRequestError,
  ]);

  React.useEffect(() => {
    if (!requestError) return;
    const pending = pendingOutputRunRef.current;
    if (pending) {
      rollbackPendingTransaction(pending.submissionToken, requestError);
      return;
    }
    if (draft) setCanvasDraftError(requestError);
  }, [draft, requestError, rollbackPendingTransaction]);

  React.useEffect(
    () => () => {
      const pending = pendingOutputRunRef.current;
      if (!pending) return;
      pendingOutputRunRef.current = null;
      submissionTokenRef.current += 1;
      pending.abortController.abort();
      if (runtime.threads.main.getState().isRunning) {
        try {
          runtime.threads.main.cancelRun();
        } catch {
          // The run may already have ended while the Canvas was unmounting.
        }
      }
      void restoreThreadSnapshot(
        runtime.threads.main,
        pending.preSubmitSnapshot,
        pending.preSubmitExternalState,
      )
        .catch(() => {
          // Unmount cleanup is best-effort; persistence still remains isolated.
        })
        .finally(() => {
          resumeSessionPersist(pending.persistSuspensionToken);
        });
    },
    [runtime.threads.main],
  );

  return {
    canvasDraftError,
    handleCancelPromptDraft,
    handleCancelRun,
    handleSubmitBranchDraft,
    isSubmittingBranch,
    setCanvasDraftError,
  };
}
