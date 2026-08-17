import type { AgentHandle } from "@/lib/agents/runtime/handle";
import type {
  AgentRuntimeContinuation,
  AgentRuntimeId,
  AgentRuntimeNode,
} from "@/lib/agents/runtime/types";
import type {
  EvolutionEvaluation,
  TychoVariant,
} from "@/lib/tycho-evolution-loop";

export type ExperimentRunStatus =
  | "planned"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type ExperimentPromotionDecision = "champion" | "challenger" | "rejected" | "undecided";

export type ExperimentRunMetrics = {
  qualityScore: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
};

export type ExperimentRunRecord = {
  experimentId: string;
  candidateId: string;
  title: string;
  runtime: AgentRuntimeId;
  runId: string | null;
  journalId: string | null;
  parentRunId: string | null;
  sourceRunId: string | null;
  sessionId: string;
  projectId: string | null;
  model: string | null;
  prompt: string;
  status: ExperimentRunStatus;
  startedAt: string | null;
  completedAt: string | null;
  metrics: ExperimentRunMetrics;
  evaluation: EvolutionEvaluation | null;
  promotion: ExperimentPromotionDecision;
  promotionReason: string | null;
};

export type ArenaExperimentChallenger = {
  id: string;
  title?: string | null;
  runtime: AgentRuntimeId;
  sessionId: string;
  projectId?: string | null;
  prompt: string;
  model?: string | null;
  role?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ArenaExperimentCandidate = {
  id: string;
  title: string;
  continuation: AgentRuntimeContinuation;
  run: AgentRuntimeNode;
};

export type ArenaExperimentPlan = {
  experimentId: string;
  champion: {
    runtime: AgentRuntimeId;
    runId: string;
  };
  candidates: ArenaExperimentCandidate[];
};

export type ExperimentUtilityWeights = {
  quality: number;
  cost: number;
  latency: number;
};

export const DEFAULT_EXPERIMENT_UTILITY_WEIGHTS: ExperimentUtilityWeights = {
  quality: 0.7,
  cost: 0.15,
  latency: 0.15,
};

const requiredText = (value: string, field: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  return normalized;
};

const finiteNonNegative = (value: number | null) =>
  value !== null && Number.isFinite(value) && value >= 0;

const normalizeWeights = (weights: ExperimentUtilityWeights) => {
  const values = [weights.quality, weights.cost, weights.latency];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Experiment utility weights must be finite and non-negative.");
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error("At least one experiment utility weight must be positive.");
  return {
    quality: weights.quality / total,
    cost: weights.cost / total,
    latency: weights.latency / total,
  };
};

/**
 * Converts one durable champion handle into explicit challenger start requests.
 * Every candidate uses `AgentHandle.fork()`, so the existing continuation layer
 * remains the sole authority for replay/provenance and the parent run is never
 * mutated by experiment planning.
 */
export function buildArenaExperimentPlan(input: {
  experimentId: string;
  champion: Pick<AgentHandle, "runtime" | "runId" | "fork">;
  challengers: readonly ArenaExperimentChallenger[];
}): ArenaExperimentPlan {
  const experimentId = requiredText(input.experimentId, "experimentId");
  if (input.challengers.length === 0) {
    throw new Error("Arena experiment plan requires at least one challenger.");
  }

  const seen = new Set<string>();
  const candidates = input.challengers.map<ArenaExperimentCandidate>((challenger) => {
    const id = requiredText(challenger.id, "challenger.id");
    if (seen.has(id)) throw new Error(`Duplicate Arena challenger id '${id}'.`);
    seen.add(id);
    const sessionId = requiredText(challenger.sessionId, `challenger '${id}' sessionId`);
    const prompt = requiredText(challenger.prompt, `challenger '${id}' prompt`);
    const continuation = input.champion.fork();
    return {
      id,
      title: challenger.title?.trim() || id,
      continuation,
      run: {
        id: `${experimentId}:${id}`,
        runtime: challenger.runtime,
        sessionId,
        prompt,
        label: challenger.title?.trim() || id,
        role: challenger.role?.trim() || null,
        projectId: challenger.projectId?.trim() || null,
        workspaceId: challenger.workspaceId?.trim() || null,
        parentRunId: input.champion.runId,
        continuation,
        metadata: {
          ...challenger.metadata,
          model: challenger.model?.trim() || null,
          nodesExperimentId: experimentId,
          nodesCandidateId: id,
          nodesChampionRuntime: input.champion.runtime,
          nodesChampionRunId: input.champion.runId,
        },
      },
    };
  });

  return {
    experimentId,
    champion: { runtime: input.champion.runtime, runId: input.champion.runId },
    candidates,
  };
}

export function experimentPlanToTychoVariants(
  plan: ArenaExperimentPlan,
): TychoVariant<AgentRuntimeNode>[] {
  return plan.candidates.map((candidate) => ({
    id: candidate.id,
    spec: structuredClone(candidate.run),
    metadata: {
      experimentId: plan.experimentId,
      parentRunId: plan.champion.runId,
      sourceRuntime: plan.champion.runtime,
    },
  }));
}

export function createExperimentRunRecord(input: {
  plan: ArenaExperimentPlan;
  candidate: ArenaExperimentCandidate;
}): ExperimentRunRecord {
  return {
    experimentId: input.plan.experimentId,
    candidateId: input.candidate.id,
    title: input.candidate.title,
    runtime: input.candidate.run.runtime,
    runId: null,
    journalId: null,
    parentRunId: input.plan.champion.runId,
    sourceRunId: input.candidate.continuation.sourceRunId,
    sessionId: input.candidate.run.sessionId,
    projectId: input.candidate.run.projectId?.trim() || null,
    model: typeof input.candidate.run.metadata?.model === "string"
      ? input.candidate.run.metadata.model
      : null,
    prompt: input.candidate.run.prompt,
    status: "planned",
    startedAt: null,
    completedAt: null,
    metrics: {
      qualityScore: null,
      costUsd: null,
      latencyMs: null,
      inputTokens: 0,
      outputTokens: 0,
    },
    evaluation: null,
    promotion: "undecided",
    promotionReason: null,
  };
}

const minMax = (values: readonly number[], value: number, inverse = false) => {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const normalized = max === min ? 1 : (value - min) / (max - min);
  return inverse ? 1 - normalized : normalized;
};

export type RankedExperimentRun = {
  record: ExperimentRunRecord;
  utility: number;
};

/**
 * Ranks only completed/evaluated runs. Quality remains the dominant default,
 * while cost and latency become explicit trade-offs rather than hidden routing
 * heuristics. Missing cost/latency is allowed only when its configured weight is
 * zero, which prevents an unmetered candidate from winning by accident.
 */
export function rankExperimentRuns(
  records: readonly ExperimentRunRecord[],
  weights: ExperimentUtilityWeights = DEFAULT_EXPERIMENT_UTILITY_WEIGHTS,
): RankedExperimentRun[] {
  const normalized = normalizeWeights(weights);
  const eligible = records.filter((record) => {
    if (record.status !== "completed" || !Number.isFinite(record.metrics.qualityScore)) return false;
    if (normalized.cost > 0 && !finiteNonNegative(record.metrics.costUsd)) return false;
    if (normalized.latency > 0 && !finiteNonNegative(record.metrics.latencyMs)) return false;
    return true;
  });
  if (eligible.length === 0) return [];

  const qualities = eligible.map((record) => record.metrics.qualityScore as number);
  const costs = eligible.map((record) => record.metrics.costUsd ?? 0);
  const latencies = eligible.map((record) => record.metrics.latencyMs ?? 0);

  return eligible
    .map((record) => {
      const quality = minMax(qualities, record.metrics.qualityScore as number);
      const cost = normalized.cost > 0 ? minMax(costs, record.metrics.costUsd as number, true) : 0;
      const latency = normalized.latency > 0
        ? minMax(latencies, record.metrics.latencyMs as number, true)
        : 0;
      return {
        record,
        utility:
          quality * normalized.quality +
          cost * normalized.cost +
          latency * normalized.latency,
      };
    })
    .sort((left, right) => {
      const utilityDelta = right.utility - left.utility;
      if (utilityDelta !== 0) return utilityDelta;
      const qualityDelta =
        (right.record.metrics.qualityScore ?? Number.NEGATIVE_INFINITY) -
        (left.record.metrics.qualityScore ?? Number.NEGATIVE_INFINITY);
      if (qualityDelta !== 0) return qualityDelta;
      return left.record.candidateId.localeCompare(right.record.candidateId);
    });
}

export function selectExperimentPromotion(
  records: readonly ExperimentRunRecord[],
  weights: ExperimentUtilityWeights = DEFAULT_EXPERIMENT_UTILITY_WEIGHTS,
) {
  const ranking = rankExperimentRuns(records, weights);
  return {
    winner: ranking[0]?.record ?? null,
    ranking,
  };
}
