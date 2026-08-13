import { createHash } from "node:crypto";

import { createRunnerCodexVariantGenerator } from "./codex-evolution-generator.mjs";
import { createDurableEvolutionOrchestrator } from "./evolution-orchestrator.mjs";
import { buildLearningRewardFromEvaluation } from "./learning-reward.mjs";
import { createPolicyController, derivePolicyState } from "./policy-controller.mjs";
import { createTrajectoryStore, stableSpecHash } from "./trajectory-store.mjs";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function evaluationFromAttempt(attempt) {
  return {
    score: Number.isFinite(attempt?.score) ? attempt.score : 0,
    metrics: isRecord(attempt?.metrics) ? attempt.metrics : {},
    evidence: isRecord(attempt?.evidence) ? attempt.evidence : {},
  };
}

function failureState() {
  return { decision: "execution_failed", passBand: "low", blockedBand: "high", speedBand: "unknown" };
}

function nextStateFromAttempt(attempt) {
  return attempt?.status === "succeeded" ? derivePolicyState(evaluationFromAttempt(attempt)) : failureState();
}

function policyMetaFromAttempt(attempt) {
  return isRecord(attempt?.metadata?.learningPolicy) ? attempt.metadata.learningPolicy : null;
}

function replayGuidance(trajectories) {
  return trajectories.map((item) => ({
    actionId: item.actionId,
    reward: item.reward,
    decision: item.decision,
    isWinner: item.isWinner,
    hypothesis: typeof item.candidateMetadata?.hypothesis === "string" ? item.candidateMetadata.hypothesis : null,
    rationale: typeof item.candidateMetadata?.rationale === "string" ? item.candidateMetadata.rationale : null,
  }));
}

export function createLearningEvolutionOrchestrator(options = {}) {
  const policy = options.policyController || createPolicyController(options.learning || {});
  const replay = options.trajectoryStore || createTrajectoryStore(options.learning || {});
  const baseGenerator = options.generateVariants || createRunnerCodexVariantGenerator({
    host: options.host || "127.0.0.1",
    codexPort: Number(options.codexPort || process.env.CODEX_RUNNER_PORT || 8787),
    token: options.token ?? process.env.CODEX_RUNNER_TOKEN?.trim() ?? null,
  });
  const knownRuns = new Map();

  async function updatePreviousWinner(input, state) {
    if (policy.mode !== "online" || !isRecord(input.parentEvaluation)) return;
    const previous = isRecord(input.parent?.metadata?.learningPolicy) ? input.parent.metadata.learningPolicy : null;
    if (!previous?.decisionId || !previous?.stateKey || !previous?.actionId) return;
    const reward = buildLearningRewardFromEvaluation(input.parentEvaluation);
    await policy.update({
      transitionId: `online:${previous.decisionId}`,
      stateKey: previous.stateKey,
      actionId: previous.actionId,
      reward: reward.reward,
      nextState: state,
    });
  }

  async function learningGenerator(input) {
    if (policy.mode === "off") return baseGenerator(input);
    const state = derivePolicyState(input.parentEvaluation);
    await updatePreviousWinner(input, state);
    const selected = await policy.select({
      state,
      seedKey: `${input.sessionId}|${input.workspaceId}|${input.generation}|${input.parent?.key || "seed"}`,
    });
    const decisionId = digest(`${input.sessionId}|${input.workspaceId}|${input.generation}|${selected.stateKey}|${selected.action.id}|${selected.policyVersion}`);
    const examples = await replay.top({ workspaceId: input.workspaceId, stateKey: selected.stateKey }, 3);
    const parentEvaluation = isRecord(input.parentEvaluation)
      ? { ...input.parentEvaluation, evidence: { ...(isRecord(input.parentEvaluation.evidence) ? input.parentEvaluation.evidence : {}), learningPolicy: {
        decisionId,
        actionId: selected.action.id,
        directive: selected.action.directive,
        stateKey: selected.stateKey,
        policyVersion: selected.policyVersion,
        replay: replayGuidance(examples),
      } } }
      : { score: 0, metrics: {}, evidence: { learningPolicy: {
        decisionId,
        actionId: selected.action.id,
        directive: selected.action.directive,
        stateKey: selected.stateKey,
        policyVersion: selected.policyVersion,
        replay: replayGuidance(examples),
      } } };
    const generated = await baseGenerator({ ...input, parentEvaluation });
    return {
      ...generated,
      variants: generated.variants.map((variant) => ({
        ...variant,
        metadata: {
          ...(isRecord(variant.metadata) ? variant.metadata : {}),
          learningPolicy: {
            decisionId,
            actionId: selected.action.id,
            actionMode: selected.mode,
            directive: selected.action.directive,
            state: selected.state,
            stateKey: selected.stateKey,
            policyVersion: selected.policyVersion,
            qValue: selected.qValue,
            epsilon: selected.epsilon,
          },
        },
      })),
    };
  }

  const durable = createDurableEvolutionOrchestrator({ ...options, generateVariants: learningGenerator });

  async function captureGeneration(snapshot, generation) {
    const attempts = Array.isArray(generation.attempts) ? generation.attempts : [];
    const winner = attempts.find((attempt) => attempt.isWinner) || attempts.find((attempt) => attempt.candidateKey === generation.winnerKey) || null;
    for (const attempt of attempts) {
      const meta = policyMetaFromAttempt(attempt);
      if (!meta?.decisionId || !meta?.stateKey || !meta?.actionId || !isRecord(meta.state)) continue;
      const evaluation = evaluationFromAttempt(attempt);
      const reward = attempt.status === "succeeded" ? buildLearningRewardFromEvaluation(evaluation) : { reward: 0, components: {} };
      const nextState = nextStateFromAttempt(attempt);
      await replay.append({
        trajectoryId: digest(`${snapshot.runId}|${attempt.candidateKey}|${meta.decisionId}`),
        runId: snapshot.runId,
        sessionId: snapshot.sessionId,
        projectId: snapshot.projectId,
        workspaceId: snapshot.workspaceId,
        episodeIndex: snapshot.episodeIndex,
        generation: generation.generation,
        stateKey: meta.stateKey,
        state: meta.state,
        actionId: meta.actionId,
        actionMode: meta.actionMode,
        policyVersion: meta.policyVersion,
        candidateId: attempt.candidateId,
        candidateKey: attempt.candidateKey,
        parentKey: attempt.parentKey,
        experimentId: attempt.experimentId,
        candidateSpecHash: stableSpecHash({ experimentId: attempt.experimentId, metadata: attempt.metadata }),
        candidateMetadata: isRecord(attempt.metadata) ? attempt.metadata : {},
        status: attempt.status,
        decision: attempt.decision,
        score: attempt.score,
        reward: reward.reward,
        rewardComponents: reward.components,
        metrics: evaluation.metrics,
        evidence: evaluation.evidence,
        nextState,
        isWinner: attempt === winner,
      });
    }
    if (policy.mode === "online" && winner) {
      const meta = policyMetaFromAttempt(winner);
      if (meta?.decisionId && meta?.stateKey && meta?.actionId) {
        const reward = winner.status === "succeeded" ? buildLearningRewardFromEvaluation(evaluationFromAttempt(winner)).reward : 0;
        await policy.update({
          transitionId: `online:${meta.decisionId}`,
          stateKey: meta.stateKey,
          actionId: meta.actionId,
          reward,
          nextState: nextStateFromAttempt(winner),
        });
      }
    }
  }

  async function captureSnapshot(snapshot) {
    if (!snapshot || policy.mode === "off") return snapshot;
    for (const generation of Array.isArray(snapshot.generations) ? snapshot.generations : []) {
      if (generation?.status === "completed") await captureGeneration(snapshot, generation);
    }
    return { ...snapshot, learning: await learningStatus() };
  }

  async function start(input, ownerId) {
    const snapshot = await durable.start(input, ownerId);
    knownRuns.set(snapshot.runId, ownerId);
    return captureSnapshot(snapshot);
  }

  async function get(runId, ownerId) {
    const snapshot = await durable.get(runId, ownerId);
    if (snapshot) knownRuns.set(runId, ownerId);
    return captureSnapshot(snapshot);
  }

  async function cancel(runId, ownerId) {
    const snapshot = await durable.cancel(runId, ownerId);
    if (snapshot) knownRuns.set(runId, ownerId);
    return captureSnapshot(snapshot);
  }

  async function recover() {
    await durable.recover();
  }

  async function shutdown() {
    for (const [runId, ownerId] of knownRuns) {
      const snapshot = await durable.get(runId, ownerId).catch(() => null);
      if (snapshot) await captureSnapshot(snapshot).catch(() => null);
    }
    await durable.shutdown();
  }

  async function learningStatus() {
    const [policyStatus, replayStats] = await Promise.all([policy.status(), replay.stats()]);
    return { policy: policyStatus, replay: replayStats };
  }

  async function trainOffline(input = {}) {
    const trajectories = await replay.list(input.workspaceId ? { workspaceId: input.workspaceId } : {});
    const result = await policy.trainOffline(trajectories, { reset: input.reset === true });
    return { ...result, replay: await replay.stats(input.workspaceId ? { workspaceId: input.workspaceId } : {}) };
  }

  return {
    ...durable,
    start,
    get,
    cancel,
    recover,
    shutdown,
    learningStatus,
    trainOffline,
    replayStats: (filter = {}) => replay.stats(filter),
  };
}
