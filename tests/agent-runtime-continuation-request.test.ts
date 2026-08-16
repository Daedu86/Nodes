import { describe, expect, it } from "vitest";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import { prepareAgentRuntimeRequest } from "@/lib/server/agent-runtime-request";
import { createAgentSessionJournal } from "@/lib/server/agent-session-journal";

const createMemoryRepository = (): AgentWorkRepository => {
  const events: AgentEventRecord[] = [];
  const filtered = (ownerId: string, options: AgentWorkListOptions = {}) => events
    .filter((event) => event.ownerId === ownerId)
    .filter((event) => !options.sessionId || event.sessionId === options.sessionId)
    .filter((event) => !options.eventType || event.eventType === options.eventType)
    .filter((event) => !options.eventTypePrefix || event.eventType.startsWith(options.eventTypePrefix))
    .slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 80));
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

describe("prepareAgentRuntimeRequest continuation wiring", () => {
  it("replays durable context before checkpointing and dispatch preparation", async () => {
    const repository = createMemoryRepository();
    const source = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      projectId: "project-1",
      journalId: "source-journal",
      repository,
    });
    source.log.appendSurface("user.message", {
      messageId: "u1",
      content: "prior context",
      source: "human",
    });
    source.log.appendSurface("assistant.message", {
      messageId: "a1",
      content: "prior result",
    });
    source.log.append("runtime.run", {
      runtime: "codex",
      status: "completed",
      runId: "run-1",
    });
    await source.flush();

    const prepared = await prepareAgentRuntimeRequest({
      runtime: "codex",
      ownerId: "owner-1",
      sessionId: "session-1",
      projectId: "project-1",
      prompt: "continue from there",
      continuation: {
        kind: "resume",
        sourceRuntime: "codex",
        sourceRunId: "run-1",
      },
      repository,
    });

    expect(prepared.continuation?.sourceJournalId).toBe("source-journal");
    expect(prepared.assembly.systemPrompt).toContain("NODES DURABLE CONTINUATION REPLAY");
    expect(prepared.assembly.effectivePrompt).toContain("prior result");
    expect(prepared.journal.log.events()[0].type).toBe("continuation.source");
    expect(prepared.journal.log.deriveModelMessages().map((message) => message.content)).toEqual([
      "prior context",
      "prior result",
      "continue from there",
    ]);
    expect(prepared.journal.log.events().at(-1)).toMatchObject({
      type: "runtime.run",
      data: { status: "requested", runId: null },
    });
  });
});
