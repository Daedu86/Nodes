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
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

describe("DurableAgentSessionJournal", () => {
  it("flushes and reconstructs an append-only kernel journal", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      projectId: "project-1",
      journalId: "journal-1",
      repository,
    });

    journal.log.append("request.snapshot", {
      assemblyId: "assembly-1",
      runtime: "codex",
      provider: "codex",
      model: "gpt-test",
      systemPrompt: "policy",
    });
    journal.log.appendSurface("user.message", {
      messageId: "message-1",
      content: "hello",
      source: "human",
    });
    journal.log.append("runtime.run", {
      runtime: "codex",
      status: "started",
      runId: "run-1",
    });
    await journal.flush();

    const loaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-1",
      repository,
    });

    expect(loaded.identity.projectId).toBe("project-1");
    expect(loaded.log.events()).toEqual(journal.log.events());
    expect(loaded.log.deriveModelMessages()).toEqual([
      {
        role: "user",
        sequence: 2,
        messageId: "message-1",
        content: "hello",
        source: "human",
        sourceSequences: [],
      },
    ]);
  });

  it("persists crash repair as an explicit interrupted turn", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-2",
      repository,
    });
    journal.log.append("turn.start", { turn: 1 });
    await journal.flush();

    const loaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-2",
      repository,
    });
    await loaded.repairInterruptedTail();

    expect(loaded.log.events().at(-1)).toMatchObject({
      type: "turn.end",
      data: { turn: 1, reason: "interrupted" },
    });
  });
});
