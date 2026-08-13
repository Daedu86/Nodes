const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

function curriculumMeta(item) {
  return isRecord(item?.candidateMetadata?.curriculumContext) ? item.candidateMetadata.curriculumContext : null;
}

export function capabilityDomain(item) {
  const curriculum = curriculumMeta(item);
  return asString(curriculum?.task?.domain)
    || asString(item?.candidateMetadata?.domain)
    || asString(item?.candidateMetadata?.taskDomain)
    || "general-evolution";
}

function capabilityIdentity(item) {
  const curriculum = curriculumMeta(item);
  if (asString(curriculum?.task?.capabilityKey)) return curriculum.task.capabilityKey;
  const state = isRecord(item?.state) ? item.state : {};
  return [
    `decision=${asString(state.decision) || "unknown"}`,
    `pass=${asString(state.passBand) || "unknown"}`,
    `blocked=${asString(state.blockedBand) || "unknown"}`,
    `speed=${asString(state.speedBand) || "unknown"}`,
  ].join("|");
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function chronological(items) {
  return [...items].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || String(a.trajectoryId || "").localeCompare(String(b.trajectoryId || "")));
}

function promotedSkillCount(skills, domain) {
  return skills.filter((skill) => skill?.status === "promoted" && skill?.domain === domain).length;
}

export function deriveCapabilityProfiles(trajectories = [], skills = [], options = {}) {
  const targetReward = clamp(options.targetReward ?? process.env.TYCHO_CURRICULUM_TARGET_REWARD ?? 0.65, 0.2, 0.95);
  const groups = new Map();
  for (const item of trajectories) {
    if (!isRecord(item)) continue;
    const domain = capabilityDomain(item);
    const capabilityKey = capabilityIdentity(item);
    const key = `${domain}|${capabilityKey}`;
    const bucket = groups.get(key) || { domain, capabilityKey, items: [] };
    bucket.items.push(item);
    groups.set(key, bucket);
  }

  const profiles = [];
  for (const bucket of groups.values()) {
    const items = chronological(bucket.items);
    const rewards = items.filter((item) => Number.isFinite(item.reward)).map((item) => clamp(item.reward));
    const observations = rewards.length;
    const successes = items.filter((item) => item.status === "succeeded").length;
    const meanReward = mean(rewards);
    const split = Math.max(1, Math.floor(rewards.length / 2));
    const previousReward = rewards.length > 1 ? mean(rewards.slice(0, split)) : meanReward;
    const recentReward = rewards.length > 1 ? mean(rewards.slice(split)) : meanReward;
    const improvementRate = recentReward - previousReward;
    const uncertainty = 1 / Math.sqrt(observations + 1);
    const distance = Math.abs(meanReward - targetReward);
    const frontier = clamp(1 - distance / Math.max(targetReward, 1 - targetReward));
    const skillCount = promotedSkillCount(skills, bucket.domain);
    const skillGap = skillCount === 0 ? 1 : 1 / (skillCount + 1);
    const stagnation = clamp(0.5 - improvementRate, 0, 1);
    const learningValue = clamp((0.35 * uncertainty) + (0.25 * frontier) + (0.2 * skillGap) + (0.2 * stagnation));
    profiles.push({
      domain: bucket.domain,
      capabilityKey: bucket.capabilityKey,
      observations,
      successRate: items.length ? successes / items.length : 0,
      meanReward,
      recentReward,
      previousReward,
      improvementRate,
      uncertainty,
      frontier,
      promotedSkillCount: skillCount,
      skillGap,
      learningValue,
      lastTrajectoryId: items.at(-1)?.trajectoryId || null,
    });
  }

  return profiles.sort((a, b) => (b.learningValue - a.learningValue) || (a.meanReward - b.meanReward) || a.domain.localeCompare(b.domain) || a.capabilityKey.localeCompare(b.capabilityKey));
}

export function bootstrapCapabilityProfile(domain = "general-evolution") {
  return {
    domain,
    capabilityKey: "bootstrap|decision=unknown|pass=unknown|blocked=unknown|speed=unknown",
    observations: 0,
    successRate: 0,
    meanReward: 0.5,
    recentReward: 0.5,
    previousReward: 0.5,
    improvementRate: 0,
    uncertainty: 1,
    frontier: 1,
    promotedSkillCount: 0,
    skillGap: 1,
    learningValue: 1,
    lastTrajectoryId: null,
  };
}

export function selectCapabilityGap(profiles, options = {}) {
  const allowedDomains = Array.isArray(options.allowedDomains) ? options.allowedDomains.filter(Boolean) : [];
  const filtered = allowedDomains.length ? profiles.filter((profile) => allowedDomains.includes(profile.domain)) : profiles;
  if (filtered.length) return filtered[0];
  return bootstrapCapabilityProfile(allowedDomains[0] || options.defaultDomain || "general-evolution");
}
