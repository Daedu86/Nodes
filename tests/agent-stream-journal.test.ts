import { describe, expect, it } from "vitest";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import {
  createAgentSessionJournal,
  loadAgentSessionJournal,
} from "@/lib/server/agent-session-journal";
import { createAgentStreamJournalProjector } from "@/lib/server/agent-stream-journal";

const createMemoryRepository = (): AgentWorkRepository => {
  const events: AgentEventRecord[] = [];
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
      .sort((left, right) => {
        const byTime = right.createdAt.localeCompare(left.createdAt);
        return byTime || left.id.localeCompare(right.id);
      });
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

async function seedStartedRun(
  repository: AgentWorkRepository,
  runtime: "codex" | "nooa",
  eventIngestion?: "stream" | "callback",
) {
  const journal = createAgentSessionJournal({
    ownerId: "owner-1",
    sessionId: "session-1",
    projectId: "project-1",
    journalId: `journal-${runtime}`,
    repository,
  });
  journal.log.append("runtime.run", {
    runtime,
    status: "started",
    runId: "run-1",
    eventIngestion,
  });
  await journal.flush();
}

describe("agent stream journal projection", () => {
  it("keeps SSE read-only when the journal is callback-owned", async () => {
    const repository = createMemoryRepository();
    await seedStartedRun(repository, "nooa", "callback");
    const projector = await createAgentStreamJournalProjector({
      ownerId: "owner-1",
      runtime: "nooa",
      runId: "run-1",
      repository,
    });
    expect(projector).toBeNull();
  });

  it("projects NOOA lifecycle into one durable replay log and deduplicates reconnects", async () => {
    const repository = createMemoryRepository();
    await seedStartedRun(repository, "nooa");
    const projector = await createAgentStreamJournalProjector({
      ownerId: "owner-1",
      runtime: "nooa",
      runId: "run-1",
      repository,
    });
    expect(projector).not.toBeNull();

    await projector?.projectValue({
      id: "event-1",
      runId: "run-1",
      nodeId: "node-1",
      runtime: "nooa",
      type: "agent.started",
      source: "runtime",
      sequence: 1,
      createdAt: "2026-08-16T00:00:01.000Z",
      parentRunId: null,
      payload: {},
    });
    const message = {
      id: "event-2",
      runId: "run-1",
      nodeId: "node-1",
      runtime: "nooa",
      type: "agent.message.completed",
      source: "runtime",
      sequence: 2,
      createdAt: "2026-08-16T00:00:02.000Z",
      parentRunId: null,
      payload: { text: "finished", model: "test" },
    };
    await projector?.projectValue(message);
    await projector?.projectValue(message);
    await projector?.projectValue({
      id: "event-3",
      runId: "run-1",
      nodeId: "node-1",
      runtime: "nooa",
      type: "run.completed",
      source: "runtime",
      sequence: 3,
      createdAt: "2026-08-16T00:00:03.000Z",
      parentRunId: null,
      payload: {},
    });

    const loaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-nooa",
      repository,
    });
    expect(loaded.log.events().filter((event) => event.type === "runtime.event")).toHaveLength(3);
    expect(loaded.log.deriveModelMessages()).toEqual([
      expect.objectContaining({ role: "assistant", content: "finished" }),
    ]);
    expect(loaded.log.events().at(-1)).toMatchObject({
      type: "turn.end",
      data: { reason: "completed" },
    });
  });

  it("normalizes Codex envelopes before projecting the final assistant message", async () => {
    const repository = createMemoryRepository();
    await seedStartedRun(repository, "codex");
    const projector = await createAgentStreamJournalProjector({
      ownerId: "owner-1",
      runtime: "codex",
      runId: "run-1",
      repository,
    });

    await projector?.projectValue({
      id: "codex-event-1",
      runId: "run-1",
      threadId: "thread-1",
      parentRunId: null,
      agentId: "agent-1",
      createdAt: "2026-08-16T00:00:01.000Z",
      notification: {
        method: "item/completed",
        params: {
          item: {
            id: "message-1",
            type: "agentMessage",
            content: [{ text: "hello from codex" }],
          },
        },
      },
    });

    const loaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-codex",
      repository,
    });
    expect(loaded.log.deriveModelMessages()).toEqual([
      expect.objectContaining({ role: "assistant", content: "hello from codex" }),
    ]);
    expect(loaded.log.events()).toContainEqual(
      expect.objectContaining({
        type: "runtime.event",
        data: expect.objectContaining({
          eventId: "codex-event-1",
          eventType: "agent.message.completed",
        }),
      }),
    );
  });
});
