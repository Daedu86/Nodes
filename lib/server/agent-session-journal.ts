import { createHash } from "node:crypto";
import {
  AgentSessionLog,
  type AgentSessionEvent,
} from "@/lib/agents/kernel/session-log";
import type {
  AgentEventRecord,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import { getAgentWorkRepository } from "@/lib/persistence/repositories";

const SESSION_EVENT_PREFIX = "kernel.session.";
const PAGE_SIZE = 500;

export type AgentSessionJournalIdentity = {
  ownerId: string;
  sessionId: string;
  projectId: string | null;
  journalId: string;
};

export type CreateAgentSessionJournalInput = {
  ownerId: string;
  sessionId: string;
  projectId?: string | null;
  journalId?: string;
  repository?: AgentWorkRepository;
};

const nonEmpty = (value: string, field: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Agent session journal ${field} must not be empty.`);
  return normalized;
};

const journalEventId = (journalId: string, sequence: number) => {
  const hex = createHash("sha256")
    .update(`${journalId}:${sequence}`)
    .digest("hex")
    .slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readStoredEnvelope = (
  payload: Record<string, unknown>,
): { journalId: string; event: AgentSessionEvent } | null => {
  if (typeof payload.journalId !== "string" || !payload.journalId.trim()) return null;
  if (!isRecord(payload.event)) return null;
  return {
    journalId: payload.journalId,
    event: payload.event as AgentSessionEvent,
  };
};

const readStoredEvent = (
  payload: Record<string, unknown>,
  journalId: string,
): AgentSessionEvent | null => {
  const stored = readStoredEnvelope(payload);
  return stored?.journalId === journalId ? stored.event : null;
};

/**
 * Durable wrapper around `AgentSessionLog`. The in-memory log remains the
 * canonical surface/replay implementation; this class only persists newly
 * appended events through Nodes' existing AgentWorkRepository abstraction.
 * That means both file and Supabase backends work without a second database
 * schema or a parallel persistence configuration.
 */
export class DurableAgentSessionJournal {
  readonly identity: AgentSessionJournalIdentity;
  readonly log: AgentSessionLog;

  private readonly repository: AgentWorkRepository;
  private flushedSequence: number;

  constructor(
    identity: AgentSessionJournalIdentity,
    log: AgentSessionLog,
    repository: AgentWorkRepository,
    flushedSequence = 0,
  ) {
    this.identity = identity;
    this.log = log;
    this.repository = repository;
    this.flushedSequence = flushedSequence;
  }

  async flush(): Promise<void> {
    const pending = this.log
      .events()
      .filter((event) => event.sequence > this.flushedSequence);

    for (const event of pending) {
      await this.repository.recordAgentEvent(this.identity.ownerId, {
        id: journalEventId(this.identity.journalId, event.sequence),
        tokenId: null,
        eventType: `${SESSION_EVENT_PREFIX}${event.type}`,
        method: "KERNEL",
        route: "agent-session-journal",
        sessionId: this.identity.sessionId,
        projectId: this.identity.projectId,
        payload: {
          journalId: this.identity.journalId,
          event,
        },
        createdAt: event.createdAt,
        ownerId: this.identity.ownerId,
      });
      this.flushedSequence = event.sequence;
    }
  }

  async repairInterruptedTail(): Promise<AgentSessionEvent<"turn.end"> | null> {
    const repaired = this.log.repairInterruptedTail();
    if (repaired) await this.flush();
    return repaired;
  }
}

export function createAgentSessionJournal(
  input: CreateAgentSessionJournalInput,
): DurableAgentSessionJournal {
  const identity: AgentSessionJournalIdentity = {
    ownerId: nonEmpty(input.ownerId, "ownerId"),
    sessionId: nonEmpty(input.sessionId, "sessionId"),
    projectId: input.projectId?.trim() || null,
    journalId: nonEmpty(
      input.journalId ?? globalThis.crypto.randomUUID(),
      "journalId",
    ),
  };
  return new DurableAgentSessionJournal(
    identity,
    new AgentSessionLog(),
    input.repository ?? getAgentWorkRepository(),
  );
}

export async function loadAgentSessionJournal(
  input: CreateAgentSessionJournalInput & { journalId: string },
): Promise<DurableAgentSessionJournal> {
  const ownerId = nonEmpty(input.ownerId, "ownerId");
  const sessionId = nonEmpty(input.sessionId, "sessionId");
  const journalId = nonEmpty(input.journalId, "journalId");
  const repository = input.repository ?? getAgentWorkRepository();
  const records: AgentEventRecord[] = [];

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await repository.listAgentEvents(ownerId, {
      sessionId,
      eventTypePrefix: SESSION_EVENT_PREFIX,
      limit: PAGE_SIZE,
      offset,
    });
    records.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const events = records
    .map((record) => readStoredEvent(record.payload, journalId))
    .filter((event): event is AgentSessionEvent => event !== null)
    .sort((left, right) => left.sequence - right.sequence);
  const log = new AgentSessionLog({ seed: events });
  const projectId =
    input.projectId?.trim() ||
    records.find((record) => record.payload.journalId === journalId)?.projectId ||
    null;

  return new DurableAgentSessionJournal(
    { ownerId, sessionId, projectId, journalId },
    log,
    repository,
    log.latestSequence(),
  );
}

export async function findAgentSessionJournalForRun(input: {
  ownerId: string;
  runtime: string;
  runId: string;
  repository?: AgentWorkRepository;
}): Promise<DurableAgentSessionJournal | null> {
  const ownerId = nonEmpty(input.ownerId, "ownerId");
  const runtime = nonEmpty(input.runtime, "runtime");
  const runId = nonEmpty(input.runId, "runId");
  const repository = input.repository ?? getAgentWorkRepository();

  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await repository.listAgentEvents(ownerId, {
      eventType: `${SESSION_EVENT_PREFIX}runtime.run`,
      limit: PAGE_SIZE,
      offset,
    });

    for (const record of page) {
      const stored = readStoredEnvelope(record.payload);
      if (!stored || stored.event.type !== "runtime.run") continue;
      if (
        stored.event.data.runtime !== runtime ||
        stored.event.data.runId !== runId ||
        !record.sessionId
      ) {
        continue;
      }
      return loadAgentSessionJournal({
        ownerId,
        sessionId: record.sessionId,
        projectId: record.projectId,
        journalId: stored.journalId,
        repository,
      });
    }

    if (page.length < PAGE_SIZE) break;
  }

  return null;
}
