import { describe, expect, it } from "vitest";
import { AgentContextCompactor } from "@/lib/agents/kernel/context-compaction";
import { AgentSessionLog } from "@/lib/agents/kernel/session-log";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import {
  createAgentSessionJournal,
  loadAgentSessionJournal,
} from "@/lib/server/agent-session-journal";

const createMemoryRepository = (failOnceEventType?: string): AgentWorkRepository => {
  const events: AgentEventRecord[] = [];
  let remainingFailure = failOnceEventType;
  const filtered = (ownerId: string, options: AgentWorkListOptions = {}) => {
    const rows = events
      .filter((event) => event.ownerId === ownerId)
      .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
      .filter((event) => !options.projectId || event.projectId === options.projectId)
      .filter((event) => !options.eventType || event.eventType === options.eventType)
      .filter(
        (event) =>
          !options.eventTypePrefix || event.eventType.startsWith(options.eventTypePrefix),
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      );
    const limit = options.limit ?? 80;
    const offset = options.offset ?? 0;
    return rows.slice(offset, offset + limit);
  };

  return {
    getAgentToken: async () => null,
    listAgentTokens: async () => [],
    revokeAgentToken: async () => null,
    upsertAgentToken: async (input) => ({
      tokenId: input.tokenId,
      ownerId: input.ownerId,
      label: input.label,
      revoked: input.revoked === true,
      expiresAt: input.expiresAt,
      lastUsedAt: input.lastUsedAt ?? null,
      createdAt: new Date(0).toISOString(),
    }),
    markAgentTokenUsed: async () => undefined,
    async recordAgentEvent(ownerId, input) {
      if (remainingFailure && input.eventType === remainingFailure) {
        remainingFailure = undefined;
        throw new Error("simulated storage interruption");
      }
      const record: AgentEventRecord = {
        id: input.id ?? `event-${events.length + 1}`,
        ownerId,
        tokenId: input.tokenId ?? null,
        eventType: input.eventType,
        method: input.method,
        route: input.route,
        sessionId: input.sessionId ?? null,
        projectId: input.projectId ?? null,
        payload: input.payload ?? {},
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      const existing = events.findIndex((event) => event.id === record.id);
      if (existing >= 0) events.splice(existing, 1, record);
      else events.push(record);
    },
    listAgentEvents: async (ownerId, options) => filtered(ownerId, options),
  };
};

const appendConversation = (log: AgentSessionLog) => {
  log.append("request.snapshot", {
    provider: "codex",
    model: "gpt-test",
    contextWindow: 300,
  });
  log.appendSurface("user.message", {
    messageId: "u1",
    content: "one",
    source: "human",
  });
  log.appendSurface("assistant.message", { messageId: "a1", content: "two" });
  log.appendSurface("user.message", {
    messageId: "u2",
    content: "three",
    source: "human",
  });
  log.appendSurface("assistant.message", { messageId: "a2", content: "four" });
};

const createCompactor = (compactionId: string) =>
  new AgentContextCompactor({
    thresholdTokens: 1_000,
    retainTailMessages: 1,
    estimateTokens: (messages) => messages.length * 100,
    summarize: async () => "checkpoint summary",
    estimatorId: "test-estimator",
    summarizerId: "test-summarizer",
    createCompactionId: () => compactionId,
  });

describe("durable context compaction", () => {
  it("uses the latest request context window as a pressure trigger with provenance", async () => {
    const log = new AgentSessionLog();
    appendConversation(log);

    const result = await createCompactor("compact-pressure").compactIfNeeded(
      log,
      new AbortController().signal,
    );

    expect(result).toEqual({
      compactionId: "compact-pressure",
      checkpointSequence: 6,
      sourceSequences: [2, 3, 4],
      estimatedTokensBefore: 400,
      estimatedTokensAfter: 200,
    });
    expect(log.events().at(-1)).toMatchObject({
      type: "context.compaction",
      data: {
        compactionId: "compact-pressure",
        triggerTokens: 240,
        triggerReason: "context-window-pressure",
        provider: "codex",
        model: "gpt-test",
        contextWindow: 300,
        estimatorId: "test-estimator",
        summarizerId: "test-summarizer",
      },
    });
  });

  it("keeps the live surface unchanged until persistence succeeds and repairs a crash gap", async () => {
    const repository = createMemoryRepository("kernel.session.context.compaction");
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-crash",
      repository,
    });
    appendConversation(journal.log);
    await journal.flush();

    await expect(
      journal.compactContextIfNeeded(
        createCompactor("compact-crash"),
        new AbortController().signal,
      ),
    ).rejects.toThrow("reload journal before continuing");
    expect(journal.log.deriveModelMessages()).toHaveLength(4);

    const loaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-crash",
      repository,
    });

    expect(loaded.log.deriveModelMessages()).toHaveLength(2);
    expect(
      loaded.log.events().filter((event) => event.type === "context.compaction"),
    ).toHaveLength(1);
    await expect(loaded.repairCompactionAudits()).resolves.toEqual([]);
  });
});
