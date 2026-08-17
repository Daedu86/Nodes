import type {
  ExperimentRunRecord,
  ExperimentRunMetrics,
} from "@/lib/agent-experiments";
import type { EvolutionEvaluation } from "@/lib/tycho-evolution-loop";

const metric = (evaluation: EvolutionEvaluation, key: string) => {
  const value = evaluation.metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * Projects Tycho's empirical evaluation into a durable experiment snapshot.
 * Tycho's score is always the quality authority. Cost/latency/token metrics may
 * come from the evaluator or from the provider-neutral AgentHandle metrics
 * projection supplied by the caller.
 */
export function applyTychoEvaluation(
  record: ExperimentRunRecord,
  evaluation: EvolutionEvaluation,
  observed: Partial<Omit<ExperimentRunMetrics, "qualityScore">> = {},
): ExperimentRunRecord {
  if (!Number.isFinite(evaluation.score)) {
    throw new Error("Tycho evaluation score must be finite.");
  }
  const costUsd = observed.costUsd ?? metric(evaluation, "costUsd") ?? record.metrics.costUsd;
  const latencyMs = observed.latencyMs ?? metric(evaluation, "latencyMs") ?? record.metrics.latencyMs;
  const inputTokens = observed.inputTokens ?? metric(evaluation, "inputTokens") ?? record.metrics.inputTokens;
  const outputTokens = observed.outputTokens ?? metric(evaluation, "outputTokens") ?? record.metrics.outputTokens;
  return {
    ...record,
    status: "completed",
    evaluation: structuredClone(evaluation),
    metrics: {
      qualityScore: evaluation.score,
      costUsd,
      latencyMs,
      inputTokens,
      outputTokens,
    },
  };
}

/**
 * Records the promotion decision without erasing rejected candidates. This is
 * intentionally separate from ranking: a caller can require additional Tycho,
 * safety or business gates before naming a challenger champion.
 */
export function recordExperimentPromotion(input: {
  records: readonly ExperimentRunRecord[];
  winnerCandidateId: string;
  reason: string;
}): ExperimentRunRecord[] {
  const winnerCandidateId = input.winnerCandidateId.trim();
  const reason = input.reason.trim();
  if (!winnerCandidateId) throw new Error("winnerCandidateId must not be empty.");
  if (!reason) throw new Error("promotion reason must not be empty.");
  if (!input.records.some((record) => record.candidateId === winnerCandidateId)) {
    throw new Error(`Experiment winner '${winnerCandidateId}' was not found.`);
  }
  return input.records.map((record) => ({
    ...record,
    promotion: record.candidateId === winnerCandidateId ? "challenger" : "rejected",
    promotionReason: reason,
  }));
}
