import type {
  AgentContextCheckpointMetadata,
  AgentContextCompactionTrigger,
  AgentModelMessage,
  AgentSessionEventMap,
} from "@/lib/agents/kernel/session-log";
import { AgentSessionLog } from "@/lib/agents/kernel/session-log";

export type AgentContextTokenEstimator = (
  messages: readonly AgentModelMessage[],
) => number;

export type AgentContextSummarizer = (input: {
  messages: readonly AgentModelMessage[];
  signal: AbortSignal;
}) => Promise<string>;

export type AgentContextCompactorOptions = {
  thresholdTokens: number;
  contextWindowPressureRatio?: number;
  retainTailMessages?: number;
  minimumMessagesToCompact?: number;
  estimateTokens: AgentContextTokenEstimator;
  summarize: AgentContextSummarizer;
  estimatorId?: string;
  summarizerId?: string;
  createCompactionId?: () => string;
};

export type AgentContextCompactionResult = {
  compactionId: string;
  checkpointSequence: number;
  sourceSequences: number[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
};

const positiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent context ${field} must be a positive safe integer.`);
  }
  return value;
};

const nonNegativeInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Agent context ${field} must be a non-negative safe integer.`);
  }
  return value;
};

const boundedRatio = (value: number, field: string) => {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Agent context ${field} must be greater than 0 and at most 1.`);
  }
  return value;
};

const identifier = (value: string | undefined, fallback: string, field: string) => {
  const normalized = value?.trim() || fallback;
  if (!normalized) throw new Error(`Agent context ${field} must not be empty.`);
  return normalized;
};

const throwIfAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Agent context compaction was cancelled.");
};

const latestRequestSnapshot = (
  log: AgentSessionLog,
): AgentSessionEventMap["request.snapshot"] | null => {
  const events = log.events();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "request.snapshot") return event.data;
  }
  return null;
};

/**
 * Pluggable context-window compactor. It chooses a prefix of the current model
 * surface, asks an injected summarizer for a checkpoint, verifies the proposed
 * replacement actually reduces the estimated context, then commits one
 * append-only surface replacement with exact provenance. When a canonical
 * request snapshot advertises a context window, compaction is triggered before
 * that limit instead of waiting for the absolute fallback threshold.
 */
export class AgentContextCompactor {
  private readonly thresholdTokens: number;
  private readonly contextWindowPressureRatio: number;
  private readonly retainTailMessages: number;
  private readonly minimumMessagesToCompact: number;
  private readonly estimateTokens: AgentContextTokenEstimator;
  private readonly summarize: AgentContextSummarizer;
  private readonly estimatorId: string;
  private readonly summarizerId: string;
  private readonly createCompactionId: () => string;

  constructor(options: AgentContextCompactorOptions) {
    this.thresholdTokens = positiveInteger(options.thresholdTokens, "thresholdTokens");
    this.contextWindowPressureRatio = boundedRatio(
      options.contextWindowPressureRatio ?? 0.8,
      "contextWindowPressureRatio",
    );
    this.retainTailMessages = nonNegativeInteger(
      options.retainTailMessages ?? 6,
      "retainTailMessages",
    );
    this.minimumMessagesToCompact = positiveInteger(
      options.minimumMessagesToCompact ?? 2,
      "minimumMessagesToCompact",
    );
    this.estimateTokens = options.estimateTokens;
    this.summarize = options.summarize;
    this.estimatorId = identifier(options.estimatorId, "custom", "estimatorId");
    this.summarizerId = identifier(options.summarizerId, "custom", "summarizerId");
    this.createCompactionId = options.createCompactionId ?? (() => crypto.randomUUID());
  }

  async compactIfNeeded(
    log: AgentSessionLog,
    signal: AbortSignal,
  ): Promise<AgentContextCompactionResult | null> {
    throwIfAborted(signal);
    const messages = log.deriveModelMessages();
    const estimatedTokensBefore = nonNegativeInteger(
      this.estimateTokens(messages),
      "estimatedTokensBefore",
    );
    const snapshot = latestRequestSnapshot(log);
    const contextWindow =
      snapshot?.contextWindow !== undefined &&
      Number.isSafeInteger(snapshot.contextWindow) &&
      snapshot.contextWindow > 0
        ? snapshot.contextWindow
        : undefined;
    const contextWindowTrigger = contextWindow
      ? Math.max(1, Math.floor(contextWindow * this.contextWindowPressureRatio))
      : null;
    const triggerTokens = contextWindowTrigger
      ? Math.min(this.thresholdTokens, contextWindowTrigger)
      : this.thresholdTokens;
    const triggerReason: AgentContextCompactionTrigger =
      contextWindowTrigger !== null && contextWindowTrigger <= this.thresholdTokens
        ? "context-window-pressure"
        : "absolute-threshold";

    if (estimatedTokensBefore <= triggerTokens) return null;

    const compactCount = messages.length - this.retainTailMessages;
    if (compactCount < this.minimumMessagesToCompact) return null;

    const selected = messages.slice(0, compactCount);
    const retained = messages.slice(compactCount);
    const summary = (await this.summarize({ messages: selected, signal })).trim();
    throwIfAborted(signal);
    if (!summary) throw new Error("Agent context summarizer returned an empty checkpoint.");

    const sourceSequences = selected.map((message) => message.sequence);
    const hypothetical: AgentModelMessage[] = [
      {
        role: "user",
        sequence: 0,
        messageId: "context-checkpoint-preview",
        content: summary,
        source: "checkpoint",
        sourceSequences,
      },
      ...retained,
    ];
    const estimatedTokensAfter = nonNegativeInteger(
      this.estimateTokens(hypothetical),
      "estimatedTokensAfter",
    );
    if (estimatedTokensAfter >= estimatedTokensBefore) {
      throw new Error(
        "Agent context compaction was rejected because the checkpoint did not reduce estimated context.",
      );
    }

    const compactionId = this.createCompactionId();
    if (!compactionId.trim()) throw new Error("Agent context compaction id must not be empty.");
    const checkpointMetadata: AgentContextCheckpointMetadata = {
      compactionId,
      estimatedTokensBefore,
      estimatedTokensAfter,
      triggerTokens,
      triggerReason,
      provider: snapshot?.provider,
      model: snapshot?.model,
      contextWindow,
      estimatorId: this.estimatorId,
      summarizerId: this.summarizerId,
    };
    const checkpoint = log.replaceSurfaceRange(
      "user.message",
      {
        messageId: `context-checkpoint:${compactionId}`,
        content: summary,
        source: "checkpoint",
        checkpoint: checkpointMetadata,
      },
      {
        startSequence: selected[0].sequence,
        endSequence: selected[selected.length - 1].sequence,
      },
    );
    log.append("context.compaction", {
      ...checkpointMetadata,
      checkpointSequence: checkpoint.sequence,
      sourceSequences,
    });

    return {
      compactionId,
      checkpointSequence: checkpoint.sequence,
      sourceSequences,
      estimatedTokensBefore,
      estimatedTokensAfter,
    };
  }
}
