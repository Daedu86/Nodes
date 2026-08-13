import { describe, expect, it } from "vitest";
import {
  runEvolutionLoop,
  type EvolutionEvaluation,
  type EvolutionVariantGenerator,
} from "../lib/tycho-evolution-loop";

type Spec = { value: number };
type Execution = { score: number };

describe("Tycho evolution continuation", () => {
  it("continues generation numbering and feeds the champion reward into the next generator call", async () => {
    const generatorCalls: Array<{
      generation: number;
      parentKey: string;
      parentEvaluation: EvolutionEvaluation | null;
    }> = [];
    const variantGenerator: EvolutionVariantGenerator<Spec> = {
      generate: async ({ generation, parent, parentEvaluation }) => {
        generatorCalls.push({ generation, parentKey: parent.key, parentEvaluation });
        return [{ id: `candidate-${generation}`, spec: { value: generation } }];
      },
    };

    const result = await runEvolutionLoop<Spec, Execution>({
      context: undefined,
      generations: 2,
      populationSize: 1,
      seed: { id: "unused-seed", spec: { value: 0 } },
      resumeFrom: {
        candidate: {
          id: "champion",
          spec: { value: 2 },
          generation: 2,
          key: "g2:champion",
          parentKey: "g1:previous",
        },
        evaluation: {
          score: 0.82,
          metrics: { passRatio: 0.9 },
          evidence: { decision: "promote" },
        },
      },
      variantGenerator,
      executionBackend: {
        execute: async ({ generation }) => ({ score: generation }),
      },
      evaluator: {
        evaluate: async ({ execution }) => ({ score: execution.score }),
      },
    });

    expect(result.status).toBe("completed");
    expect(result.seed.key).toBe("g2:champion");
    expect(result.generations.map((generation) => generation.generation)).toEqual([3, 4]);
    expect(result.generations[0]?.parent.key).toBe("g2:champion");
    expect(result.generations[1]?.parent.key).toBe("g3:candidate-3");
    expect(result.finalWinner?.candidate.key).toBe("g4:candidate-4");
    expect(generatorCalls[0]).toMatchObject({
      generation: 3,
      parentKey: "g2:champion",
      parentEvaluation: { score: 0.82, metrics: { passRatio: 0.9 } },
    });
    expect(generatorCalls[1]).toMatchObject({
      generation: 4,
      parentKey: "g3:candidate-3",
      parentEvaluation: { score: 3 },
    });
  });

  it("rejects a resume candidate whose stable key does not match its generation and id", async () => {
    await expect(
      runEvolutionLoop<Spec, Execution>({
        context: undefined,
        generations: 1,
        populationSize: 1,
        seed: { id: "seed", spec: { value: 0 } },
        resumeFrom: {
          candidate: {
            id: "champion",
            spec: { value: 2 },
            generation: 2,
            key: "g1:champion",
            parentKey: "g1:previous",
          },
          evaluation: { score: 1 },
        },
        variantGenerator: { generate: async () => [] },
        executionBackend: { execute: async () => ({ score: 0 }) },
        evaluator: { evaluate: async () => ({ score: 0 }) },
      }),
    ).rejects.toThrow("resumeFrom.candidate.key must equal g2:champion");
  });
});
