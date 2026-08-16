import type { AgentModelMessage } from "@/lib/agents/kernel/session-log";
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
  retainTailMessages?: number;
  minimumMessagesToCompact?: number;
  estimateTokens: AgentContextTokenEstimator;
  summarize: AgentContextSummarizer;
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

const throwIfAborted = (signal: AbortSignal) => {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Agent context compaction was cancelled.");
};

/**
 * Pluggable context-window compactor. It chooses a prefix of the current model
 * surface, asks an injected summarizer for a checkpoint, verifies the proposed
 * replacement actually reduces the estimated context, then commits one
 * append-only surface replacement with exact provenance.
 */
export class AgentContextCompactor {
  private readonly thresholdTokens: number;
  private readonly retainTailMessages: number;
  private readonly minimumMessagesToCompact: number;
  private readonly estimateTokens: AgentContextTokenEstimator;
  private readonly summarize: AgentContextSummarizer;
  private readonly createCompactionId: () => string;

  constructor(options: AgentContextCompactorOptions) {
    this.thresholdTokens = positiveInteger(options.thresholdTokens, "thresholdTokens");
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
    this.createCompactionId = options.createCompactionId ?? (() => crypto.randomUUID());
  }

  async compactIfNeeded(
    log: AgentSessionLog,
    signal: AbortSignal,
  ): Promise<AgentContextCompactionResult | null> {
    throwIfAborted(signal);
    const messages = log.deriveModelMessages();
    const estimatedTokensBefore = this.estimateTokens(messages);
    if (estimatedTokensBefore <= this.thresholdTokens) return null;

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
    const estimatedTokensAfter = this.estimateTokens(hypothetical);
    if (estimatedTokensAfter >= estimatedTokensBefore) {
      throw new Error(
        "Agent context compaction was rejected because the checkpoint did not reduce estimated context.",
      );
    }

    const compactionId = this.createCompactionId();
    if (!compactionId.trim()) throw new Error("Agent context compaction id must not be empty.");
    const checkpoint = log.replaceSurfaceRange(
      "user.message",
      {
        messageId: `context-checkpoint:${compactionId}`,
        content: summary,
        source: "checkpoint",
      },
      {
        startSequence: selected[0].sequence,
        endSequence: selected[selected.length - 1].sequence,
      },
    );
    log.append("context.compaction", {
      compactionId,
      checkpointSequence: checkpoint.sequence,
      sourceSequences,
      estimatedTokensBefore,
      estimatedTokensAfter,
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
