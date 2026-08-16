import type { AgentSessionEvent } from "@/lib/agents/kernel/session-log";
import type {
  AgentRuntimeId,
  AgentRuntimeRunStatus,
} from "@/lib/agents/runtime/types";
import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import {
  findAgentSessionJournalForRun,
  loadAgentSessionJournal,
} from "@/lib/server/agent-session-journal";

export type AgentRunStatusSnapshot = {
  runtime: AgentRuntimeId;
  runId: string;
  status: AgentRuntimeRunStatus;
  idle: boolean;
  terminal: boolean;
  journalId: string;
  updatedAt: string;
};

export type AgentRunStatusInput = {
  ownerId: string;
  runtime: AgentRuntimeId;
  runId: string;
  repository?: AgentWorkRepository;
};

export type AgentWaitUntilIdleOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export class AgentRunNotFoundError extends Error {
  readonly code = "AGENT_RUN_NOT_FOUND" as const;
  readonly runtime: AgentRuntimeId;
  readonly runId: string;

  constructor(runtime: AgentRuntimeId, runId: string) {
    super(`Agent run '${runtime}:${runId}' was not found in the durable journal.`);
    this.name = "AgentRunNotFoundError";
    this.runtime = runtime;
    this.runId = runId;
  }
}

export class AgentRunWaitTimeoutError extends Error {
  readonly code = "AGENT_RUN_WAIT_TIMEOUT" as const;
  readonly runtime: AgentRuntimeId;
  readonly runId: string;
  readonly timeoutMs: number;

  constructor(runtime: AgentRuntimeId, runId: string, timeoutMs: number) {
    super(`Agent run '${runtime}:${runId}' did not become idle within ${timeoutMs}ms.`);
    this.name = "AgentRunWaitTimeoutError";
    this.runtime = runtime;
    this.runId = runId;
    this.timeoutMs = timeoutMs;
  }
}

const TERMINAL_STATUSES = new Set<AgentRuntimeRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const isIdle = (status: AgentRuntimeRunStatus) =>
  status === "waiting_for_approval" || TERMINAL_STATUSES.has(status);

const journalStatus = (
  status: "requested" | "started" | "completed" | "failed" | "cancelled",
): AgentRuntimeRunStatus => {
  if (status === "requested") return "queued";
  if (status === "started") return "running";
  return status;
};

export function deriveAgentRunStatus(
  events: readonly AgentSessionEvent[],
  input: { runtime: AgentRuntimeId; runId: string; journalId: string },
): AgentRunStatusSnapshot | null {
  let status: AgentRuntimeRunStatus | null = null;
  let updatedAt: string | null = null;

  for (const event of events) {
    if (
      event.type === "runtime.run" &&
      event.data.runtime === input.runtime &&
      event.data.runId === input.runId
    ) {
      status = journalStatus(event.data.status);
      updatedAt = event.createdAt;
      continue;
    }

    if (
      event.type !== "runtime.event" ||
      event.data.runtime !== input.runtime ||
      event.data.runId !== input.runId
    ) {
      continue;
    }

    switch (event.data.eventType) {
      case "run.queued":
        status = "queued";
        break;
      case "agent.started":
        status = "running";
        break;
      case "approval.requested":
        status = "waiting_for_approval";
        break;
      case "approval.resolved":
        if (status === "waiting_for_approval") status = "running";
        break;
      case "run.completed":
        status = "completed";
        break;
      case "run.failed":
        status = "failed";
        break;
      case "run.cancelled":
        status = "cancelled";
        break;
    }
    updatedAt = event.createdAt;
  }

  if (!status || !updatedAt) return null;
  return {
    runtime: input.runtime,
    runId: input.runId,
    status,
    idle: isIdle(status),
    terminal: TERMINAL_STATUSES.has(status),
    journalId: input.journalId,
    updatedAt,
  };
}

const normalizeIdentity = (value: string, field: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Agent run ${field} must not be empty.`);
  return normalized;
};

const positiveMs = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent run ${field} must be a positive safe integer.`);
  }
  return value;
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Agent run wait was aborted.");
};

const sleep = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const statusOrThrow = (
  events: readonly AgentSessionEvent[],
  input: { runtime: AgentRuntimeId; runId: string; journalId: string },
) => {
  const status = deriveAgentRunStatus(events, input);
  if (!status) throw new AgentRunNotFoundError(input.runtime, input.runId);
  return status;
};

export async function getAgentRunStatus(
  input: AgentRunStatusInput,
): Promise<AgentRunStatusSnapshot> {
  const ownerId = normalizeIdentity(input.ownerId, "ownerId");
  const runId = normalizeIdentity(input.runId, "runId");
  const journal = await findAgentSessionJournalForRun({
    ownerId,
    runtime: input.runtime,
    runId,
    repository: input.repository,
  });
  if (!journal) throw new AgentRunNotFoundError(input.runtime, runId);
  return statusOrThrow(journal.log.events(), {
    runtime: input.runtime,
    runId,
    journalId: journal.identity.journalId,
  });
}

export async function waitUntilAgentRunIdle(
  input: AgentRunStatusInput,
  options: AgentWaitUntilIdleOptions = {},
): Promise<AgentRunStatusSnapshot> {
  const ownerId = normalizeIdentity(input.ownerId, "ownerId");
  const runId = normalizeIdentity(input.runId, "runId");
  const timeoutMs = positiveMs(options.timeoutMs ?? 60_000, "timeoutMs");
  const pollIntervalMs = positiveMs(
    options.pollIntervalMs ?? 500,
    "pollIntervalMs",
  );
  const startedAt = Date.now();
  throwIfAborted(options.signal);

  let journal = await findAgentSessionJournalForRun({
    ownerId,
    runtime: input.runtime,
    runId,
    repository: input.repository,
  });
  if (!journal) throw new AgentRunNotFoundError(input.runtime, runId);

  for (;;) {
    throwIfAborted(options.signal);
    const status = statusOrThrow(journal.log.events(), {
      runtime: input.runtime,
      runId,
      journalId: journal.identity.journalId,
    });
    if (status.idle) return status;

    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      throw new AgentRunWaitTimeoutError(input.runtime, runId, timeoutMs);
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed), options.signal);
    journal = await loadAgentSessionJournal({
      ownerId: journal.identity.ownerId,
      sessionId: journal.identity.sessionId,
      projectId: journal.identity.projectId,
      journalId: journal.identity.journalId,
      repository: input.repository,
    });
  }
}
