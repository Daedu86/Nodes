import { describe, expect, it } from "vitest";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import {
  AgentContinuationStateError,
  AgentContinuationTargetError,
  createAgentContinuationSection,
  resolveAgentContinuation,
  seedAgentContinuationJournal,
} from "@/lib/server/agent-continuity";
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
      .filter((event) =>
        !options.eventTypePrefix || event.eventType.startsWith(options.eventTypePrefix))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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

const createSource = async (
  repository: AgentWorkRepository,
  status: "started" | "completed" = "completed",
) => {
  const journal = createAgentSessionJournal({
    ownerId: "owner-1",
    sessionId: "session-1",
    projectId: "project-1",
    journalId: "journal-source",
    repository,
  });
  journal.log.append("request.snapshot", {
    assemblyId: "assembly-source",
    runtime: "codex",
    provider: "codex",
    model: "gpt-test",
  });
  journal.log.appendSurface("user.message", {
    messageId: "u1",
    content: "original question",
    source: "human",
  });
  journal.log.appendSurface("assistant.message", {
    messageId: "a1",
    content: "original answer",
  });
  journal.log.append("runtime.run", {
    runtime: "codex",
    status: "started",
    runId: "run-source",
  });
  if (status === "completed") {
    journal.log.append("runtime.run", {
      runtime: "codex",
      status: "completed",
      runId: "run-source",
    });
  }
  await journal.flush();
  return journal;
};

describe("durable agent continuation", () => {
  it("resumes a terminal run in the same target and records exact durable lineage", async () => {
    const repository = createMemoryRepository();
    const source = await createSource(repository);
    const continuation = await resolveAgentContinuation({
      ownerId: "owner-1",
      targetRuntime: "codex",
      targetSessionId: "session-1",
      targetProjectId: "project-1",
      continuation: {
        kind: "resume",
        sourceRuntime: "codex",
        sourceRunId: "run-source",
      },
      repository,
    });

    expect(continuation.sourceJournalId).toBe("journal-source");
    expect(continuation.sourceBoundarySequence).toBe(source.log.latestSequence());
    expect(continuation.sourceSurfaceSequences).toEqual([2, 3]);
    expect(continuation.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(createAgentContinuationSection(continuation).text).toContain(
      "not evidence that the provider has resumed",
    );

    const child = seedAgentContinuationJournal(continuation, {
      ownerId: "owner-1",
      repository,
    });
    await child.flush();
    const reloaded = await loadAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: child.identity.journalId,
      repository,
    });
    expect(reloaded.log.events()[0]).toMatchObject({
      type: "continuation.source",
      data: {
        kind: "resume",
        sourceJournalId: "journal-source",
        sourceRunId: "run-source",
        sourceBoundarySequence: source.log.latestSequence(),
        sourceSurfaceSequences: [2, 3],
      },
    });
    expect(reloaded.log.deriveModelMessages().map((message) => message.content)).toEqual([
      "original question",
      "original answer",
    ]);
    expect(source.log.events()).toHaveLength(5);
  });

  it("rejects resume while the source is still running", async () => {
    const repository = createMemoryRepository();
    await createSource(repository, "started");
    await expect(resolveAgentContinuation({
      ownerId: "owner-1",
      targetRuntime: "codex",
      targetSessionId: "session-1",
      targetProjectId: "project-1",
      continuation: {
        kind: "resume",
        sourceRuntime: "codex",
        sourceRunId: "run-source",
      },
      repository,
    })).rejects.toBeInstanceOf(AgentContinuationStateError);
  });

  it("permits a terminal fork into a different runtime and session", async () => {
    const repository = createMemoryRepository();
    await createSource(repository);
    const fork = await resolveAgentContinuation({
      ownerId: "owner-1",
      targetRuntime: "nooa",
      targetSessionId: "session-challenger",
      targetProjectId: "project-1",
      continuation: {
        kind: "fork",
        sourceRuntime: "codex",
        sourceRunId: "run-source",
      },
      repository,
    });
    expect(fork.targetRuntime).toBe("nooa");
    expect(fork.targetSessionId).toBe("session-challenger");
  });

  it("rejects cross-runtime resume because that is fork semantics", async () => {
    const repository = createMemoryRepository();
    await createSource(repository);
    await expect(resolveAgentContinuation({
      ownerId: "owner-1",
      targetRuntime: "nooa",
      targetSessionId: "session-1",
      targetProjectId: "project-1",
      continuation: {
        kind: "resume",
        sourceRuntime: "codex",
        sourceRunId: "run-source",
      },
      repository,
    })).rejects.toBeInstanceOf(AgentContinuationTargetError);
  });
});
