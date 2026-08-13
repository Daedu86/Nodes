const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const WORLD_MODEL_SCHEMA_VERSION = 1;
export const WORLD_MODEL_VERSION = "empirical-knn-v1";

function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function words(value) {
  return unique(String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúüñ_-]+/gi, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 80));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size && !b.size) return 0.5;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function skillRefsFromEvidence(evidence) {
  if (Array.isArray(evidence?.skillContext)) {
    return unique(evidence.skillContext.map((item) => asString(item?.ref)));
  }
  return [];
}

function featureFromCandidate(input, variant) {
  const evidence = isRecord(input?.parentEvaluation?.evidence) ? input.parentEvaluation.evidence : {};
  const metadata = isRecord(variant?.metadata) ? variant.metadata : {};
  const policy = isRecord(metadata.learningPolicy) ? metadata.learningPolicy : isRecord(evidence.learningPolicy) ? evidence.learningPolicy : {};
  const team = isRecord(metadata.multiAgentTeam) ? metadata.multiAgentTeam : {};
  const contribution = isRecord(metadata.multiAgentContribution) ? metadata.multiAgentContribution : {};
  const teamContext = isRecord(evidence.multiAgentTeamContext) ? evidence.multiAgentTeamContext : {};
  const agent = isRecord(evidence.multiAgentAgent) ? evidence.multiAgentAgent : {};
  const skillContext = isRecord(metadata.skillContext) ? metadata.skillContext : {};
  const curriculum = isRecord(metadata.curriculumContext?.task) ? metadata.curriculumContext.task : isRecord(evidence.curriculumTask) ? evidence.curriculumTask : {};
  const hypothesis = asString(metadata.hypothesis) || "";
  const rationale = asString(metadata.rationale) || "";
  return {
    stateKey: asString(policy.stateKey),
    actionId: asString(policy.actionId) || "exploit",
    topologyId: asString(team.topologyId) || asString(teamContext.topology) || "single",
    agentProfile: asString(contribution.profileId) || asString(agent.profileId) || "generalist",
    skillRefs: unique(Array.isArray(skillContext.skillRefs) ? skillContext.skillRefs.map(asString) : skillRefsFromEvidence(evidence)),
    curriculumCapability: asString(curriculum.capabilityKey),
    domain: asString(curriculum.domain) || asString(metadata.domain) || asString(metadata.taskDomain) || "general-evolution",
    textTokens: words(`${hypothesis} ${rationale}`),
  };
}

function featureFromTrajectory(trajectory) {
  const metadata = isRecord(trajectory?.candidateMetadata) ? trajectory.candidateMetadata : {};
  const policy = isRecord(metadata.learningPolicy) ? metadata.learningPolicy : {};
  const team = isRecord(metadata.multiAgentTeam) ? metadata.multiAgentTeam : {};
  const contribution = isRecord(metadata.multiAgentContribution) ? metadata.multiAgentContribution : {};
  const skillContext = isRecord(metadata.skillContext) ? metadata.skillContext : {};
  const curriculum = isRecord(metadata.curriculumContext?.task) ? metadata.curriculumContext.task : {};
  return {
    stateKey: asString(policy.stateKey) || asString(trajectory.stateKey),
    actionId: asString(policy.actionId) || asString(trajectory.actionId) || "exploit",
    topologyId: asString(team.topologyId) || "single",
    agentProfile: asString(contribution.profileId) || "generalist",
    skillRefs: unique(Array.isArray(skillContext.skillRefs) ? skillContext.skillRefs.map(asString) : []),
    curriculumCapability: asString(curriculum.capabilityKey),
    domain: asString(curriculum.domain) || asString(metadata.domain) || asString(metadata.taskDomain) || "general-evolution",
    textTokens: words(`${metadata.hypothesis || ""} ${metadata.rationale || ""}`),
  };
}

function exact(left, right, neutral = 0.5) {
  if (!left && !right) return neutral;
  if (!left || !right) return 0;
  return left === right ? 1 : 0;
}

function similarity(candidate, historical) {
  const skillSimilarity = jaccard(candidate.skillRefs, historical.skillRefs);
  const textSimilarity = jaccard(candidate.textTokens, historical.textTokens);
  return clamp01(
    exact(candidate.stateKey, historical.stateKey) * 0.20
      + exact(candidate.actionId, historical.actionId) * 0.18
      + exact(candidate.topologyId, historical.topologyId) * 0.14
      + exact(candidate.agentProfile, historical.agentProfile) * 0.10
      + exact(candidate.curriculumCapability, historical.curriculumCapability) * 0.12
      + exact(candidate.domain, historical.domain) * 0.10
      + skillSimilarity * 0.08
      + textSimilarity * 0.08,
  );
}

function stateKey(state) {
  if (!isRecord(state)) return "unknown";
  return ["decision", "passBand", "blockedBand", "speedBand"]
    .map((key) => `${key}=${asString(state[key]) || "unknown"}`)
    .join("|");
}

function likelyNextState(neighbors) {
  const weights = new Map();
  let total = 0;
  for (const neighbor of neighbors) {
    const key = stateKey(neighbor.trajectory.nextState);
    weights.set(key, (weights.get(key) || 0) + neighbor.weight);
    total += neighbor.weight;
  }
  if (!weights.size || total <= 0) return null;
  const ranked = [...weights.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return { stateKey: ranked[0][0], probability: clamp01(ranked[0][1] / total) };
}

function predictOne(trajectories, input, variant, options = {}) {
  const minSimilarity = Math.max(0, Math.min(1, Number(options.minSimilarity ?? 0.18)));
  const maxNeighbors = Math.max(3, Math.min(50, Number(options.maxNeighbors ?? 24)));
  const minSupport = Math.max(2, Number(options.minSupport ?? 4));
  const feature = featureFromCandidate(input, variant);
  const scored = trajectories
    .filter((trajectory) => Number.isFinite(trajectory?.reward))
    .map((trajectory) => {
      const similarityScore = similarity(feature, featureFromTrajectory(trajectory));
      return { trajectory, similarity: similarityScore, weight: similarityScore ** 2 };
    })
    .filter((item) => item.similarity >= minSimilarity && item.weight > 0)
    .sort((a, b) => (b.similarity - a.similarity) || (b.trajectory.reward - a.trajectory.reward) || a.trajectory.trajectoryId.localeCompare(b.trajectory.trajectoryId))
    .slice(0, maxNeighbors);
  const globalMean = trajectories.length
    ? trajectories.reduce((sum, trajectory) => sum + (Number.isFinite(trajectory.reward) ? trajectory.reward : 0), 0) / trajectories.length
    : 0.5;
  const totalWeight = scored.reduce((sum, item) => sum + item.weight, 0);
  const expectedReward = totalWeight > 0
    ? scored.reduce((sum, item) => sum + item.trajectory.reward * item.weight, 0) / totalWeight
    : globalMean;
  const expectedWallSeconds = totalWeight > 0
    ? scored.reduce((sum, item) => sum + (Number(item.trajectory.metrics?.wallSeconds) || 0) * item.weight, 0) / totalWeight
    : 0;
  const variance = totalWeight > 0
    ? scored.reduce((sum, item) => sum + ((item.trajectory.reward - expectedReward) ** 2) * item.weight, 0) / totalWeight
    : 0.25;
  const averageSimilarity = scored.length ? scored.reduce((sum, item) => sum + item.similarity, 0) / scored.length : 0;
  const supportConfidence = Math.min(1, scored.length / minSupport);
  const confidence = clamp01(supportConfidence * averageSimilarity * (1 - Math.min(0.8, Math.sqrt(variance))));
  const uncertainty = clamp01(1 - confidence);
  return {
    schemaVersion: WORLD_MODEL_SCHEMA_VERSION,
    modelVersion: WORLD_MODEL_VERSION,
    expectedReward: clamp01(expectedReward),
    uncertainty,
    confidence,
    support: scored.length,
    expectedWallSeconds: Math.max(0, expectedWallSeconds),
    likelyNextState: likelyNextState(scored),
    coldStart: scored.length === 0,
  };
}

function calibration(trajectories) {
  const observed = trajectories.filter((trajectory) => Number.isFinite(trajectory?.candidateMetadata?.worldModelPrediction?.expectedReward) && Number.isFinite(trajectory?.reward));
  if (!observed.length) return { observations: 0, meanAbsoluteError: null, bias: null };
  const errors = observed.map((trajectory) => trajectory.candidateMetadata.worldModelPrediction.expectedReward - trajectory.reward);
  return {
    observations: observed.length,
    meanAbsoluteError: errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length,
    bias: errors.reduce((sum, error) => sum + error, 0) / errors.length,
  };
}

export function createPredictiveWorldModel(options = {}) {
  if (!options.trajectoryStore || typeof options.trajectoryStore.list !== "function") {
    throw new Error("Predictive world model requires a trajectoryStore.");
  }
  const trajectoryStore = options.trajectoryStore;

  async function trajectoriesFor(workspaceId) {
    return trajectoryStore.list(workspaceId ? { workspaceId } : {});
  }

  async function predict({ workspaceId, input, variant }) {
    const trajectories = await trajectoriesFor(workspaceId || input?.workspaceId);
    return predictOne(trajectories, input, variant, options);
  }

  async function predictBatch({ workspaceId, input, variants }) {
    const trajectories = await trajectoriesFor(workspaceId || input?.workspaceId);
    return variants.map((variant) => ({ variant, prediction: predictOne(trajectories, input, variant, options) }));
  }

  async function report(workspaceId = null) {
    const trajectories = await trajectoriesFor(workspaceId);
    return {
      schemaVersion: WORLD_MODEL_SCHEMA_VERSION,
      modelVersion: WORLD_MODEL_VERSION,
      observations: trajectories.length,
      calibration: calibration(trajectories),
      ready: trajectories.length >= Math.max(2, Number(options.minSupport ?? 4)),
    };
  }

  return { predict, predictBatch, report };
}
