import { createRunnerCodexVariantGenerator } from "./codex-evolution-generator.mjs";
import { createCurriculumController } from "./curriculum-controller.mjs";
import { createLearningEvolutionOrchestrator } from "./learning-evolution-orchestrator.mjs";
import { createSkillRegistry } from "./skill-registry.mjs";
import { createTrajectoryStore } from "./trajectory-store.mjs";

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
  const replay = options.trajectoryStore || createTrajectoryStore(options.learning || {});
  const skillRegistry = options.skillRegistry || createSkillRegistry(options.learning || {});
  const curriculum = options.curriculumController || createCurriculumController(curriculumOptions(options.learning || {}));
  const baseGenerator = options.generateVariants || createRunnerCodexVariantGenerator({
    host: options.host || "127.0.0.1",
    codexPort: Number(options.codexPort || process.env.CODEX_RUNNER_PORT || 8787),
    token: options.token ?? process.env.CODEX_RUNNER_TOKEN?.trim() ?? null,
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
    if (!plan.task) return baseGenerator(input);
    const generated = await baseGenerator({
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

  async function learningStatus() {
    const [base, curriculumStatus] = await Promise.all([core.learningStatus(), curriculum.status()]);
    return { ...base, curriculum: curriculumStatus };
  }

  async function enrichSnapshot(snapshot) {
    if (!snapshot) return snapshot;
    const curriculumStatus = await curriculum.status();
    return {
      ...snapshot,
      learning: {
        ...(isRecord(snapshot.learning) ? snapshot.learning : await core.learningStatus()),
        curriculum: curriculumStatus,
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
  };
}
