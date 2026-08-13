export const LEARNING_REWARD_SCHEMA_VERSION = 1;

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

export const DEFAULT_REWARD_WEIGHTS = Object.freeze({
  correctness: 0.45,
  passRatio: 0.30,
  reliability: 0.15,
  efficiency: 0.10,
});

function normalizeWeights(input = {}) {
  const merged = { ...DEFAULT_REWARD_WEIGHTS, ...(isRecord(input) ? input : {}) };
  const normalized = Object.fromEntries(Object.entries(DEFAULT_REWARD_WEIGHTS).map(([key, fallback]) => {
    const value = Number(merged[key]);
    return [key, Number.isFinite(value) && value >= 0 ? value : fallback];
  }));
  const total = Object.values(normalized).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { ...DEFAULT_REWARD_WEIGHTS };
  return Object.fromEntries(Object.entries(normalized).map(([key, value]) => [key, value / total]));
}

function decisionCorrectness(decision) {
  if (decision === "promote") return 1;
  if (decision === "reject") return 0.35;
  return 0;
}

function buildFromNormalizedEvidence(input, options = {}) {
  const stepCount = Math.max(0, Number(input.stepCount || 0));
  const passedSteps = Math.max(0, Number(input.passedSteps || 0));
  const failedSteps = Math.max(0, Number(input.failedSteps || 0));
  const blockedSteps = Math.max(0, Number(input.blockedSteps || 0));
  const passRatio = Number.isFinite(input.passRatio) ? clamp01(input.passRatio) : (stepCount > 0 ? clamp01(passedSteps / stepCount) : 0);
  const reliability = stepCount > 0 ? clamp01(1 - ((failedSteps + blockedSteps) / stepCount)) : 0;
  const wallSeconds = Math.max(0, Number(input.wallSeconds || 0));
  const efficiencyHalfLifeSeconds = Math.max(1, Number(options.efficiencyHalfLifeSeconds || 30));
  const efficiency = clamp01(1 / (1 + (wallSeconds / efficiencyHalfLifeSeconds)));
  const correctness = decisionCorrectness(input.decision);
  const weights = normalizeWeights(options.weights);
  const components = { correctness, passRatio, reliability, efficiency };
  const reward = clamp01(Object.entries(weights).reduce((sum, [key, weight]) => sum + (components[key] * weight), 0));
  return {
    schemaVersion: LEARNING_REWARD_SCHEMA_VERSION,
    reward,
    components,
    weights,
    evidence: {
      decision: input.decision ?? null,
      stepCount,
      passedSteps,
      failedSteps,
      blockedSteps,
      wallSeconds,
    },
  };
}

export function buildLearningReward(result, options = {}) {
  if (!isRecord(result) || !isRecord(result.summary)) {
    throw new Error("Learning reward requires Tycho summary evidence.");
  }
  return buildFromNormalizedEvidence({
    decision: result.decision,
    stepCount: result.summary.stepCount,
    passedSteps: result.summary.passedSteps,
    failedSteps: result.summary.failedSteps,
    blockedSteps: result.summary.blockedSteps,
    wallSeconds: result.budget?.wallSeconds,
  }, options);
}

export function buildLearningRewardFromEvaluation(evaluation, options = {}) {
  if (!isRecord(evaluation)) return buildFromNormalizedEvidence({}, options);
  const metrics = isRecord(evaluation.metrics) ? evaluation.metrics : {};
  const evidence = isRecord(evaluation.evidence) ? evaluation.evidence : {};
  const summary = isRecord(evidence.summary) ? evidence.summary : {};
  return buildFromNormalizedEvidence({
    decision: evidence.decision,
    stepCount: summary.stepCount,
    passedSteps: metrics.passedSteps ?? summary.passedSteps,
    failedSteps: metrics.failedSteps ?? summary.failedSteps,
    blockedSteps: metrics.blockedSteps ?? summary.blockedSteps,
    passRatio: metrics.passRatio,
    wallSeconds: metrics.wallSeconds,
  }, options);
}

export function aggregateGenerationReward(attempts) {
  const successful = attempts.filter((attempt) => attempt.status === "succeeded" && Number.isFinite(attempt.reward));
  if (!successful.length) return 0;
  const winner = successful.find((attempt) => attempt.isWinner) ?? [...successful].sort((a, b) => b.reward - a.reward)[0];
  const mean = successful.reduce((sum, attempt) => sum + attempt.reward, 0) / successful.length;
  return clamp01((winner.reward * 0.7) + (mean * 0.3));
}
