import type { AgentSessionEvent } from "@/lib/agents/kernel/session-log";

export type AgentRunMetrics = {
  firstEventAt: string | null;
  lastEventAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  contextCompactions: number;
  estimatedTokensSaved: number;
  toolCalls: number;
  toolErrors: number;
  approvalRequests: number;
  interruptedTurns: number;
  continuationCount: number;
};

const timestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Projects operational metrics from the durable journal only. It deliberately
 * does not invent runner-local counters (for example outbox depth or HTTP retry
 * attempts) that are not present in the journal; those can be composed with
 * this projection by an infrastructure telemetry adapter.
 */
export function collectAgentRunMetrics(
  events: readonly AgentSessionEvent[],
): AgentRunMetrics {
  let inputTokens = 0;
  let outputTokens = 0;
  let contextCompactions = 0;
  let estimatedTokensSaved = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let approvalRequests = 0;
  let interruptedTurns = 0;
  let continuationCount = 0;

  for (const event of events) {
    switch (event.type) {
      case "assistant.message":
        inputTokens += event.data.usage?.inputTokens ?? 0;
        outputTokens += event.data.usage?.outputTokens ?? 0;
        break;
      case "context.compaction":
        contextCompactions += 1;
        estimatedTokensSaved += Math.max(
          0,
          event.data.estimatedTokensBefore - event.data.estimatedTokensAfter,
        );
        break;
      case "tool.call":
        toolCalls += 1;
        break;
      case "tool.result":
        if (event.data.isError) toolErrors += 1;
        break;
      case "runtime.event":
        if (event.data.eventType === "approval.requested") approvalRequests += 1;
        break;
      case "turn.end":
        if (event.data.reason === "interrupted") interruptedTurns += 1;
        break;
      case "continuation.source":
        continuationCount += 1;
        break;
      default:
        break;
    }
  }

  const firstEventAt = events[0]?.createdAt ?? null;
  const lastEventAt = events.at(-1)?.createdAt ?? null;
  const firstMs = firstEventAt ? timestamp(firstEventAt) : null;
  const lastMs = lastEventAt ? timestamp(lastEventAt) : null;

  return {
    firstEventAt,
    lastEventAt,
    durationMs: firstMs !== null && lastMs !== null ? Math.max(0, lastMs - firstMs) : null,
    inputTokens,
    outputTokens,
    contextCompactions,
    estimatedTokensSaved,
    toolCalls,
    toolErrors,
    approvalRequests,
    interruptedTurns,
    continuationCount,
  };
}
