import type { ThreadRuntime } from "@assistant-ui/react";
import type { HistoryMode, ModelProvider } from "@/components/context/session-ui-state";
import type { ContextScope } from "@/components/context/graph-branch-intent";
import type { BranchSpec } from "@/lib/thread-branching";
import {
  getOutputFormatInstruction,
  type LlmContextArtifact,
  type SessionArtifactSemanticType,
} from "@/lib/session-artifacts";

type InternalThreadRuntime = ThreadRuntime & {
  __internal_threadBinding?: {
    getState?: () => {
      append?: (message: Parameters<ThreadRuntime["append"]>[0]) => void;
    };
  };
};

export type ExecuteBranchSpecOptions = {
  contextArtifacts?: LlmContextArtifact[];
  contextNodeIds?: string[];
  inputArtifactIds?: string[];
  outputArtifactIds?: string[];
  outputArtifactTypes?: Array<SessionArtifactSemanticType | null | undefined>;
  historyMode: HistoryMode;
  contextScope?: ContextScope | null;
  contextMessages?: Array<{ id?: string; role: "system" | "user" | "assistant"; content: string }>;
  requireContextScope?: boolean;
  modelId: string;
  provider: ModelProvider;
  text: string;
};

type ScopedContextMessage = NonNullable<ExecuteBranchSpecOptions["contextMessages"]>[number];

const MAX_DURABLE_TREE_CONTEXT_CHARS = 32 * 1024;
const MAX_DURABLE_TREE_CONTEXT_MESSAGES = 48;
const MAX_DURABLE_TREE_MESSAGE_CHARS = 4 * 1024;
const MAX_DURABLE_TREE_PROMPT_CHARS = 8 * 1024;
const DURABLE_TREE_TRUNCATION_MESSAGE: ScopedContextMessage = {
  role: "system",
  content:
    "[Full tree context truncated in durable metadata. The live request uses the durable tree context recovered by the server.]",
};

const uniqueIds = (value: string[] | undefined) =>
  value ? Array.from(new Set(value.filter(Boolean))) : [];

const createBranchMessageId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `canvas-branch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const truncateDurableTreeMessage = (
  message: ScopedContextMessage,
  maxChars = MAX_DURABLE_TREE_MESSAGE_CHARS,
): ScopedContextMessage => {
  if (message.content.length <= maxChars) return message;
  return {
    ...message,
    content: `${message.content.slice(0, Math.max(0, maxChars - 24))}\n[... truncated ...]`,
  };
};

const getSerializedMessageSize = (message: ScopedContextMessage) =>
  JSON.stringify(message).length;

const boundDurableTreeContextMessages = (
  contextMessages: ScopedContextMessage[],
): ScopedContextMessage[] => {
  if (contextMessages.length === 0) return [];

  const currentPrompt = truncateDurableTreeMessage(
    contextMessages.at(-1)!,
    MAX_DURABLE_TREE_PROMPT_CHARS,
  );
  const history = contextMessages
    .slice(0, -1)
    .map((message) => truncateDurableTreeMessage(message));
  const normalized = [...history, currentPrompt];

  if (
    normalized.length <= MAX_DURABLE_TREE_CONTEXT_MESSAGES &&
    JSON.stringify(normalized).length <= MAX_DURABLE_TREE_CONTEXT_CHARS
  ) {
    return normalized;
  }

  const markerSize = getSerializedMessageSize(DURABLE_TREE_TRUNCATION_MESSAGE);
  const promptSize = getSerializedMessageSize(currentPrompt);
  const headBudget = Math.floor(MAX_DURABLE_TREE_CONTEXT_CHARS / 3);
  let totalSize = markerSize + promptSize + 4;
  const head: ScopedContextMessage[] = [];
  const tail: ScopedContextMessage[] = [];
  const headIndexes = new Set<number>();

  for (let index = 0; index < history.length; index += 1) {
    if (head.length >= 6) break;
    const candidate = history[index]!;
    const candidateSize = getSerializedMessageSize(candidate) + 1;
    if (totalSize + candidateSize > headBudget) break;
    head.push(candidate);
    headIndexes.add(index);
    totalSize += candidateSize;
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (headIndexes.has(index)) continue;
    if (head.length + tail.length + 2 >= MAX_DURABLE_TREE_CONTEXT_MESSAGES) break;
    const candidate = history[index]!;
    const candidateSize = getSerializedMessageSize(candidate) + 1;
    if (totalSize + candidateSize > MAX_DURABLE_TREE_CONTEXT_CHARS) break;
    tail.push(candidate);
    totalSize += candidateSize;
  }

  return [
    ...head,
    DURABLE_TREE_TRUNCATION_MESSAGE,
    ...tail.reverse(),
    currentPrompt,
  ];
};

export const buildBranchAppendMessage = (
  spec: BranchSpec,
  options: ExecuteBranchSpecOptions,
) => {
  const {
    contextArtifacts,
    contextNodeIds,
    contextScope,
    contextMessages,
    historyMode,
    modelId,
    provider,
    text,
  } = options;
  const trimmedText = text.trim();
  if (!trimmedText || (options.requireContextScope && !contextScope)) return null;

  const inputArtifactIds = uniqueIds(
    options.inputArtifactIds ?? contextArtifacts?.map((artifact) => artifact.id),
  );
  const outputArtifactIds = uniqueIds(options.outputArtifactIds);
  const formattingInstruction = getOutputFormatInstruction(
    options.outputArtifactTypes ?? [],
  );
  const promptText = `${trimmedText}${formattingInstruction}`;
  const durableContextMessages =
    contextScope === "tree" && contextMessages
      ? boundDurableTreeContextMessages(contextMessages)
      : contextMessages;
  // Full-tree context is intentionally omitted from runConfig. Assistant UI can enter a
  // local running state before its AI SDK transport starts when a large custom tree payload
  // is attached to the run config. The server already recovers contextMessages from the
  // appended user message metadata, so keeping tree context durable there avoids that stall.
  const requestContextMessages = contextScope === "tree" ? undefined : contextMessages;

  const baseScopedConfig = {
    ...(contextScope ? { contextScope } : {}),
    historyMode,
    model: modelId,
    provider,
  };
  const durableScopedConfig = {
    ...(durableContextMessages && durableContextMessages.length > 0
      ? { contextMessages: durableContextMessages }
      : {}),
    ...baseScopedConfig,
  };
  const scopedRequestConfig = {
    ...(contextArtifacts && contextArtifacts.length > 0
      ? { contextArtifacts }
      : {}),
    ...(requestContextMessages && requestContextMessages.length > 0
      ? { contextMessages: requestContextMessages }
      : {}),
    ...baseScopedConfig,
  };

  return {
    id: createBranchMessageId(),
    parentId: spec.parentId,
    sourceId: spec.sourceId,
    role: spec.targetRole,
    content: [{ type: "text" as const, text: promptText }],
    metadata: {
      custom: {
        branchAnchorId: spec.anchorId,
        branchAnchorRole: spec.anchorRole,
        branchOperation: spec.operation,
        ...durableScopedConfig,
        ...(contextNodeIds && contextNodeIds.length > 0
          ? { contextNodeIds: [...contextNodeIds] }
          : {}),
        ...(inputArtifactIds.length > 0 ? { inputArtifactIds } : {}),
        ...(outputArtifactIds.length > 0 ? { outputArtifactIds } : {}),
      },
    },
    runConfig: {
      custom: {
        ...scopedRequestConfig,
        ...(inputArtifactIds.length > 0 ? { inputArtifactIds } : {}),
        ...(outputArtifactIds.length > 0 ? { outputArtifactIds } : {}),
      },
    },
    startRun: spec.startRun,
  };
};

export const executeBranchSpec = (
  threadRuntime: ThreadRuntime,
  spec: BranchSpec,
  options: ExecuteBranchSpecOptions,
) => {
  const message = buildBranchAppendMessage(spec, options);
  if (!message) return false;

  // Let assistant-ui append the branch message and start its run as one
  // runtime transaction. Calling startRun separately can race the repository
  // publication of the appended message and produce "Message not found" for
  // off-head branches.
  const appendMessage = message;

  // assistant-ui's public ThreadRuntime.append coerces `parentId: null` into the
  // current head message. Only root-level branching needs the internal append to
  // preserve `null`; non-root branches use the public append so the new branch is
  // registered through the supported runtime surface.
  if (appendMessage.parentId === null) {
    const internalState = (threadRuntime as InternalThreadRuntime).__internal_threadBinding?.getState?.();
    const internalAppend =
      internalState && typeof internalState.append === "function"
        ? internalState.append.bind(internalState)
        : null;

    if (internalAppend) {
      internalAppend(appendMessage);
    } else {
      threadRuntime.append(appendMessage);
    }
  } else {
    threadRuntime.append(appendMessage);
  }

  return true;
};
