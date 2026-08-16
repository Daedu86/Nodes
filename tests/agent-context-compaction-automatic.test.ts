import { describe, expect, it } from "vitest";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import { createAgentSessionJournal } from "@/lib/server/agent-session-journal";
import {
  projectRuntimeEventToJournal,
  type AgentStreamRuntimeEvent,
} from "@/lib/server/agent-stream-journal";

const createMemoryRepository = (): AgentWorkRepository => {
  const events: AgentEventRecord[] = [];
  const filtered = (ownerId: string, options: AgentWorkListOptions = {}) => {
    const rows = events
      .filter((event) => event.ownerId === ownerId)
      .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
      .filter((event) => !options.projectId || event.projectId === options.projectId)
      .filter((event) => !options.eventType || event.eventType === options.eventType)
      .filter((event) => !options.eventTypePrefix || event.eventType.startsWith(options.eventTypePrefix))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
    return rows.slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 80));
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

const completedMessage = (id: string, text: string): AgentStreamRuntimeEvent => ({
  id,
  runId: "run-1",
  runtime: "nooa",
  type: "agent.message.completed",
  source: "runtime",
  createdAt: new Date().toISOString(),
  sequence: 1,
  nodeId: "node-1",
  parentRunId: null,
  payload: { text },
});

describe("automatic durable context compaction", () => {
  it("compacts after model-visible runtime growth and deduplicates replayed events", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-auto",
      repository,
    });
    journal.log.append("request.snapshot", {
      provider: "nooa",
      model: "test-model",
      contextWindow: 500,
    });
    for (let index = 0; index < 12; index += 1) {
      if (index % 2 === 0) {
        journal.log.appendSurface("user.message", {
          messageId: `u-${index}`,
          content: `user-${index} ${"x".repeat(320)}`,
          source: "human",
        });
      } else {
        journal.log.appendSurface("assistant.message", {
          messageId: `a-${index}`,
          content: `assistant-${index} ${"y".repeat(320)}`,
        });
      }
    }
    journal.log.append("runtime.run", {
      runtime: "nooa",
      status: "started",
      runId: "run-1",
    });
    await journal.flush();

    const event = completedMessage("event-auto", `latest ${"z".repeat(320)}`);
    await expect(projectRuntimeEventToJournal(journal, event)).resolves.toBe(true);
    expect(journal.log.events().filter((entry) => entry.type === "context.compaction")).toHaveLength(1);
    expect(journal.log.deriveModelMessages().length).toBeLessThan(13);
    expect(journal.log.events()).toContainEqual(
      expect.objectContaining({
        type: "context.compaction",
        data: expect.objectContaining({
          triggerReason: "context-window-pressure",
          estimatorId: "nodes.chars-per-4-v1",
          summarizerId: "nodes.structural-extractive-v1",
        }),
      }),
    );

    await expect(projectRuntimeEventToJournal(journal, event)).resolves.toBe(false);
    expect(journal.log.events().filter((entry) => entry.type === "context.compaction")).toHaveLength(1);
  });

  it("does not compact a small surface under the fallback threshold", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-small",
      journalId: "journal-small",
      repository,
    });
    journal.log.append("request.snapshot", { provider: "nooa" });
    journal.log.appendSurface("user.message", {
      messageId: "small-user",
      content: "short context",
      source: "human",
    });
    journal.log.append("runtime.run", {
      runtime: "nooa",
      status: "started",
      runId: "run-1",
    });
    await journal.flush();

    await projectRuntimeEventToJournal(journal, completedMessage("event-small", "short answer"));
    expect(journal.log.events().filter((entry) => entry.type === "context.compaction")).toHaveLength(0);
  });
});
