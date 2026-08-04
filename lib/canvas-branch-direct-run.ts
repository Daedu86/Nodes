import type { MessageFormatRepository } from "@assistant-ui/core";
import type { UIMessage } from "ai";
import type { ContextScope } from "@/components/context/graph-branch-intent";
import type { ModelProvider } from "@/components/context/model-config";
import type {
  LlmContextArtifact,
  SessionArtifactSemanticType,
} from "@/lib/session-artifacts";

export type DirectBranchContextMessage = {
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
};

export type DirectBranchAppendMessage = {
  id: string;
  parentId: string | null;
  role: "user";
  content: Array<{ type: "text"; text: string }>;
  metadata: { custom: Record<string, unknown> };
};

export type CanvasBranchRunResponse = {
  // Request-error responses can be either a plain string or a structured object.
  // Keep this unknown at the network boundary; the caller narrows it at runtime.
  error?: unknown;
  message?: string;
  modelId?: string;
  provider?: string;
  runId?: string | null;
  text?: string;
};

const MAX_BRANCH_SYSTEM_CONTEXT_CHARS = 64 * 1024;
const CONTEXT_TRUNCATION_MARKER =
  "\n\n[... middle of conversation context truncated to stay within model limits ...]\n\n";

export const createCanvasBranchRunId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `canvas-branch-${crypto.randomUUID()}`
    : `canvas-branch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const clampContext = (value: string) => {
  if (value.length <= MAX_BRANCH_SYSTEM_CONTEXT_CHARS) return value;
  const available = MAX_BRANCH_SYSTEM_CONTEXT_CHARS - CONTEXT_TRUNCATION_MARKER.length;
  const head = Math.floor(available / 3);
  return `${value.slice(0, head)}${CONTEXT_TRUNCATION_MARKER}${value.slice(
    -(available - head),
  )}`;
};

export function buildCanvasBranchSystemContext(
  contextMessages: DirectBranchContextMessage[],
  contextScope: ContextScope,
  currentPrompt: string,
) {
  const trimmedPrompt = currentPrompt.trim();
  const history =
    contextMessages.at(-1)?.role === "user" &&
    contextMessages.at(-1)?.content.trim() === trimmedPrompt
      ? contextMessages.slice(0, -1)
      : contextMessages;

  if (history.length === 0) return undefined;

  const intro =
    contextScope === "tree"
      ? "The following messages come from the full conversation tree. They can belong to sibling branches, so treat every node as reference context rather than assuming one linear dialogue. Use relevant facts from any branch when answering the current user prompt."
      : contextScope === "branch"
        ? "The following messages are the lineage of the selected conversation branch. Preserve their roles and use them as the conversation history for the current user prompt."
        : "The following messages are the selected parent context for a Canvas follow-up. Preserve their roles and use them as reference context for the current user prompt.";

  const transcript = history
    .map((message, index) => {
      const idSuffix = message.id ? ` | id=${message.id}` : "";
      return `[Context node ${index + 1} | role=${message.role}${idSuffix}]\n${message.content}`;
    })
    .join("\n\n");

  return clampContext(`${intro}\n\n${transcript}`);
}

export const buildCanvasBranchRunRequest = ({
  contextArtifacts,
  contextMessages,
  contextScope,
  model,
  outputArtifactTypes,
  prompt,
  promptId,
  provider,
  runId,
}: {
  contextArtifacts?: LlmContextArtifact[];
  contextMessages: DirectBranchContextMessage[];
  contextScope: ContextScope;
  model: string;
  outputArtifactTypes: Array<SessionArtifactSemanticType | null>;
  prompt: string;
  promptId: string;
  provider: ModelProvider;
  runId: string;
}) => ({
  ...(contextArtifacts?.length ? { contextArtifacts } : {}),
  contextScope,
  model,
  outputArtifactTypes,
  prompt,
  promptId,
  provider,
  runId,
  system: buildCanvasBranchSystemContext(contextMessages, contextScope, prompt),
});

export function appendCompletedCanvasBranch({
  externalState,
  modelId,
  provider,
  responseId,
  responseText,
  userMessage,
}: {
  externalState: MessageFormatRepository<UIMessage>;
  modelId: string;
  provider: string;
  responseId: string;
  responseText: string;
  userMessage: DirectBranchAppendMessage;
}): MessageFormatRepository<UIMessage> {
  const userExternalMessage: UIMessage = {
    id: userMessage.id,
    role: "user",
    parts: userMessage.content.map((part) => ({
      type: "text" as const,
      text: part.text,
    })),
    metadata: userMessage.metadata,
  };
  const assistantExternalMessage: UIMessage = {
    id: responseId,
    role: "assistant",
    parts: [{ type: "text", text: responseText }],
    metadata: {
      custom: {
        model: modelId,
        provider,
      },
    },
  };
  const replacedIds = new Set([userMessage.id, responseId]);

  return {
    ...externalState,
    headId: responseId,
    messages: [
      ...externalState.messages.filter(
        (entry) => !replacedIds.has(entry.message.id),
      ),
      { parentId: userMessage.parentId, message: userExternalMessage },
      { parentId: userMessage.id, message: assistantExternalMessage },
    ],
  };
}
