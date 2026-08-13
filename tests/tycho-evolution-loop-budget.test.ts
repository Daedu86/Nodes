import { describe, expect, it, vi } from "vitest";
import {
  runEvolutionLoop,
  type EvolutionEvaluator,
  type EvolutionExecutionBackend,
} from "../lib/tycho-evolution-loop";

type Spec = { value: number };
type Execution = { observed: number };
type Context = undefined;

describe("tycho evolution population budget", () => {
  it("fails closed before execution when a generator exceeds populationSize", async () => {
    const execute = vi.fn(async ({ candidate }: { candidate: { spec: Spec } }) => ({
      observed: candidate.spec.value,
    }));
    const executionBackend: EvolutionExecutionBackend<Spec, Execution, Context> = { execute };
    const evaluator: EvolutionEvaluator<Spec, Execution, Context> = {
      evaluate: async ({ execution }) => ({ score: execution.observed }),
    };

    const result = await runEvolutionLoop({
      context: undefined,
      evaluator,
      executionBackend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: {
        generate: async () => [
          { id: "candidate-a", spec: { value: 1 } },
          { id: "candidate-b", spec: { value: 2 } },
          { id: "candidate-c", spec: { value: 3 } },
        ],
      },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed result");

    expect(result.reason).toContain("produced 3 variants, exceeding populationSize 2");
    expect(result.generations[0]).toMatchObject({
      attempts: [],
      generation: 1,
      requestedPopulation: 2,
      status: "failed",
      winner: null,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
