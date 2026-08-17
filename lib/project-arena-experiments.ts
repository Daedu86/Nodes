import {
  DEFAULT_EXPERIMENT_UTILITY_WEIGHTS,
  rankExperimentRuns,
  type ExperimentRunRecord,
  type ExperimentUtilityWeights,
} from "@/lib/agent-experiments";

export type ProjectArenaExperimentEntry = {
  key: string;
  experimentId: string;
  candidateId: string;
  title: string;
  runtime: string;
  runId: string | null;
  parentRunId: string | null;
  journalId: string | null;
  status: ExperimentRunRecord["status"];
  promotion: ExperimentRunRecord["promotion"];
  qualityScore: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  utility: number | null;
};

export type ProjectArenaExperimentSummary = {
  experimentId: string;
  comparedCount: number;
  leadKey: string | null;
  summary: string;
};

/**
 * Arena view over durable experiment records. The adapter deliberately keeps
 * Tycho's quality score visible beside cost and latency so promotion trade-offs
 * are inspectable rather than collapsed into an unexplained heuristic.
 */
export function buildProjectArenaExperimentEntries(
  records: readonly ExperimentRunRecord[],
  weights: ExperimentUtilityWeights = DEFAULT_EXPERIMENT_UTILITY_WEIGHTS,
): ProjectArenaExperimentEntry[] {
  const utilityByCandidate = new Map(
    rankExperimentRuns(records, weights).map(({ record, utility }) => [record.candidateId, utility]),
  );
  return records
    .map((record) => ({
      key: `${record.experimentId}:${record.candidateId}`,
      experimentId: record.experimentId,
      candidateId: record.candidateId,
      title: record.title,
      runtime: record.runtime,
      runId: record.runId,
      parentRunId: record.parentRunId,
      journalId: record.journalId,
      status: record.status,
      promotion: record.promotion,
      qualityScore: record.metrics.qualityScore,
      costUsd: record.metrics.costUsd,
      latencyMs: record.metrics.latencyMs,
      inputTokens: record.metrics.inputTokens,
      outputTokens: record.metrics.outputTokens,
      utility: utilityByCandidate.get(record.candidateId) ?? null,
    }))
    .sort((left, right) => {
      if (left.utility !== null && right.utility !== null) return right.utility - left.utility;
      if (left.utility !== null) return -1;
      if (right.utility !== null) return 1;
      return left.candidateId.localeCompare(right.candidateId);
    });
}

export function buildProjectArenaExperimentSummary(
  records: readonly ExperimentRunRecord[],
  weights: ExperimentUtilityWeights = DEFAULT_EXPERIMENT_UTILITY_WEIGHTS,
): ProjectArenaExperimentSummary | null {
  if (records.length < 2) return null;
  const experimentId = records[0]?.experimentId ?? "unknown";
  if (records.some((record) => record.experimentId !== experimentId)) {
    throw new Error("Project Arena experiment comparison requires one experimentId.");
  }
  const entries = buildProjectArenaExperimentEntries(records, weights);
  const lead = entries.find((entry) => entry.utility !== null) ?? null;
  return {
    experimentId,
    comparedCount: entries.length,
    leadKey: lead?.key ?? null,
    summary: lead
      ? `${lead.title} leads ${experimentId} with utility ${lead.utility!.toFixed(4)}, Tycho quality ${lead.qualityScore}, cost $${lead.costUsd}, and latency ${lead.latencyMs} ms.`
      : `${experimentId} has ${entries.length} candidates, but no candidate has complete quality/cost/latency evidence for promotion.`,
  };
}
