import { describe, expect, it, vi } from "vitest";
import { runEvolutionLoop } from "../lib/tycho-evolution-loop";
import {
  createTychoEvolutionExecutionBackend,
  evaluateTychoPromotionResult,
  tychoPromotionEvaluator,
  type TychoEvolutionSpec,
} from "../lib/tycho/evolution-backend";
import type {
  StartTychoEvolutionRunInput,
  TychoEvolutionResult,
  TychoEvolutionRunSnapshot,
} from "../lib/tycho/evolution-runner-client";

const snapshot = (
  experimentId: string,
  status: TychoEvolutionRunSnapshot["status"],
): TychoEvolutionRunSnapshot => ({
  runId: `run-${experimentId}`,
  workspaceId: "project-1",
  projectId: "project-1",
  sessionId: "session-1",
  candidateKey: `g1:${experimentId}`,
  experimentId,
  status,
  exitCode: status === "completed" ? 0 : null,
  error: null,
  createdAt: "2026-08-13T06:00:00.000Z",
  finishedAt: status === "completed" ? "2026-08-13T06:00:01.000Z" : null,
});

const result = (
  experimentId: string,
  decision: TychoEvolutionResult["decision"],
  passedSteps: number,
): TychoEvolutionResult => ({
  schemaVersion: 1,
  experimentId,
  decision,
  sandbox: { runtime: "docker", image: "tycho-sandbox" },
  budget: { wallSeconds: 1 },
  summary: {
    stepCount: 2,
    executedSteps: 2,
    passedSteps,
    failedSteps: decision === "reject" ? 2 - passedSteps : 0,
    blockedSteps: decision === "blocked" ? 2 - passedSteps : 0,
  },
  steps: [{}, {}],
});

const spec = (experimentId: string): TychoEvolutionSpec => ({
  experimentId,
  protocol: {
    schemaVersion: 1,
    experimentId,
    objective: `Evaluate ${experimentId}`,
  },
  workspaceFiles: [
    { path: `.nodes/${experimentId}.py`, content: "print('candidate')\n" },
  ],
});

describe("Tycho evolution backend", () => {
  it("runs M1 candidates through the local runner and selects the promoted result", async () => {
    const starts: StartTychoEvolutionRunInput[] = [];
    const start = vi.fn(async (input: StartTychoEvolutionRunInput) => {
      starts.push(input);
      return snapshot(input.experimentId, "running");
    });
    const backend = createTychoEvolutionExecutionBackend({
      start,
      getRun: async (_ownerId, runId) => snapshot(runId.replace("run-", ""), "completed"),
      getResult: async (_ownerId, runId) => {
        const experimentId = runId.replace("run-", "");
        const promoted = experimentId === "candidate-b";
        return {
          run: snapshot(experimentId, "completed"),
          result: result(experimentId, promoted ? "promote" : "reject", promoted ? 2 : 1),
        };
      },
      cancel: async (_ownerId, runId) => snapshot(runId.replace("run-", ""), "cancelled"),
      sleep: async () => {},
    });

    const evolution = await runEvolutionLoop({
      context: {
        ownerId: "owner-1",
        workspaceId: "project-1",
        projectId: "project-1",
        sessionId: "session-1",
        pollIntervalMs: 1,
      },
      evaluator: tychoPromotionEvaluator,
      executionBackend: backend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: spec("seed") },
      variantGenerator: {
        generate: async () => [
          { id: "candidate-a", spec: spec("candidate-a") },
          { id: "candidate-b", spec: spec("candidate-b") },
        ],
      },
    });

    expect(evolution.status).toBe("completed");
    if (evolution.status !== "completed") throw new Error(evolution.reason);
    expect(evolution.finalWinner.candidate.id).toBe("candidate-b");
    expect(start).toHaveBeenCalledTimes(2);
    expect(starts[0]?.workspaceFiles[0]).toMatchObject({
      path: ".nodes/tycho-experiment.json",
    });
  });

  it("ranks promotion above rejection and blocked outcomes", () => {
    const promoted = evaluateTychoPromotionResult(result("p", "promote", 1));
    const rejected = evaluateTychoPromotionResult(result("r", "reject", 2));
    const blocked = evaluateTychoPromotionResult(result("b", "blocked", 2));
    expect(promoted.score).toBeGreaterThan(rejected.score);
    expect(rejected.score).toBeGreaterThan(blocked.score);
  });
});
