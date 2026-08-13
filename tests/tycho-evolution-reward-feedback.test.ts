import { describe, expect, it } from "vitest";
import {
  runEvolutionLoop,
  type EvolutionEvaluation,
  type EvolutionVariantGenerator,
} from "../lib/tycho-evolution-loop";

type Spec = { value: number };

describe("tycho evolution reward feedback", () => {
  it("passes null for the seed and the winning evaluation into the next generation", async () => {
    const observed: Array<EvolutionEvaluation | null> = [];
    const generator: EvolutionVariantGenerator<Spec, undefined> = {
      generate: async ({ generation, parent, parentEvaluation }) => {
        observed.push(parentEvaluation);
        return generation === 1
          ? [
              { id: "first-low", spec: { value: 1 } },
              { id: "first-winner", spec: { value: 3 } },
            ]
          : [
              { id: "second-a", spec: { value: parent.spec.value + 1 } },
              { id: "second-b", spec: { value: parent.spec.value + 2 } },
            ];
      },
    };

    const result = await runEvolutionLoop({
      context: undefined,
      generations: 2,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: generator,
      executionBackend: {
        execute: async ({ candidate }) => ({ value: candidate.spec.value }),
      },
      evaluator: {
        evaluate: async ({ candidate, execution }) => ({
          score: execution.value,
          metrics: { observedValue: execution.value },
          evidence: { candidateId: candidate.id },
        }),
      },
    });

    expect(result.status).toBe("completed");
    expect(observed[0]).toBeNull();
    expect(observed[1]).toEqual({
      score: 3,
      metrics: { observedValue: 3 },
      evidence: { candidateId: "first-winner" },
    });
  });
});