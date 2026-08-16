import { createHash } from "node:crypto";
import type {
  AgentContextCompactionResult,
  AgentContextCompactor,
} from "@/lib/agents/kernel/context-compaction";
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
 * canonical surface/replay implementation; this class persists newly appended
 * events through Nodes' existing AgentWorkRepository abstraction.
 *
 * Durable compaction uses a fork: the replacement is persisted before the live
 * journal surface is swapped to the compacted state. If storage fails after a
 * partial write, this journal is poisoned and must be reloaded so deterministic
 * event ids and audit repair can reconcile the durable prefix safely.
 */
export class DurableAgentSessionJournal {
  readonly identity: AgentSessionJournalIdentity;

  private readonly repository: AgentWorkRepository;
  private currentLog: AgentSessionLog;
  private flushedSequence: number;
  private reloadRequired = false;

  constructor(
    identity: AgentSessionJournalIdentity,
    log: AgentSessionLog,
    repository: AgentWorkRepository,
    flushedSequence = 0,
  ) {
    this.identity = identity;
    this.currentLog = log;
    this.repository = repository;
    this.flushedSequence = flushedSequence;
  }

  get log(): AgentSessionLog {
    return this.currentLog;
  }

  async flush(): Promise<void> {
    this.assertUsable();
    const pending = this.currentLog
      .events()
      .filter((event) => event.sequence > this.flushedSequence);

    for (const event of pending) {
      await this.persistEvent(event);
      this.flushedSequence = event.sequence;
    }
  }

  async compactContextIfNeeded(
    compactor: AgentContextCompactor,
    signal: AbortSignal,
  ): Promise<AgentContextCompactionResult | null> {
    this.assertUsable();
    await this.flush();
    const candidate = this.currentLog.fork();
    const result = await compactor.compactIfNeeded(candidate, signal);
    if (!result) return null;

    const pending = candidate
      .events()
      .filter((event) => event.sequence > this.flushedSequence);
    try {
      for (const event of pending) {
        await this.persistEvent(event);
      }
    } catch (error) {
      this.reloadRequired = true;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Agent session durable compaction was interrupted; reload journal before continuing. ${message}`,
      );
    }

    this.currentLog = candidate;
    this.flushedSequence = candidate.latestSequence();
    return result;
  }

  async repairInterruptedTail(): Promise<AgentSessionEvent<"turn.end"> | null> {
    this.assertUsable();
    const repaired = this.currentLog.repairInterruptedTail();
    if (repaired) await this.flush();
    return repaired;
  }

  async repairCompactionAudits(): Promise<AgentSessionEvent<"context.compaction">[]> {
    this.assertUsable();
    const repaired = this.currentLog.repairCompactionAudits();
    if (repaired.length) await this.flush();
    return repaired;
  }

  private assertUsable() {
    if (!this.reloadRequired) return;
    throw new Error(
      "Agent session journal must be reloaded after interrupted durable compaction.",
    );
  }

  private async persistEvent(event: AgentSessionEvent): Promise<void> {
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
  const loadedSequence = log.latestSequence();
  const projectId =
    input.projectId?.trim() ||
    records.find((record) => record.payload.journalId === journalId)?.projectId ||
    null;
  const journal = new DurableAgentSessionJournal(
    { ownerId, sessionId, projectId, journalId },
    log,
    repository,
    loadedSequence,
  );

  await journal.repairCompactionAudits();
  return journal;
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
