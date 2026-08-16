import {
  cancelCodexRun,
  resolveCodexApproval,
  streamCodexRunEvents,
} from "@/lib/agents/codex/runner-client";
import {
  cancelNooaRun,
  streamNooaRunEvents,
} from "@/lib/agents/nooa/runner-client";
import type {
  AgentRuntimeApprovalDecision,
  AgentRuntimeId,
} from "@/lib/agents/runtime/types";
import {
  getAgentRunStatus,
  waitUntilAgentRunIdle,
  type AgentRunStatusSnapshot,
  type AgentWaitUntilIdleOptions,
} from "@/lib/agents/runtime/run-status";

export type AgentHandleCapability =
  | "cancel"
  | "event_stream"
  | "approvals"
  | "status"
  | "wait_until_idle";

export class AgentHandleCapabilityError extends Error {
  readonly code = "UNSUPPORTED_CAPABILITY" as const;
  readonly runtime: AgentRuntimeId;
  readonly capability: AgentHandleCapability;

  constructor(runtime: AgentRuntimeId, capability: AgentHandleCapability) {
    super(`Agent runtime '${runtime}' does not support '${capability}' through this handle.`);
    this.name = "AgentHandleCapabilityError";
    this.runtime = runtime;
    this.capability = capability;
  }
}

export type AgentHandle = {
  readonly runtime: AgentRuntimeId;
  readonly ownerId: string;
  readonly runId: string;
  readonly capabilities: readonly AgentHandleCapability[];
  status(): Promise<AgentRunStatusSnapshot>;
  waitUntilIdle(options?: AgentWaitUntilIdleOptions): Promise<AgentRunStatusSnapshot>;
  cancel(): Promise<Record<string, unknown>>;
  openEventStream(afterEventId?: string | null): Promise<Response>;
  resolveApproval(
    approvalId: string,
    decision: AgentRuntimeApprovalDecision,
  ): Promise<void>;
};

type AgentHandleProvider = {
  capabilities: readonly AgentHandleCapability[];
  cancel(ownerId: string, runId: string): Promise<Record<string, unknown>>;
  openEventStream(
    ownerId: string,
    runId: string,
    afterEventId?: string | null,
  ): Promise<Response>;
  resolveApproval?: (
    ownerId: string,
    runId: string,
    approvalId: string,
    decision: AgentRuntimeApprovalDecision,
  ) => Promise<void>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const cancelledPayload = async (response: Response, runId: string) => {
  const parsed = asRecord(await response.json().catch(() => null));
  return parsed ?? { runId, status: "cancelled" };
};

const PROVIDERS: Record<AgentRuntimeId, AgentHandleProvider> = {
  codex: {
    capabilities: ["cancel", "event_stream", "approvals", "status", "wait_until_idle"],
    async cancel(ownerId, runId) {
      return cancelledPayload(await cancelCodexRun(ownerId, runId), runId);
    },
    openEventStream: streamCodexRunEvents,
    async resolveApproval(ownerId, runId, approvalId, decision) {
      await resolveCodexApproval(ownerId, runId, approvalId, decision);
    },
  },
  nooa: {
    capabilities: ["cancel", "event_stream", "status", "wait_until_idle"],
    async cancel(ownerId, runId) {
      return cancelledPayload(await cancelNooaRun(ownerId, runId), runId);
    },
    openEventStream: streamNooaRunEvents,
  },
};

/**
 * Attach a provider-neutral lifecycle handle to an already-started runtime run.
 * Start composition stays provider-specific for now, while cancellation,
 * streaming and approvals converge on one interface used by the API layer.
 */
export function getAgentHandle(
  runtime: AgentRuntimeId,
  input: { ownerId: string; runId: string },
): AgentHandle {
  const ownerId = input.ownerId.trim();
  const runId = input.runId.trim();
  if (!ownerId) throw new Error("Agent handle ownerId must not be empty.");
  if (!runId) throw new Error("Agent handle runId must not be empty.");

  const provider = PROVIDERS[runtime];
  return {
    runtime,
    ownerId,
    runId,
    capabilities: provider.capabilities,
    status: () => getAgentRunStatus({ ownerId, runtime, runId }),
    waitUntilIdle: (options) =>
      waitUntilAgentRunIdle({ ownerId, runtime, runId }, options),
    cancel: () => provider.cancel(ownerId, runId),
    openEventStream: (afterEventId) =>
      provider.openEventStream(ownerId, runId, afterEventId),
    resolveApproval: async (approvalId, decision) => {
      if (!provider.resolveApproval) {
        throw new AgentHandleCapabilityError(runtime, "approvals");
      }
      await provider.resolveApproval(ownerId, runId, approvalId, decision);
    },
  };
}
