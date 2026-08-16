import { normalizeCodexNotification } from "@/lib/agents/codex/event-mapper";
import { compactAgentSessionJournalIfNeeded } from "@/lib/server/agent-context-compaction";
import { codexEventToRuntimeEvent } from "@/lib/agents/runtime/codex-event-adapter";
import type {
  AgentJsonValue,
  AgentSessionEvent,
  AgentSessionLog,
  AgentTurnEndReason,
} from "@/lib/agents/kernel/session-log";
import type {
  AgentRuntimeEventSource,
  AgentRuntimeEventType,
  AgentRuntimeId,
} from "@/lib/agents/runtime/types";
import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import {
  AgentDurableCompactionInterruptedError,
  findAgentSessionJournalForRun,
  loadAgentSessionJournal,
  type DurableAgentSessionJournal,
} from "@/lib/server/agent-session-journal";

const RUNTIME_EVENT_TYPES = new Set<AgentRuntimeEventType>([
  "run.queued",
  "agent.started",
  "agent.message.delta",
  "agent.message.completed",
  "agent.child.spawned",
  "tool.started",
  "tool.completed",
  "shell.started",
  "shell.completed",
  "file.changed",
  "artifact.created",
  "approval.requested",
  "approval.resolved",
  "sandbox.policy.decision",
  "trace.recorded",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "runtime.unknown",
]);

const RUNTIME_EVENT_SOURCES = new Set<AgentRuntimeEventSource>([
  "runtime",
  "sandbox",
  "compiler",
]);

const AUTO_COMPACTION_EVENT_TYPES = new Set<AgentRuntimeEventType>([
  "agent.message.completed",
  "tool.completed",
]);

export type AgentStreamRuntimeEvent = {
  id: string;
  runId: string;
  runtime: AgentRuntimeId;
  type: AgentRuntimeEventType;
  source: AgentRuntimeEventSource;
  createdAt: string | null;
  sequence: number | null;
  nodeId: string | null;
  parentRunId: string | null;
  payload: Record<string, unknown>;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const readString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const readRawString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const readSequence = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const toJsonValue = (value: unknown): AgentJsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Runtime event contains a non-finite number.");
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toJsonValue(entry)]),
    );
  }
  throw new Error(`Runtime event contains a non-JSON ${typeof value} value.`);
};

const runtimeType = (value: unknown): AgentRuntimeEventType =>
  typeof value === "string" && RUNTIME_EVENT_TYPES.has(value as AgentRuntimeEventType)
    ? value as AgentRuntimeEventType
    : "runtime.unknown";

const runtimeSource = (value: unknown): AgentRuntimeEventSource =>
  typeof value === "string" && RUNTIME_EVENT_SOURCES.has(value as AgentRuntimeEventSource)
    ? value as AgentRuntimeEventSource
    : "runtime";

export function normalizeAgentStreamEvent(
  runtime: AgentRuntimeId,
  value: unknown,
  expectedRunId: string,
): AgentStreamRuntimeEvent | null {
  const record = asRecord(value);
  const eventId = readString(record.id);
  const runId = readString(record.runId);
  if (!eventId || !runId || runId !== expectedRunId) return null;

  if (runtime === "nooa") {
    return {
      id: eventId,
      runId,
      runtime,
      type: runtimeType(record.type),
      source: runtimeSource(record.source),
      createdAt: readString(record.createdAt),
      sequence: readSequence(record.sequence),
      nodeId: readString(record.nodeId),
      parentRunId: readString(record.parentRunId),
      payload: asRecord(record.payload),
    };
  }

  const notification = asRecord(record.notification);
  const method = readString(notification.method);
  if (!method) return null;
  const event = normalizeCodexNotification({
    notification: {
      method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    },
    runId,
    eventId,
    createdAt: readString(record.createdAt) ?? undefined,
    threadId: readString(record.threadId),
    parentRunId: readString(record.parentRunId),
    agentId: readString(record.agentId),
  });
  const normalized = codexEventToRuntimeEvent(
    event,
    readString(record.agentId) ?? `codex-run:${runId}`,
  );
  return {
    id: eventId,
    runId,
    runtime,
    type: normalized.type,
    source: normalized.source,
    createdAt: event.createdAt,
    sequence: null,
    nodeId: readString(record.agentId),
    parentRunId: event.parentRunId ?? null,
    payload: normalized.payload ?? {},
  };
}

const eventRecords = (event: AgentStreamRuntimeEvent) => {
  const payload = asRecord(event.payload);
  const params = asRecord(payload.params);
  const data = asRecord(payload.data);
  return [
    params,
    asRecord(params.item),
    asRecord(params.message),
    payload,
    data,
    asRecord(data.item),
    asRecord(data.message),
    asRecord(data.tool),
    asRecord(data.call),
  ];
};

const firstString = (
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
) => {
  for (const record of records) {
    for (const key of keys) {
      const value = readString(record[key]);
      if (value) return value;
    }
  }
  return null;
};

const firstValue = (
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
): unknown => {
  for (const record of records) {
    for (const key of keys) {
      if (record[key] !== undefined) return record[key];
    }
  }
  return undefined;
};

const textFromContent = (value: unknown, depth = 0): string | null => {
  if (depth > 5) return null;
  const raw = readRawString(value);
  if (raw) return raw;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => textFromContent(entry, depth + 1))
      .filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join("\n") : null;
  }
  const record = asRecord(value);
  for (const key of ["text", "content", "output_text", "result", "output", "message", "value"]) {
    const candidate = textFromContent(record[key], depth + 1);
    if (candidate) return candidate;
  }
  return null;
};

const completedMessageText = (event: AgentStreamRuntimeEvent) => {
  if (event.type !== "agent.message.completed") return null;
  const records = eventRecords(event);
  for (const record of records) {
    for (const key of ["text", "content", "result", "output", "message"]) {
      const candidate = textFromContent(record[key]);
      if (candidate) return candidate;
    }
  }
  return null;
};

const openTurn = (log: AgentSessionLog) => {
  let turn: number | null = null;
  for (const event of log.events()) {
    if (event.type === "turn.start") turn = event.data.turn;
    if (event.type === "turn.end" && event.data.turn === turn) turn = null;
  }
  return turn;
};

const ensureOpenTurn = (log: AgentSessionLog) => {
  const current = openTurn(log);
  if (current !== null) return current;
  const lastTurn = log.events().reduce(
    (maximum, event) => event.type === "turn.start" ? Math.max(maximum, event.data.turn) : maximum,
    0,
  );
  const turn = lastTurn + 1;
  log.append("turn.start", { turn });
  return turn;
};

const pendingToolCalls = (log: AgentSessionLog) => {
  const pending = new Map<string, string[]>();
  const completed = new Set(
    log.events()
      .filter((event): event is AgentSessionEvent<"tool.result"> => event.type === "tool.result")
      .map((event) => event.data.callId),
  );
  for (const event of log.events()) {
    if (event.type !== "tool.call" || completed.has(event.data.callId)) continue;
    const ids = pending.get(event.data.name) ?? [];
    ids.push(event.data.callId);
    pending.set(event.data.name, ids);
  }
  return pending;
};

const terminalReason = (
  type: AgentRuntimeEventType,
): Exclude<AgentTurnEndReason, "interrupted"> | null => {
  if (type === "run.completed") return "completed";
  if (type === "run.failed") return "failed";
  if (type === "run.cancelled") return "cancelled";
  return null;
};

const appendSemanticProjection = (
  journal: DurableAgentSessionJournal,
  event: AgentStreamRuntimeEvent,
) => {
  const log = journal.log;
  if (event.type === "agent.started") ensureOpenTurn(log);

  if (event.type === "agent.message.completed") {
    const text = completedMessageText(event);
    if (text) {
      ensureOpenTurn(log);
      log.appendSurface("assistant.message", {
        messageId: event.id,
        content: text,
      });
    }
  }

  if (event.type === "tool.started") {
    const records = eventRecords(event);
    const name = firstString(records, ["toolName", "tool_name", "name"]);
    if (name) {
      ensureOpenTurn(log);
      const callId = firstString(records, ["callId", "call_id", "toolCallId", "tool_call_id", "id"]) ?? event.id;
      const args = firstValue(records, ["arguments", "args", "input", "parameters"]);
      log.append("tool.call", {
        callId,
        name,
        arguments: args === undefined ? {} : toJsonValue(args),
      });
    }
  }

  if (event.type === "tool.completed") {
    const records = eventRecords(event);
    const name = firstString(records, ["toolName", "tool_name", "name"]);
    if (name) {
      ensureOpenTurn(log);
      const explicitCallId = firstString(records, ["callId", "call_id", "toolCallId", "tool_call_id", "id"]);
      const pending = pendingToolCalls(log).get(name) ?? [];
      const callId = explicitCallId ?? pending.at(-1) ?? event.id;
      const result = firstValue(records, ["result", "output", "content", "data"]);
      const error = firstValue(records, ["error", "isError", "is_error"]);
      log.appendSurface("tool.result", {
        callId,
        name,
        content: result === undefined ? {} : toJsonValue(result),
        isError: error === true || typeof error === "string",
      });
    }
  }

  const reason = terminalReason(event.type);
  if (reason) {
    const turn = ensureOpenTurn(log);
    log.append("runtime.run", {
      runtime: event.runtime,
      status: reason,
      runId: event.runId,
      ...(reason === "failed"
        ? { message: firstString(eventRecords(event), ["message", "error"]) ?? undefined }
        : {}),
    });
    log.append("turn.end", { turn, reason });
  }
};

export async function projectRuntimeEventToJournal(
  journal: DurableAgentSessionJournal,
  event: AgentStreamRuntimeEvent,
): Promise<boolean> {
  const alreadyProjected = journal.log.events().some(
    (current) => current.type === "runtime.event" && current.data.eventId === event.id,
  );
  if (alreadyProjected) return false;

  journal.log.append("runtime.event", {
    runtime: event.runtime,
    runId: event.runId,
    eventId: event.id,
    eventType: event.type,
    source: event.source,
    nodeId: event.nodeId ?? undefined,
    parentRunId: event.parentRunId,
    providerSequence: event.sequence ?? undefined,
    providerCreatedAt: event.createdAt ?? undefined,
    payload: toJsonValue(event.payload),
  });
  appendSemanticProjection(journal, event);
  await journal.flush();
  if (AUTO_COMPACTION_EVENT_TYPES.has(event.type)) {
    try {
      await compactAgentSessionJournalIfNeeded(journal);
    } catch (error) {
      if (error instanceof AgentDurableCompactionInterruptedError) throw error;
      console.warn("[agent-kernel] automatic context compaction skipped", error);
    }
  }
  return true;
}

export async function createAgentStreamJournalProjector(input: {
  ownerId: string;
  runtime: AgentRuntimeId;
  runId: string;
  repository?: AgentWorkRepository;
}) {
  const initialJournal = await findAgentSessionJournalForRun(input);
  if (!initialJournal) return null;
  let journal: DurableAgentSessionJournal = initialJournal;
  const callbackOwned = journal.log.events().some(
    (event) =>
      event.type === "runtime.run" &&
      event.data.runtime === input.runtime &&
      event.data.eventIngestion === "callback",
  );
  if (callbackOwned) return null;
  return {
    journalId: journal.identity.journalId,
    async projectValue(value: unknown) {
      const event = normalizeAgentStreamEvent(input.runtime, value, input.runId);
      if (!event) return false;
      try {
        return await projectRuntimeEventToJournal(journal, event);
      } catch (error) {
        if (error instanceof AgentDurableCompactionInterruptedError) {
          journal = await loadAgentSessionJournal({
            ownerId: journal.identity.ownerId,
            sessionId: journal.identity.sessionId,
            projectId: journal.identity.projectId,
            journalId: journal.identity.journalId,
            repository: input.repository,
          });
        }
        throw error;
      }
    },
  };
}

const frameData = (frame: string) => {
  const lines = frame.split("\n");
  const parts = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return parts.length ? parts.join("\n") : null;
};

export function createJournaledAgentEventStream(
  body: ReadableStream<Uint8Array>,
  input: {
    ownerId: string;
    runtime: AgentRuntimeId;
    runId: string;
    repository?: AgentWorkRepository;
  },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";
  let projectionChain: Promise<void> = Promise.resolve();
  const projectorPromise = createAgentStreamJournalProjector(input).catch((error) => {
    console.warn("[agent-kernel] unable to bind stream to durable journal", error);
    return null;
  });

  const scheduleFrame = (frame: string) => {
    const data = frameData(frame);
    if (!data) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    projectionChain = projectionChain
      .then(async () => {
        const projector = await projectorPromise;
        if (projector) await projector.projectValue(value);
      })
      .catch((error) => {
        console.warn("[agent-kernel] failed to persist runtime stream event", error);
      });
  };

  const consumeFrames = (final = false) => {
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      scheduleFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) {
      scheduleFrame(buffer);
      buffer = "";
    }
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      consumeFrames();
    },
    async flush() {
      buffer += decoder.decode();
      consumeFrames(true);
      await projectionChain;
    },
  });

  return body.pipeThrough(transform);
}
