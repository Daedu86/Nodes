import { AgentContextCompactor } from "@/lib/agents/kernel/context-compaction";
import type {
  AgentJsonValue,
  AgentModelMessage,
} from "@/lib/agents/kernel/session-log";
import { estimateTokenCount } from "@/lib/context-budget";
import type { DurableAgentSessionJournal } from "@/lib/server/agent-session-journal";

export const DEFAULT_AGENT_COMPACTION_THRESHOLD_TOKENS = 12_000;
export const DEFAULT_AGENT_COMPACTION_RETAIN_TAIL_MESSAGES = 8;
export const DEFAULT_AGENT_COMPACTION_PRESSURE_RATIO = 0.8;

const throwIfAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Agent context compaction was cancelled.");
};

const contentText = (content: AgentJsonValue) =>
  typeof content === "string" ? content : JSON.stringify(content);

const formatModelMessage = (message: AgentModelMessage) => {
  if (message.role === "tool") {
    return [
      `TOOL RESULT #${message.sequence} ${message.name}${message.isError ? " [error]" : ""}`,
      contentText(message.content),
    ].join("\n");
  }
  return [
    `${message.role.toUpperCase()} #${message.sequence}`,
    contentText(message.content),
  ].join("\n");
};

export const estimateAgentModelMessagesTokens = (
  messages: readonly AgentModelMessage[],
) => estimateTokenCount(messages.map(formatModelMessage).join("\n\n"));

const truncateText = (value: string, maxChars: number) => {
  if (value.length <= maxChars) return value;
  const marker = "\n…[checkpoint truncated]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
};

/**
 * Deterministic, local fallback summarizer for automatic compaction.
 * It intentionally does not call a model provider, so background
 * maintenance cannot consume user credits or bypass chat quota/audit.
 * Exact source-event provenance remains on the checkpoint itself.
 */
export async function summarizeAgentContextStructurally(input: {
  messages: readonly AgentModelMessage[];
  signal: AbortSignal;
}): Promise<string> {
  throwIfAborted(input.signal);
  const formatted = input.messages.map(formatModelMessage);
  const sourceText = formatted.join("\n\n");
  const maxChars = Math.min(
    6_000,
    Math.max(256, Math.floor(sourceText.length * 0.35)),
  );
  const headCount = Math.min(3, formatted.length);
  const remaining = Math.max(0, formatted.length - headCount);
  const tailCount = Math.min(5, remaining);
  const omitted = Math.max(0, formatted.length - headCount - tailCount);
  const sections = [
    `Durable context checkpoint for ${formatted.length} model-visible messages.`,
    ...formatted.slice(0, headCount),
    ...(omitted > 0 ? [`[${omitted} older messages omitted from checkpoint text]`] : []),
    ...(tailCount > 0 ? formatted.slice(formatted.length - tailCount) : []),
  ];
  throwIfAborted(input.signal);
  return truncateText(sections.join("\n\n"), maxChars);
}

let defaultCompactor: AgentContextCompactor | null = null;

export function getDefaultAgentContextCompactor() {
  defaultCompactor ??= new AgentContextCompactor({
    thresholdTokens: DEFAULT_AGENT_COMPACTION_THRESHOLD_TOKENS,
    contextWindowPressureRatio: DEFAULT_AGENT_COMPACTION_PRESSURE_RATIO,
    retainTailMessages: DEFAULT_AGENT_COMPACTION_RETAIN_TAIL_MESSAGES,
    minimumMessagesToCompact: 2,
    estimateTokens: estimateAgentModelMessagesTokens,
    summarize: summarizeAgentContextStructurally,
    estimatorId: "nodes.chars-per-4-v1",
    summarizerId: "nodes.structural-extractive-v1",
  });
  return defaultCompactor;
}

export async function compactAgentSessionJournalIfNeeded(
  journal: DurableAgentSessionJournal,
  signal: AbortSignal = new AbortController().signal,
) {
  return journal.compactContextIfNeeded(
    getDefaultAgentContextCompactor(),
    signal,
  );
}
