import { describe, expect, it } from "vitest";
import { tychoPromotionEvaluator } from "../lib/tycho/evolution-backend";
import type { EvolutionCandidate } from "../lib/tycho-evolution-loop";
import type {
  TychoEvolutionContext,
  TychoEvolutionExecution,
  TychoEvolutionSpec,
} from "../lib/tycho/evolution-backend";

const candidate: EvolutionCandidate<TychoEvolutionSpec> = {
  id: "candidate-a",
  key: "g1:candidate-a",
  generation: 1,
  parentKey: "g0:seed",
  metadata: {
    generator: "codex",
    generatorRunId: "codex-generator-run-1",
    hypothesis: "target the previous failed verifier",
  },
  spec: {
    experimentId: "candidate-a-experiment",
    protocol: {
      schemaVersion: 1,
      experimentId: "candidate-a-experiment",
    },
  },
};

const execution: TychoEvolutionExecution = {
  run: {
    runId: "tycho-run-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    sessionId: "session-1",
    candidateKey: candidate.key,
    experimentId: candidate.spec.experimentId,
    status: "completed",
    exitCode: 0,
    error: null,
    createdAt: "2026-08-13T07:00:00.000Z",
    finishedAt: "2026-08-13T07:00:01.000Z",
  },
  result: {
    schemaVersion: 1,
    experimentId: candidate.spec.experimentId,
    decision: "promote",
    sandbox: { runtime: "docker", image: "tycho-sandbox" },
    budget: { wallSeconds: 1 },
    summary: {
      stepCount: 1,
      executedSteps: 1,
      passedSteps: 1,
      failedSteps: 0,
      blockedSteps: 0,
    },
    steps: [{}],
  },
};

const context: TychoEvolutionContext = {
  ownerId: "owner-1",
  workspaceId: "workspace-1",
  projectId: "project-1",
  sessionId: "session-1",
};

describe("Tycho evolution provenance", () => {
  it("carries generator metadata into persisted evaluator evidence", async () => {
    const evaluation = await tychoPromotionEvaluator.evaluate({
      candidate,
      context,
      execution,
      generation: 1,
      index: 0,
    });

    expect(evaluation.evidence?.candidateMetadata).toEqual(candidate.metadata);
    expect(evaluation.evidence?.decision).toBe("promote");
  });
});
