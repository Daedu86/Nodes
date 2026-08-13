import { createHash } from "node:crypto";

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function targetDifficulty(profile, options = {}) {
  const maxDifficulty = clamp(options.maxDifficulty ?? process.env.TYCHO_CURRICULUM_MAX_DIFFICULTY ?? 0.85, 0.2, 1);
  const targetReward = clamp(options.targetReward ?? process.env.TYCHO_CURRICULUM_TARGET_REWARD ?? 0.65, 0.2, 0.95);
  if (!profile.observations) return Math.min(maxDifficulty, 0.35);
  const adjustment = (profile.meanReward - targetReward) * 0.45;
  const base = 0.5 + adjustment;
  return Math.min(maxDifficulty, clamp(base, 0.2, 0.95));
}

function objectiveFor(profile) {
  if (!profile.observations) return `Establish a reproducible baseline for capability ${profile.capabilityKey} in domain ${profile.domain}.`;
  if (profile.meanReward >= 0.8) return `Stress-test capability ${profile.capabilityKey} with a slightly harder variant while preserving reproducibility.`;
  if (profile.meanReward <= 0.35) return `Create an intermediate exercise that isolates the weakest mechanism in capability ${profile.capabilityKey}.`;
  if (profile.improvementRate <= 0.02) return `Break the plateau for capability ${profile.capabilityKey} by testing one targeted variation at the current frontier.`;
  return `Practice capability ${profile.capabilityKey} near its current learning frontier and collect discriminating evidence.`;
}

export function buildCurriculumTask(profile, input = {}, options = {}) {
  const difficulty = targetDifficulty(profile, options);
  const generation = Math.max(1, Number(input.generation) || 1);
  const taskId = `curr-${digest(`${input.workspaceId || "workspace"}|${profile.domain}|${profile.capabilityKey}|${generation}|${difficulty.toFixed(3)}`)}`;
  return {
    schemaVersion: 1,
    taskId,
    domain: profile.domain,
    capabilityKey: profile.capabilityKey,
    difficulty,
    objective: objectiveFor(profile),
    constraints: [
      "Stay within the current workspace and authoritative Tycho protocol.",
      "Do not request external network access, credentials, privileged execution, or broader filesystem access.",
      "Change only what is necessary to test the curriculum objective.",
      "Preserve deterministic evidence collection and existing episode budgets.",
    ],
    successCriteria: [
      "Produce a candidate whose Tycho evidence can distinguish progress from regression.",
      "Keep the experiment reproducible under the current execution backend.",
      "Record enough evidence to update capability reward statistics.",
    ],
    reason: {
      observations: profile.observations,
      meanReward: profile.meanReward,
      improvementRate: profile.improvementRate,
      uncertainty: profile.uncertainty,
      skillGap: profile.skillGap,
      learningValue: profile.learningValue,
    },
    budget: {
      generation,
      maxTasksPerRun: Math.max(1, Number(options.maxTasksPerRun ?? process.env.TYCHO_CURRICULUM_MAX_TASKS_PER_RUN ?? 4)),
      maxDifficulty: clamp(options.maxDifficulty ?? process.env.TYCHO_CURRICULUM_MAX_DIFFICULTY ?? 0.85, 0.2, 1),
    },
  };
}
