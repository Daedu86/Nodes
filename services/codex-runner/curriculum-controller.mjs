import { deriveCapabilityProfiles, selectCapabilityGap } from "./capability-model.mjs";
import { buildCurriculumTask } from "./curriculum-task-generator.mjs";
import { parseAllowedCurriculumDomains, validateCurriculumTask } from "./curriculum-validator.mjs";

const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function normalizeMode(value) {
  const mode = asString(value || process.env.TYCHO_CURRICULUM_MODE) || "off";
  if (!["off", "observe", "online"].includes(mode)) throw new Error(`Unsupported TYCHO_CURRICULUM_MODE: ${mode}.`);
  return mode;
}

export function createCurriculumController(options = {}) {
  const mode = normalizeMode(options.mode);
  const maxTasksPerRun = Math.max(1, Number(options.maxTasksPerRun ?? process.env.TYCHO_CURRICULUM_MAX_TASKS_PER_RUN ?? 4));
  const maxDifficulty = Math.max(0.2, Math.min(1, Number(options.maxDifficulty ?? process.env.TYCHO_CURRICULUM_MAX_DIFFICULTY ?? 0.85)));
  const targetReward = Math.max(0.2, Math.min(0.95, Number(options.targetReward ?? process.env.TYCHO_CURRICULUM_TARGET_REWARD ?? 0.65)));
  const allowedDomains = Array.isArray(options.allowedDomains) ? options.allowedDomains.filter(Boolean) : parseAllowedCurriculumDomains();

  async function analyze(input = {}) {
    const profiles = deriveCapabilityProfiles(input.trajectories || [], input.skills || [], { targetReward });
    const selected = selectCapabilityGap(profiles, {
      allowedDomains,
      defaultDomain: asString(input.defaultDomain) || "general-evolution",
    });
    return {
      mode,
      maxTasksPerRun,
      maxDifficulty,
      targetReward,
      allowedDomains,
      profiles,
      frontier: selected,
    };
  }

  async function plan(input = {}) {
    const generation = Math.max(1, Number(input.generation) || 1);
    if (mode === "off" || generation > maxTasksPerRun) {
      return { mode, task: null, reason: mode === "off" ? "curriculum-off" : "task-budget-exhausted" };
    }
    const report = await analyze(input);
    const task = validateCurriculumTask(buildCurriculumTask(report.frontier, {
      workspaceId: input.workspaceId,
      generation,
    }, { maxTasksPerRun, maxDifficulty, targetReward }), { maxDifficulty, allowedDomains });
    return { mode, task, frontier: report.frontier };
  }

  async function status() {
    return { mode, maxTasksPerRun, maxDifficulty, targetReward, allowedDomains };
  }

  return { mode, maxTasksPerRun, maxDifficulty, targetReward, allowedDomains, analyze, plan, status };
}
