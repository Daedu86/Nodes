import { describe, expect, it } from "vitest";
import { AgentContextCompactor } from "@/lib/agents/kernel/context-compaction";
import { AgentSessionLog } from "@/lib/agents/kernel/session-log";

describe("AgentSessionLog", () => {
  it("derives model-visible history from an append-only surface with provenance", () => {
    const log = new AgentSessionLog({ clock: () => "2026-08-16T00:00:00.000Z" });
    const first = log.appendSurface("user.message", {
      messageId: "u1",
      content: "first",
      source: "human",
    });
    const second = log.appendSurface("assistant.message", {
      messageId: "a1",
      content: "answer",
    });
    const third = log.appendSurface("user.message", {
      messageId: "u2",
      content: "follow-up",
      source: "human",
    });

    const checkpoint = log.replaceSurfaceRange(
      "user.message",
      {
        messageId: "checkpoint-1",
        content: "summary",
        source: "checkpoint",
      },
      { startSequence: first.sequence, endSequence: second.sequence },
    );

    expect(checkpoint.sourceSequences).toEqual([first.sequence, second.sequence]);
    expect(log.deriveModelMessages()).toEqual([
      expect.objectContaining({
        role: "user",
        sequence: checkpoint.sequence,
        content: "summary",
        sourceSequences: [first.sequence, second.sequence],
      }),
      expect.objectContaining({
        role: "user",
        sequence: third.sequence,
        content: "follow-up",
      }),
    ]);
    expect(log.events()).toHaveLength(4);
  });

  it("repairs an interrupted durable turn without discarding prior events", () => {
    const log = new AgentSessionLog();
    log.append("turn.start", { turn: 1 });
    log.appendSurface("user.message", {
      messageId: "u1",
      content: "work",
      source: "human",
    });

    const repair = log.repairInterruptedTail();

    expect(repair).toEqual(expect.objectContaining({
      type: "turn.end",
      data: { turn: 1, reason: "interrupted" },
    }));
    expect(log.events()).toHaveLength(3);
  });

  it("compacts old model-visible history only when the replacement reduces context", async () => {
    const log = new AgentSessionLog();
    log.appendSurface("user.message", {
      messageId: "u1",
      content: "one",
      source: "human",
    });
    log.appendSurface("assistant.message", {
      messageId: "a1",
      content: "two",
    });
    log.appendSurface("user.message", {
      messageId: "u2",
      content: "three",
      source: "human",
    });
    log.appendSurface("assistant.message", {
      messageId: "a2",
      content: "four",
    });

    const compactor = new AgentContextCompactor({
      thresholdTokens: 250,
      retainTailMessages: 1,
      estimateTokens: (messages) => messages.length * 100,
      summarize: async () => "checkpoint summary",
      createCompactionId: () => "compact-1",
    });

    const result = await compactor.compactIfNeeded(log, new AbortController().signal);

    expect(result).toEqual({
      compactionId: "compact-1",
      checkpointSequence: 5,
      sourceSequences: [1, 2, 3],
      estimatedTokensBefore: 400,
      estimatedTokensAfter: 200,
    });
    expect(log.deriveModelMessages()).toEqual([
      expect.objectContaining({
        role: "user",
        content: "checkpoint summary",
        source: "checkpoint",
        sourceSequences: [1, 2, 3],
      }),
      expect.objectContaining({ role: "assistant", content: "four" }),
    ]);
    expect(log.events().at(-1)).toEqual(expect.objectContaining({
      type: "context.compaction",
      data: expect.objectContaining({ checkpointSequence: 5 }),
    }));
  });
});
