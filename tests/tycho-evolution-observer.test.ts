import { describe, expect, it } from "vitest";
import {
  runEvolutionLoop,
  type EvolutionEvaluator,
  type EvolutionExecutionBackend,
  type EvolutionVariantGenerator,
} from "../lib/tycho-evolution-loop";

type Spec = { value: number };
type Execution = { value: number };

type Context = undefined;

const executionBackend: EvolutionExecutionBackend<Spec, Execution, Context> = {
  execute: async ({ candidate }) => ({ value: candidate.spec.value }),
};

const evaluator: EvolutionEvaluator<Spec, Execution, Context> = {
  evaluate: async ({ execution }) => ({ score: execution.value }),
};

const generator: EvolutionVariantGenerator<Spec, Context> = {
  generate: async ({ generation, parent }) => [
    { id: `g${generation}-a`, spec: { value: parent.spec.value + 1 } },
    { id: `g${generation}-b`, spec: { value: parent.spec.value + 2 } },
  ],
};

describe("evolution observer", () => {
  it("fires once per terminal generation in order with the current winner", async () => {
    const observed: Array<{ generation: number; winner: string | null; count: number }> = [];

    const result = await runEvolutionLoop({
      context: undefined,
      evaluator,
      executionBackend,
      generations: 2,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: generator,
      observer: {
        onGenerationComplete: async ({ generation, generations, latestWinner }) => {
          observed.push({
            generation: generation.generation,
            winner: latestWinner?.candidate.id ?? null,
            count: generations.length,
          });
        },
      },
    });

    expect(result.status).toBe("completed");
    expect(observed).toEqual([
      { generation: 1, winner: "g1-b", count: 1 },
      { generation: 2, winner: "g2-b", count: 2 },
    ]);
  });

  it("fails closed when authoritative generation observation cannot be persisted", async () => {
    let generationCalls = 0;

    await expect(
      runEvolutionLoop({
        context: undefined,
        evaluator,
        executionBackend,
        generations: 2,
        populationSize: 2,
        seed: { id: "seed", spec: { value: 0 } },
        variantGenerator: {
          generate: async ({ generation, parent }) => {
            generationCalls += 1;
            return [
              { id: `g${generation}-a`, spec: { value: parent.spec.value + 1 } },
              { id: `g${generation}-b`, spec: { value: parent.spec.value + 2 } },
            ];
          },
        },
        observer: {
          onGenerationComplete: async () => {
            throw new Error("session persistence unavailable");
          },
        },
      }),
    ).rejects.toThrow("session persistence unavailable");

    expect(generationCalls).toBe(1);
  });
});
