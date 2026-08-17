import type { ExperimentRunRecord } from "@/lib/agent-experiments";
import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import { getAgentWorkRepository } from "@/lib/persistence/repositories";

export const AGENT_EXPERIMENT_EVENT_TYPE = "kernel.experiment.run" as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRun = (value: unknown): ExperimentRunRecord | null => {
  if (!isRecord(value)) return null;
  if (typeof value.experimentId !== "string" || typeof value.candidateId !== "string") return null;
  if (typeof value.runtime !== "string" || typeof value.sessionId !== "string") return null;
  if (!isRecord(value.metrics)) return null;
  return structuredClone(value) as unknown as ExperimentRunRecord;
};

const eventTime = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Stores experiment state as append-only snapshots in the existing agent event
 * repository. This avoids a second persistence stack while keeping every
 * promotion/evaluation transition auditable in file and Supabase backends.
 */
export async function persistExperimentRun(input: {
  ownerId: string;
  record: ExperimentRunRecord;
  repository?: AgentWorkRepository;
  createdAt?: string;
}) {
  const ownerId = input.ownerId.trim();
  if (!ownerId) throw new Error("Experiment ownerId must not be empty.");
  const repository = input.repository ?? getAgentWorkRepository();
  await repository.recordAgentEvent(ownerId, {
    ownerId,
    tokenId: null,
    eventType: AGENT_EXPERIMENT_EVENT_TYPE,
    method: "INTERNAL",
    route: "agent-experiment",
    sessionId: input.record.sessionId,
    projectId: input.record.projectId,
    payload: structuredClone(input.record) as unknown as Record<string, unknown>,
    createdAt: input.createdAt,
  });
}

export async function listProjectExperimentRuns(input: {
  ownerId: string;
  projectId: string;
  repository?: AgentWorkRepository;
}): Promise<ExperimentRunRecord[]> {
  const ownerId = input.ownerId.trim();
  const projectId = input.projectId.trim();
  if (!ownerId) throw new Error("Experiment ownerId must not be empty.");
  if (!projectId) throw new Error("projectId must not be empty.");
  const repository = input.repository ?? getAgentWorkRepository();
  const events = await repository.listAgentEvents(ownerId, {
    eventType: AGENT_EXPERIMENT_EVENT_TYPE,
    projectId,
    limit: 1000,
  });

  const latestByCandidate = new Map<string, { at: number; record: ExperimentRunRecord }>();
  for (const event of events) {
    const record = parseRun(event.payload);
    if (!record || record.projectId !== projectId) continue;
    const key = `${record.experimentId}\u0000${record.candidateId}`;
    const at = eventTime(event.createdAt);
    const previous = latestByCandidate.get(key);
    if (!previous || at >= previous.at) {
      latestByCandidate.set(key, { at, record });
    }
  }

  return [...latestByCandidate.values()]
    .sort((left, right) => {
      const experimentDelta = left.record.experimentId.localeCompare(right.record.experimentId);
      return experimentDelta !== 0
        ? experimentDelta
        : left.record.candidateId.localeCompare(right.record.candidateId);
    })
    .map(({ record }) => record);
}

export async function listExperimentRuns(input: {
  ownerId: string;
  experimentId: string;
  projectId?: string | null;
  repository?: AgentWorkRepository;
}): Promise<ExperimentRunRecord[]> {
  const ownerId = input.ownerId.trim();
  const experimentId = input.experimentId.trim();
  if (!ownerId) throw new Error("Experiment ownerId must not be empty.");
  if (!experimentId) throw new Error("experimentId must not be empty.");
  if (input.projectId) {
    return (await listProjectExperimentRuns({
      ownerId,
      projectId: input.projectId,
      repository: input.repository,
    })).filter((record) => record.experimentId === experimentId);
  }
  const repository = input.repository ?? getAgentWorkRepository();
  const events = await repository.listAgentEvents(ownerId, {
    eventType: AGENT_EXPERIMENT_EVENT_TYPE,
    limit: 1000,
  });

  const latestByCandidate = new Map<string, { at: number; record: ExperimentRunRecord }>();
  for (const event of events) {
    const record = parseRun(event.payload);
    if (!record || record.experimentId !== experimentId) continue;
    const at = eventTime(event.createdAt);
    const previous = latestByCandidate.get(record.candidateId);
    if (!previous || at >= previous.at) {
      latestByCandidate.set(record.candidateId, { at, record });
    }
  }

  return [...latestByCandidate.values()]
    .sort((left, right) => left.record.candidateId.localeCompare(right.record.candidateId))
    .map(({ record }) => record);
}
