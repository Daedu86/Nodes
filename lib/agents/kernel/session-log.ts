export type AgentJsonPrimitive = string | number | boolean | null;
export type AgentJsonValue =
  | AgentJsonPrimitive
  | AgentJsonValue[]
  | { [key: string]: AgentJsonValue };

export type AgentTurnEndReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type AgentRuntimeJournalStatus =
  | "requested"
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentContextCompactionTrigger =
  | "absolute-threshold"
  | "context-window-pressure";

export type AgentContextCheckpointMetadata = {
  compactionId: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  triggerTokens: number;
  triggerReason: AgentContextCompactionTrigger;
  provider?: string;
  model?: string;
  contextWindow?: number;
  estimatorId: string;
  summarizerId: string;
};

export type AgentSessionEventMap = {
  "turn.start": { turn: number };
  "turn.end": { turn: number; reason: AgentTurnEndReason };
  "step.start": { turn: number; step: number };
  "step.end": { turn: number; step: number };
  "request.snapshot": {
    assemblyId?: string;
    runtime?: string;
    provider: string;
    model?: string;
    reasoningEffort?: string;
    systemPrompt?: string;
    tools?: string[];
    contextWindow?: number;
    approvalMode?: string;
    sandboxPolicyId?: string;
    workspacePaths?: string[];
    sectionNames?: string[];
  };
  "runtime.run": {
    runtime: string;
    status: AgentRuntimeJournalStatus;
    runId: string | null;
    eventIngestion?: "stream" | "callback";
    providerRunId?: string | null;
    message?: string;
  };
  "runtime.event": {
    runtime: string;
    runId: string;
    eventId: string;
    eventType: string;
    source?: string;
    nodeId?: string;
    parentRunId?: string | null;
    providerSequence?: number;
    providerCreatedAt?: string;
    payload: AgentJsonValue;
  };
  "user.message": {
    messageId: string;
    content: AgentJsonValue;
    source: "human" | "injected" | "checkpoint";
    checkpoint?: AgentContextCheckpointMetadata;
  };
  "assistant.message": {
    messageId: string;
    content: AgentJsonValue;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  "tool.call": {
    callId: string;
    name: string;
    arguments: AgentJsonValue;
  };
  "tool.result": {
    callId: string;
    name: string;
    content: AgentJsonValue;
    isError?: boolean;
  };
  "context.compaction": {
    compactionId: string;
    checkpointSequence: number;
    sourceSequences: number[];
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    triggerTokens?: number;
    triggerReason?: AgentContextCompactionTrigger;
    provider?: string;
    model?: string;
    contextWindow?: number;
    estimatorId?: string;
    summarizerId?: string;
  };
};

export type AgentSessionEventType = keyof AgentSessionEventMap;
export type AgentSurfaceEventType =
  | "user.message"
  | "assistant.message"
  | "tool.result";
export type AgentNonSurfaceEventType = Exclude<
  AgentSessionEventType,
  AgentSurfaceEventType
>;

export type AgentSurfaceOperation =
  | { kind: "append" }
  | { kind: "replace"; startSequence: number; endSequence: number };

type AgentSessionEventFor<K extends AgentSessionEventType> = {
  type: K;
  sequence: number;
  createdAt: string;
  data: AgentSessionEventMap[K];
} & (K extends AgentSurfaceEventType
  ? {
      surfaceOp: AgentSurfaceOperation;
      sourceSequences: number[];
    }
  : {
      surfaceOp?: never;
      sourceSequences?: never;
    });

export type AgentSessionEvent<
  T extends AgentSessionEventType = AgentSessionEventType,
> = {
  [K in T]: AgentSessionEventFor<K>;
}[T];

export type AgentModelMessage =
  | {
      role: "user";
      sequence: number;
      messageId: string;
      content: AgentJsonValue;
      source: AgentSessionEventMap["user.message"]["source"];
      sourceSequences: number[];
    }
  | {
      role: "assistant";
      sequence: number;
      messageId: string;
      content: AgentJsonValue;
      sourceSequences: number[];
    }
  | {
      role: "tool";
      sequence: number;
      callId: string;
      name: string;
      content: AgentJsonValue;
      isError: boolean;
      sourceSequences: number[];
    };

export type AgentSessionLogOptions = {
  clock?: () => string;
  seed?: readonly AgentSessionEvent[];
};

const SURFACE_TYPES = new Set<AgentSessionEventType>([
  "user.message",
  "assistant.message",
  "tool.result",
]);

const clone = <T>(value: T): T => structuredClone(value);

const positiveInteger = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Agent session ${field} must be a positive safe integer.`);
  }
  return value;
};

const isSurfaceEvent = (
  event: AgentSessionEvent,
): event is AgentSessionEvent<AgentSurfaceEventType> => SURFACE_TYPES.has(event.type);

const sameSequences = (left: readonly number[], right: readonly number[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Append-only event log whose model-visible surface is derived from the log.
 * A replacement never mutates old events; it appends a new surface event that
 * shadows a validated contiguous range and records the exact source sequences.
 */
export class AgentSessionLog {
  private readonly clock: () => string;
  private readonly log: AgentSessionEvent[];

  constructor(options: AgentSessionLogOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.log = (options.seed ?? []).map((event) => clone(event));
    this.validateSeed();
  }

  append<K extends AgentNonSurfaceEventType>(
    type: K,
    data: AgentSessionEventMap[K],
  ): AgentSessionEvent<K> {
    const event = {
      type,
      sequence: this.log.length + 1,
      createdAt: this.clock(),
      data: clone(data),
    } as AgentSessionEvent<K>;
    this.log.push(event as AgentSessionEvent);
    return clone(event);
  }

  appendSurface<K extends AgentSurfaceEventType>(
    type: K,
    data: AgentSessionEventMap[K],
  ): AgentSessionEvent<K> {
    return this.appendSurfaceOperation(type, data, { kind: "append" }, []);
  }

  replaceSurfaceRange<K extends AgentSurfaceEventType>(
    type: K,
    data: AgentSessionEventMap[K],
    range: { startSequence: number; endSequence: number },
  ): AgentSessionEvent<K> {
    const startSequence = positiveInteger(range.startSequence, "replacement startSequence");
    const endSequence = positiveInteger(range.endSequence, "replacement endSequence");
    const surface = this.surfaceEvents();
    const startIndex = surface.findIndex((event) => event.sequence === startSequence);
    const endIndex = surface.findIndex((event) => event.sequence === endSequence);
    if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
      throw new Error(
        "Agent session replacement range must name an ordered contiguous span on the current surface.",
      );
    }

    const sourceSequences = surface
      .slice(startIndex, endIndex + 1)
      .map((event) => event.sequence);
    return this.appendSurfaceOperation(
      type,
      data,
      { kind: "replace", startSequence, endSequence },
      sourceSequences,
    );
  }

  events(): AgentSessionEvent[] {
    return this.log.map((event) => clone(event));
  }

  surfaceEvents(): AgentSessionEvent<AgentSurfaceEventType>[] {
    const surface: AgentSessionEvent<AgentSurfaceEventType>[] = [];

    for (const rawEvent of this.log) {
      if (!isSurfaceEvent(rawEvent)) continue;
      const event = clone(rawEvent);
      if (event.surfaceOp.kind === "append") {
        surface.push(event);
        continue;
      }

      const operation = event.surfaceOp;
      const startIndex = surface.findIndex(
        (current) => current.sequence === operation.startSequence,
      );
      const endIndex = surface.findIndex(
        (current) => current.sequence === operation.endSequence,
      );
      if (startIndex < 0 || endIndex < 0 || startIndex > endIndex) {
        throw new Error(
          `Agent session surface replacement at sequence ${event.sequence} references an invalid range.`,
        );
      }

      const shadowed = surface.slice(startIndex, endIndex + 1).map(({ sequence }) => sequence);
      if (!sameSequences(shadowed, event.sourceSequences)) {
        throw new Error(
          `Agent session surface replacement at sequence ${event.sequence} has incomplete source provenance.`,
        );
      }
      surface.splice(startIndex, endIndex - startIndex + 1, event);
    }

    return surface;
  }

  deriveModelMessages(): AgentModelMessage[] {
    return this.surfaceEvents().map((event) => {
      if (event.type === "user.message") {
        return {
          role: "user" as const,
          sequence: event.sequence,
          messageId: event.data.messageId,
          content: clone(event.data.content),
          source: event.data.source,
          sourceSequences: [...event.sourceSequences],
        };
      }
      if (event.type === "assistant.message") {
        return {
          role: "assistant" as const,
          sequence: event.sequence,
          messageId: event.data.messageId,
          content: clone(event.data.content),
          sourceSequences: [...event.sourceSequences],
        };
      }
      return {
        role: "tool" as const,
        sequence: event.sequence,
        callId: event.data.callId,
        name: event.data.name,
        content: clone(event.data.content),
        isError: event.data.isError === true,
        sourceSequences: [...event.sourceSequences],
      };
    });
  }

  repairInterruptedTail(): AgentSessionEvent<"turn.end"> | null {
    let openTurn: number | null = null;
    for (const event of this.log) {
      if (event.type === "turn.start") openTurn = event.data.turn;
      if (event.type === "turn.end" && event.data.turn === openTurn) openTurn = null;
    }
    if (openTurn === null) return null;
    return this.append("turn.end", { turn: openTurn, reason: "interrupted" });
  }

  repairCompactionAudits(): AgentSessionEvent<"context.compaction">[] {
    const audits = new Map<string, AgentSessionEvent<"context.compaction">>();
    for (const event of this.log) {
      if (event.type !== "context.compaction") continue;
      const existing = audits.get(event.data.compactionId);
      if (existing) {
        throw new Error(
          `Agent session has duplicate context compaction audit '${event.data.compactionId}'.`,
        );
      }
      audits.set(event.data.compactionId, event);
    }

    const checkpoints = this.log.filter(
      (event): event is AgentSessionEvent<"user.message"> =>
        event.type === "user.message" &&
        event.data.source === "checkpoint" &&
        event.surfaceOp.kind === "replace" &&
        event.data.checkpoint !== undefined,
    );
    const repaired: AgentSessionEvent<"context.compaction">[] = [];

    for (const checkpoint of checkpoints) {
      const metadata = checkpoint.data.checkpoint!;
      const existing = audits.get(metadata.compactionId);
      if (existing) {
        if (
          existing.data.checkpointSequence !== checkpoint.sequence ||
          !sameSequences(existing.data.sourceSequences, checkpoint.sourceSequences)
        ) {
          throw new Error(
            `Agent session context compaction audit '${metadata.compactionId}' does not match its checkpoint.`,
          );
        }
        continue;
      }

      const audit = this.append("context.compaction", {
        compactionId: metadata.compactionId,
        checkpointSequence: checkpoint.sequence,
        sourceSequences: [...checkpoint.sourceSequences],
        estimatedTokensBefore: metadata.estimatedTokensBefore,
        estimatedTokensAfter: metadata.estimatedTokensAfter,
        triggerTokens: metadata.triggerTokens,
        triggerReason: metadata.triggerReason,
        provider: metadata.provider,
        model: metadata.model,
        contextWindow: metadata.contextWindow,
        estimatorId: metadata.estimatorId,
        summarizerId: metadata.summarizerId,
      });
      audits.set(metadata.compactionId, audit);
      repaired.push(audit);
    }

    return repaired.map((event) => clone(event));
  }

  fork(boundarySequence = this.log.length): AgentSessionLog {
    if (!Number.isSafeInteger(boundarySequence) || boundarySequence < 0) {
      throw new Error("Agent session fork boundary must be a non-negative safe integer.");
    }
    return new AgentSessionLog({
      clock: this.clock,
      seed: this.log.filter((event) => event.sequence <= boundarySequence),
    });
  }

  latestSequence() {
    return this.log.length;
  }

  private appendSurfaceOperation<K extends AgentSurfaceEventType>(
    type: K,
    data: AgentSessionEventMap[K],
    surfaceOp: AgentSurfaceOperation,
    sourceSequences: number[],
  ): AgentSessionEvent<K> {
    const event = {
      type,
      sequence: this.log.length + 1,
      createdAt: this.clock(),
      data: clone(data),
      surfaceOp,
      sourceSequences: [...sourceSequences],
    } as AgentSessionEvent<K>;
    this.log.push(event as AgentSessionEvent);
    return clone(event);
  }

  private validateSeed() {
    for (let index = 0; index < this.log.length; index += 1) {
      const event = this.log[index];
      if (event.sequence !== index + 1) {
        throw new Error("Agent session seed must have contiguous one-based sequences.");
      }
    }
    this.surfaceEvents();
  }
}
