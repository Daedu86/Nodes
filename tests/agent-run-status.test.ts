import { describe, expect, it } from "vitest";
import type {
  AgentEventRecord,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import {
  AgentRunWaitTimeoutError,
  getAgentRunStatus,
  waitUntilAgentRunIdle,
} from "@/lib/agents/runtime/run-status";
import { createAgentSessionJournal } from "@/lib/server/agent-session-journal";

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

describe("durable agent run status", () => {
  it("derives running, approval wait, resumed, and terminal states from the journal", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-status",
      repository,
    });
    journal.log.append("runtime.run", {
      runtime: "nooa",
      status: "started",
      runId: "run-1",
    });
    await journal.flush();

    await expect(getAgentRunStatus({ ownerId: "owner-1", runtime: "nooa", runId: "run-1", repository })).resolves.toMatchObject({
      status: "running",
      idle: false,
      terminal: false,
    });

    journal.log.append("runtime.event", {
      runtime: "nooa",
      runId: "run-1",
      eventId: "approval-1",
      eventType: "approval.requested",
      payload: {},
    });
    await journal.flush();
    await expect(getAgentRunStatus({ ownerId: "owner-1", runtime: "nooa", runId: "run-1", repository })).resolves.toMatchObject({
      status: "waiting_for_approval",
      idle: true,
      terminal: false,
    });

    journal.log.append("runtime.event", {
      runtime: "nooa",
      runId: "run-1",
      eventId: "approval-2",
      eventType: "approval.resolved",
      payload: {},
    });
    await journal.flush();
    await expect(getAgentRunStatus({ ownerId: "owner-1", runtime: "nooa", runId: "run-1", repository })).resolves.toMatchObject({ status: "running" });

    journal.log.append("runtime.run", {
      runtime: "nooa",
      status: "completed",
      runId: "run-1",
    });
    await journal.flush();
    await expect(getAgentRunStatus({ ownerId: "owner-1", runtime: "nooa", runId: "run-1", repository })).resolves.toMatchObject({
      status: "completed",
      idle: true,
      terminal: true,
    });
  });

  it("waits until the durable run becomes approval-idle and times out deterministically", async () => {
    const repository = createMemoryRepository();
    const journal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-wait",
      repository,
    });
    journal.log.append("runtime.run", {
      runtime: "codex",
      status: "started",
      runId: "run-wait",
    });
    await journal.flush();

    const waiting = waitUntilAgentRunIdle(
      { ownerId: "owner-1", runtime: "codex", runId: "run-wait", repository },
      { pollIntervalMs: 5, timeoutMs: 1_000 },
    );
    setTimeout(() => {
      journal.log.append("runtime.event", {
        runtime: "codex",
        runId: "run-wait",
        eventId: "approval-wait",
        eventType: "approval.requested",
        payload: {},
      });
      void journal.flush();
    }, 20);

    await expect(waiting).resolves.toMatchObject({ status: "waiting_for_approval", idle: true });

    const runningJournal = createAgentSessionJournal({
      ownerId: "owner-1",
      sessionId: "session-2",
      journalId: "journal-timeout",
      repository,
    });
    runningJournal.log.append("runtime.run", {
      runtime: "codex",
      status: "started",
      runId: "run-timeout",
    });
    await runningJournal.flush();
    await expect(
      waitUntilAgentRunIdle(
        { ownerId: "owner-1", runtime: "codex", runId: "run-timeout", repository },
        { pollIntervalMs: 5, timeoutMs: 25 },
      ),
    ).rejects.toBeInstanceOf(AgentRunWaitTimeoutError);
  });
});
