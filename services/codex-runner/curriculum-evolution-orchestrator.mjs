import { createRunnerCodexVariantGenerator } from "./codex-evolution-generator.mjs";
import { createCurriculumController } from "./curriculum-controller.mjs";
import { createLearningEvolutionOrchestrator } from "./learning-evolution-orchestrator.mjs";
import { createModelBasedPlanner } from "./model-based-planner.mjs";
import { createPredictiveWorldModel } from "./predictive-world-model.mjs";
import { createSkillRegistry } from "./skill-registry.mjs";
import { createTrajectoryStore } from "./trajectory-store.mjs";
import { createWorldModelVariantGenerator } from "./world-model-variant-generator.mjs";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function parentDomain(input) {
  return asString(input?.parent?.metadata?.domain)
    || asString(input?.parent?.metadata?.taskDomain)
    || asString(input?.parent?.metadata?.curriculumContext?.task?.domain)
    || "general-evolution";
}

function curriculumOptions(learning = {}) {
  return {
    mode: learning.curriculumMode,
    maxTasksPerRun: learning.curriculumMaxTasksPerRun,
    maxDifficulty: learning.curriculumMaxDifficulty,
    targetReward: learning.curriculumTargetReward,
    allowedDomains: learning.curriculumAllowedDomains,
  };
}

function worldModelOptions(learning = {}) {
  return {
    mode: learning.worldModelMode,
    expansionFactor: learning.worldModelExpansionFactor,
    maxPool: learning.worldModelMaxPool,
    explorationWeight: learning.worldModelExplorationWeight,
    costWeight: learning.worldModelCostWeight,
    minSupport: learning.worldModelMinSupport,
    minSimilarity: learning.worldModelMinSimilarity,
  };
}

function plannerOptions(learning = {}) {
  return {
    mode: learning.plannerMode,
    maxDepth: learning.plannerMaxDepth,
    maxBranches: learning.plannerMaxBranches,
    gamma: learning.plannerGamma,
    minConfidence: learning.plannerMinConfidence,
    uncertaintyPenalty: learning.plannerUncertaintyPenalty,
    minSupport: learning.plannerMinSupport,
    timeoutMs: learning.plannerTimeoutMs,
  };
}

function withCurriculumEvidence(parentEvaluation, plan) {
  const base = isRecord(parentEvaluation) ? parentEvaluation : { score: 0, metrics: {}, evidence: {} };
  return {
    ...base,
    metrics: isRecord(base.metrics) ? base.metrics : {},
    evidence: {
      ...(isRecord(base.evidence) ? base.evidence : {}),
      curriculumTask: plan.task,
      curriculumFrontier: plan.frontier || null,
    },
  };
}

function stampCurriculum(generated, plan) {
  if (!plan?.task) return generated;
  return {
    ...generated,
    variants: generated.variants.map((variant) => ({
      ...variant,
      metadata: {
        ...(isRecord(variant.metadata) ? variant.metadata : {}),
        curriculumContext: {
          mode: plan.mode,
          task: plan.task,
          frontier: plan.frontier || null,
        },
      },
    })),
  };
}

export function createCurriculumEvolutionOrchestrator(options = {}) {
  const learning = options.learning || {};
  const replay = options.trajectoryStore || createTrajectoryStore(learning);
  const skillRegistry = options.skillRegistry || createSkillRegistry(learning);
  const curriculum = options.curriculumController || createCurriculumController(curriculumOptions(learning));
  const rawGenerator = options.generateVariants || createRunnerCodexVariantGenerator({
    host: options.host || "127.0.0.1",
    codexPort: Number(options.codexPort || process.env.CODEX_RUNNER_PORT || 8787),
    token: options.token ?? process.env.CODEX_RUNNER_TOKEN?.trim() ?? null,
  });
  const worldModel = options.worldModel || createPredictiveWorldModel({
    trajectoryStore: replay,
    minSupport: learning.worldModelMinSupport ?? process.env.TYCHO_WORLD_MODEL_MIN_SUPPORT,
    minSimilarity: learning.worldModelMinSimilarity ?? process.env.TYCHO_WORLD_MODEL_MIN_SIMILARITY,
  });
  const planner = options.planner || createModelBasedPlanner({
    trajectoryStore: replay,
    ...plannerOptions(learning),
  });
  const worldGenerator = options.worldModelGenerator || createWorldModelVariantGenerator({
    baseGenerator: rawGenerator,
    worldModel,
    planner,
    plannerMode: learning.plannerMode,
    ...worldModelOptions(learning),
  });

  async function curriculumGenerator(input) {
    const [trajectories, skills] = await Promise.all([
      replay.list({ workspaceId: input.workspaceId }),
      skillRegistry.list(),
    ]);
    const plan = await curriculum.plan({
      trajectories,
      skills,
      workspaceId: input.workspaceId,
      generation: input.generation,
      defaultDomain: parentDomain(input),
    });
    if (!plan.task) return worldGenerator.generate(input);
    const generated = await worldGenerator.generate({
      ...input,
      parentEvaluation: withCurriculumEvidence(input.parentEvaluation, plan),
    });
    return stampCurriculum(generated, plan);
  }

  const core = createLearningEvolutionOrchestrator({
    ...options,
    trajectoryStore: replay,
    skillRegistry,
    generateVariants: curriculumGenerator,
  });

  async function curriculumReport(workspaceId = null, defaultDomain = "general-evolution") {
    const [trajectories, skills] = await Promise.all([
      replay.list(workspaceId ? { workspaceId } : {}),
      skillRegistry.list(),
    ]);
    return curriculum.analyze({ trajectories, skills, defaultDomain });
  }

  async function curriculumPlan(input = {}) {
    const [trajectories, skills] = await Promise.all([
      replay.list(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      skillRegistry.list(),
    ]);
    return curriculum.plan({
      trajectories,
      skills,
      workspaceId: input.workspaceId,
      generation: input.generation || 1,
      defaultDomain: input.defaultDomain || "general-evolution",
    });
  }

  async function worldModelStatus(workspaceId = null) {
    return worldGenerator.status(workspaceId);
  }

  async function plannerStatus(workspaceId = null) {
    return planner.status(workspaceId);
  }

  async function plannerPlan(input = {}) {
    return planner.planPrediction({
      workspaceId: asString(input.workspaceId),
      prediction: isRecord(input.prediction) ? input.prediction : {},
    });
  }

  async function learningStatus() {
    const [base, curriculumStatus, predictiveStatus, planningStatus] = await Promise.all([
      core.learningStatus(),
      curriculum.status(),
      worldModelStatus(),
      plannerStatus(),
    ]);
    return { ...base, curriculum: curriculumStatus, worldModel: predictiveStatus, planner: planningStatus };
  }

  async function enrichSnapshot(snapshot) {
    if (!snapshot) return snapshot;
    const [curriculumStatus, predictiveStatus, planningStatus] = await Promise.all([
      curriculum.status(),
      worldModelStatus(snapshot.workspaceId),
      plannerStatus(snapshot.workspaceId),
    ]);
    return {
      ...snapshot,
      learning: {
        ...(isRecord(snapshot.learning) ? snapshot.learning : await core.learningStatus()),
        curriculum: curriculumStatus,
        worldModel: predictiveStatus,
        planner: planningStatus,
      },
    };
  }

  async function start(input, ownerId) {
    return enrichSnapshot(await core.start(input, ownerId));
  }

  async function get(runId, ownerId) {
    return enrichSnapshot(await core.get(runId, ownerId));
  }

  async function cancel(runId, ownerId) {
    return enrichSnapshot(await core.cancel(runId, ownerId));
  }

  async function trainOffline(input = {}) {
    const base = await core.trainOffline(input);
    return {
      ...base,
      curriculum: await curriculumReport(input.workspaceId || null, input.defaultDomain || "general-evolution"),
      worldModel: await worldModelStatus(input.workspaceId || null),
      planner: await plannerStatus(input.workspaceId || null),
    };
  }

  return {
    ...core,
    start,
    get,
    cancel,
    learningStatus,
    trainOffline,
    curriculumReport,
    curriculumPlan,
    worldModelStatus,
    worldModelPredict: (input) => worldModel.predict(input),
    plannerStatus,
    plannerPlan,
  };
}
