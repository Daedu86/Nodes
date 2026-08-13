import type { CodexWorkspaceFile } from "@/lib/agents/codex/types";
import type {
  EvolutionEvaluation,
  EvolutionEvaluator,
  EvolutionExecutionBackend,
} from "@/lib/tycho-evolution-loop";
import {
  cancelTychoEvolutionRun,
  getTychoEvolutionResult,
  getTychoEvolutionRun,
  startTychoEvolutionRun,
  type StartTychoEvolutionRunInput,
  type TychoEvolutionResult,
  type TychoEvolutionRunSnapshot,
} from "@/lib/tycho/evolution-runner-client";

export type TychoEvolutionSpec = {
  experimentId: string;
  protocol: Record<string, unknown>;
  workspaceFiles?: CodexWorkspaceFile[];
};

export type TychoEvolutionContext = {
  ownerId: string;
  workspaceId: string;
  projectId?: string | null;
  sessionId?: string | null;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

export type TychoEvolutionExecution = {
  run: TychoEvolutionRunSnapshot;
  result: TychoEvolutionResult;
};

type RunnerDependencies = {
  start: (input: StartTychoEvolutionRunInput) => Promise<TychoEvolutionRunSnapshot>;
  getRun: (ownerId: string, runId: string) => Promise<TychoEvolutionRunSnapshot>;
  getResult: (
    ownerId: string,
    runId: string,
  ) => Promise<{ run: TychoEvolutionRunSnapshot; result: TychoEvolutionResult }>;
  cancel: (ownerId: string, runId: string) => Promise<TychoEvolutionRunSnapshot>;
  sleep: (ms: number) => Promise<void>;
};

const defaultDependencies: RunnerDependencies = {
  start: startTychoEvolutionRun,
  getRun: getTychoEvolutionRun,
  getResult: getTychoEvolutionResult,
  cancel: cancelTychoEvolutionRun,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const positiveDuration = (value: number | undefined, fallback: number, label: string) => {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive finite number.`);
  }
  return resolved;
};

function buildWorkspaceFiles(spec: TychoEvolutionSpec) {
  const experimentId = spec.experimentId.trim();
  if (!experimentId) throw new Error("Tycho evolution spec experimentId must not be empty.");
  if (!spec.protocol || typeof spec.protocol !== "object" || Array.isArray(spec.protocol)) {
    throw new Error("Tycho evolution spec protocol must be an object.");
  }
  if (spec.protocol.schemaVersion !== 1) {
    throw new Error("Tycho evolution protocol schemaVersion must equal 1.");
  }
  if (spec.protocol.experimentId !== experimentId) {
    throw new Error("Tycho evolution protocol experimentId must match spec.experimentId.");
  }

  const extraFiles = spec.workspaceFiles ?? [];
  if (extraFiles.some((file) => file.path.replaceAll("\\", "/") === ".nodes/tycho-experiment.json")) {
    throw new Error("workspaceFiles must not override .nodes/tycho-experiment.json.");
  }

  return [
    {
      path: ".nodes/tycho-experiment.json",
      content: `${JSON.stringify(spec.protocol, null, 2)}\n`,
      mimeType: "application/json",
    },
    ...extraFiles,
  ] satisfies CodexWorkspaceFile[];
}

export function createTychoEvolutionExecutionBackend(
  dependencies: RunnerDependencies = defaultDependencies,
): EvolutionExecutionBackend<TychoEvolutionSpec, TychoEvolutionExecution, TychoEvolutionContext> {
  return {
    execute: async ({ candidate, context }) => {
      const pollIntervalMs = positiveDuration(context.pollIntervalMs, 250, "pollIntervalMs");
      const timeoutMs = positiveDuration(context.timeoutMs, 20 * 60_000, "timeoutMs");
      const workspaceFiles = buildWorkspaceFiles(candidate.spec);
      const startedAt = Date.now();

      const started = await dependencies.start({
        ownerId: context.ownerId,
        workspaceId: context.workspaceId,
        projectId: context.projectId ?? null,
        sessionId: context.sessionId ?? null,
        candidateKey: candidate.key,
        experimentId: candidate.spec.experimentId,
        workspaceFiles,
      });

      let snapshot = started;
      while (snapshot.status === "running") {
        if (Date.now() - startedAt >= timeoutMs) {
          await dependencies.cancel(context.ownerId, started.runId).catch(() => null);
          throw new Error(`Tycho evolution run timed out: ${started.runId}`);
        }
        await dependencies.sleep(pollIntervalMs);
        snapshot = await dependencies.getRun(context.ownerId, started.runId);
      }

      if (snapshot.status !== "completed") {
        throw new Error(
          `Tycho evolution run ${snapshot.status}: ${snapshot.error ?? started.runId}`,
        );
      }

      const completed = await dependencies.getResult(context.ownerId, started.runId);
      if (completed.result.experimentId !== candidate.spec.experimentId) {
        throw new Error("Tycho evolution result identity does not match the candidate spec.");
      }
      return completed;
    },
  };
}

export function evaluateTychoPromotionResult(result: TychoEvolutionResult): EvolutionEvaluation {
  const summary = result.summary;
  const passRatio = summary.stepCount > 0 ? summary.passedSteps / summary.stepCount : 0;
  const decisionBase = result.decision === "promote" ? 2 : result.decision === "reject" ? 1 : 0;
  const score = decisionBase + Math.min(1, Math.max(0, passRatio)) * 0.5;
  const wallSeconds = typeof result.budget?.wallSeconds === "number" ? result.budget.wallSeconds : 0;

  return {
    score,
    metrics: {
      passRatio,
      passedSteps: summary.passedSteps,
      failedSteps: summary.failedSteps,
      blockedSteps: summary.blockedSteps,
      wallSeconds,
    },
    evidence: {
      experimentId: result.experimentId,
      decision: result.decision,
      sandbox: result.sandbox,
      summary: result.summary,
      metadata: result.metadata ?? {},
    },
  };
}

export const tychoPromotionEvaluator: EvolutionEvaluator<
  TychoEvolutionSpec,
  TychoEvolutionExecution,
  TychoEvolutionContext
> = {
  evaluate: async ({ candidate, execution }) => {
    const evaluation = evaluateTychoPromotionResult(execution.result);
    return {
      ...evaluation,
      evidence: {
        ...(evaluation.evidence ?? {}),
        candidateMetadata: candidate.metadata ?? {},
      },
    };
  },
};
