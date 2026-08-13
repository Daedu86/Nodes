import { skillRef } from "./skill-schema.mjs";

const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function topologyOf(trajectory) {
  return asString(trajectory?.candidateMetadata?.multiAgentTeam?.topologyId) || "single";
}

function usedSkillRefs(trajectory) {
  const values = trajectory?.candidateMetadata?.skillContext?.skillRefs;
  return Array.isArray(values) ? values.filter((value) => typeof value === "string") : [];
}

const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function evaluateSkillValidation(skill, trajectories, options = {}) {
  const ref = skillRef(skill);
  const matching = trajectories.filter((item) => item?.status === "succeeded" && item.actionId && Number.isFinite(item.reward));
  const used = matching.filter((item) => usedSkillRefs(item).includes(ref));
  const source = new Set(skill.sourceTrajectoryIds || []);
  const baseline = matching.filter((item) => {
    if (usedSkillRefs(item).includes(ref)) return false;
    if (source.has(item.trajectoryId)) return false;
    const sameAction = skill.preconditions?.includes(`strategy=${item.actionId}`);
    const sameTopology = skill.preconditions?.includes(`team=${topologyOf(item)}`);
    return sameAction && sameTopology;
  });
  const skillMeanReward = mean(used.map((item) => item.reward));
  const baselineMeanReward = mean(baseline.map((item) => item.reward));
  const rewardLift = used.length && baseline.length ? skillMeanReward - baselineMeanReward : null;
  const minObservations = Math.max(1, Number(options.minObservations ?? process.env.TYCHO_SKILL_MIN_VALIDATION_OBSERVATIONS ?? 3));
  const minBaseline = Math.max(1, Number(options.minBaseline ?? process.env.TYCHO_SKILL_MIN_BASELINE_OBSERVATIONS ?? 3));
  const minLift = Number(options.minLift ?? process.env.TYCHO_SKILL_MIN_REWARD_LIFT ?? 0.03);
  const promote = used.length >= minObservations && baseline.length >= minBaseline && rewardLift !== null && rewardLift >= minLift;
  const deprecate = skill.status === "promoted" && used.length >= minObservations * 2 && baseline.length >= minBaseline && rewardLift !== null && rewardLift < -Math.abs(minLift);
  const confidence = Math.min(1, Math.min(used.length / minObservations, baseline.length / minBaseline));
  return {
    ref,
    promote,
    deprecate,
    evidence: {
      validationObservations: used.length,
      baselineObservations: baseline.length,
      skillMeanReward: used.length ? skillMeanReward : null,
      baselineMeanReward: baseline.length ? baselineMeanReward : null,
      rewardLift,
      confidence,
    },
  };
}

export async function validateRegisteredSkills({ trajectoryStore, skillRegistry, workspaceId = null, ...options }) {
  const trajectories = await trajectoryStore.list(workspaceId ? { workspaceId } : {});
  const skills = await skillRegistry.list();
  const results = [];
  for (const skill of skills) {
    if (!["validating", "promoted"].includes(skill.status)) continue;
    const evaluated = evaluateSkillValidation(skill, trajectories, options);
    let updated = skill;
    if (evaluated.promote && skill.status !== "promoted") {
      updated = await skillRegistry.transition(evaluated.ref, "promoted", evaluated.evidence);
    } else if (evaluated.deprecate) {
      updated = await skillRegistry.transition(evaluated.ref, "deprecated", evaluated.evidence);
    } else {
      updated = await skillRegistry.transition(evaluated.ref, skill.status, evaluated.evidence);
    }
    results.push({ ...evaluated, status: updated.status });
  }
  return results;
}
