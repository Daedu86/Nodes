import type {
  AgentRuntimeEvent,
  AgentRuntimeEventDraft,
} from "@/lib/agents/runtime/types";

const DEFAULT_MAX_EVENTS_PER_RUN = 500;

type EventListener = (event: AgentRuntimeEvent) => void;

export type AgentRuntimeEventBusOptions = {
  clock?: () => string;
  createEventId?: () => string;
  maxEventsPerRun?: number;
};

const defaultEventId = () => crypto.randomUUID();

const required = (value: string, field: string) => {
  if (!value.trim()) throw new Error(`Agent runtime event requires ${field}.`);
  return value.trim();
};

/**
 * A bounded, append-only event stream for one runtime process.
 *
 * The production persistence layer can subscribe and durably store the same
 * envelopes. Keeping this class transport-agnostic lets an SSE route, a local
 * runner, or a future message broker all expose identical Canvas events.
 */
export class AgentRuntimeEventBus {
  private readonly clock: () => string;
  private readonly createEventId: () => string;
  private readonly maxEventsPerRun: number;
  private readonly eventsByRun = new Map<string, AgentRuntimeEvent[]>();
  private readonly nextSequenceByRun = new Map<string, number>();
  private readonly listenersByRun = new Map<string, Set<EventListener>>();

  constructor(options: AgentRuntimeEventBusOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.createEventId = options.createEventId ?? defaultEventId;
    this.maxEventsPerRun = Math.max(1, Math.floor(options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN));
  }

  publish(draft: AgentRuntimeEventDraft): AgentRuntimeEvent {
    const runId = required(draft.runId, "runId");
    const sequence = (this.nextSequenceByRun.get(runId) ?? 0) + 1;
    this.nextSequenceByRun.set(runId, sequence);

    const event: AgentRuntimeEvent = {
      id: required(draft.id ?? this.createEventId(), "id"),
      runId,
      nodeId: required(draft.nodeId, "nodeId"),
      runtime: draft.runtime,
      type: draft.type,
      source: draft.source,
      sequence,
      createdAt: draft.createdAt ?? this.clock(),
      parentRunId: draft.parentRunId ?? null,
      payload: draft.payload ?? {},
    };
    const events = this.eventsByRun.get(runId) ?? [];
    events.push(event);
    if (events.length > this.maxEventsPerRun) {
      events.splice(0, events.length - this.maxEventsPerRun);
    }
    this.eventsByRun.set(runId, events);

    for (const listener of this.listenersByRun.get(runId) ?? []) {
      listener(event);
    }
    return event;
  }

  list(runId: string, afterSequence = 0): AgentRuntimeEvent[] {
    return (this.eventsByRun.get(runId) ?? [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => ({ ...event, payload: { ...event.payload } }));
  }

  subscribe(runId: string, listener: EventListener): () => void {
    const listeners = this.listenersByRun.get(runId) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listenersByRun.set(runId, listeners);

    return () => {
      const current = this.listenersByRun.get(runId);
      if (!current) return;
      current.delete(listener);
      if (!current.size) this.listenersByRun.delete(runId);
    };
  }
}
