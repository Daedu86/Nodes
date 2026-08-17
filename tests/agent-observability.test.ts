import { describe, expect, it } from "vitest";
import { AgentSessionLog } from "@/lib/agents/kernel/session-log";
import { collectAgentRunMetrics } from "@/lib/agents/kernel/observability";

describe("agent runtime observability", () => {
  it("derives auditable metrics from durable journal events", () => {
    const times = [
      "2026-08-17T08:00:00.000Z",
      "2026-08-17T08:00:01.000Z",
      "2026-08-17T08:00:02.000Z",
      "2026-08-17T08:00:03.000Z",
      "2026-08-17T08:00:04.000Z",
      "2026-08-17T08:00:05.000Z",
      "2026-08-17T08:00:06.000Z",
      "2026-08-17T08:00:07.000Z",
    ];
    let index = 0;
    const log = new AgentSessionLog({ clock: () => times[index++] ?? times.at(-1)! });

    log.append("continuation.source", {
      kind: "fork",
      strategy: "nodes-durable-replay-v1",
      sourceRuntime: "codex",
      sourceRunId: "run-parent",
      sourceJournalId: "journal-parent",
      sourceSessionId: "session-parent",
      sourceProjectId: "project-1",
      sourceBoundarySequence: 10,
      sourceSurfaceSequences: [2, 4, 8],
      sourceCheckpointSequence: null,
      sourceUpdatedAt: "2026-08-17T07:59:00.000Z",
    });
    log.appendSurface("assistant.message", {
      messageId: "assistant-1",
      content: "answer",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    log.append("tool.call", { callId: "call-1", name: "search", arguments: {} });
    log.appendSurface("tool.result", {
      callId: "call-1",
      name: "search",
      content: "failed",
      isError: true,
    });
    log.append("context.compaction", {
      compactionId: "compact-1",
      checkpointSequence: 4,
      sourceSequences: [1, 2],
      estimatedTokensBefore: 1000,
      estimatedTokensAfter: 400,
    });
    log.append("runtime.event", {
      runtime: "codex",
      runId: "run-1",
      eventId: "evt-1",
      eventType: "approval.requested",
      payload: {},
    });
    log.append("turn.end", { turn: 1, reason: "interrupted" });

    expect(collectAgentRunMetrics(log.events())).toEqual({
      firstEventAt: "2026-08-17T08:00:00.000Z",
      lastEventAt: "2026-08-17T08:00:06.000Z",
      durationMs: 6000,
      inputTokens: 120,
      outputTokens: 30,
      contextCompactions: 1,
      estimatedTokensSaved: 600,
      toolCalls: 1,
      toolErrors: 1,
      approvalRequests: 1,
      interruptedTurns: 1,
      continuationCount: 1,
    });
  });
});
