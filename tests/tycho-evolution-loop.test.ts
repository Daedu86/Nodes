import { describe, expect, it } from "vitest";
import {
  runEvolutionLoop,
  type EvolutionEvaluator,
  type EvolutionExecutionBackend,
  type EvolutionVariantGenerator,
} from "../lib/tycho-evolution-loop";

type Spec = { value: number };
type Execution = { observed: number };
type Context = { offset: number };

const backend: EvolutionExecutionBackend<Spec, Execution, Context> = {
  execute: async ({ candidate, context }) => ({
    observed: candidate.spec.value + context.offset,
  }),
};

const evaluator: EvolutionEvaluator<Spec, Execution, Context> = {
  evaluate: async ({ execution }) => ({ score: execution.observed }),
};

const makeGenerator = (
  generate: EvolutionVariantGenerator<Spec, Context>["generate"],
): EvolutionVariantGenerator<Spec, Context> => ({ generate });

describe("tycho evolution loop", () => {
  it("selects the highest evaluated score as the generation winner", async () => {
    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: backend,
      generations: 1,
      populationSize: 3,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "candidate-a", spec: { value: 0.4 } },
        { id: "candidate-b", spec: { value: 0.9 } },
        { id: "candidate-c", spec: { value: 0.6 } },
      ]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(result.finalWinner.candidate.id).toBe("candidate-b");
    expect(result.finalWinner.evaluation?.score).toBe(0.9);
    expect(result.generations[0]?.attempts).toHaveLength(3);
  });

  it("breaks equal-score ties deterministically by generator order", async () => {
    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: backend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "first", spec: { value: 1 } },
        { id: "second", spec: { value: 1 } },
      ]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(result.finalWinner.candidate.id).toBe("first");
    expect(result.finalWinner.index).toBe(0);
  });

  it("isolates a failed candidate and still promotes a successful winner", async () => {
    const flakyBackend: EvolutionExecutionBackend<Spec, Execution, Context> = {
      execute: async ({ candidate }) => {
        if (candidate.id === "broken") throw new Error("runner unavailable");
        return { observed: candidate.spec.value };
      },
    };

    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: flakyBackend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "broken", spec: { value: 100 } },
        { id: "healthy", spec: { value: 0.7 } },
      ]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(result.finalWinner.candidate.id).toBe("healthy");
    expect(result.generations[0]?.attempts[0]).toMatchObject({
      error: { message: "runner unavailable", stage: "execution" },
      status: "failed",
    });
  });

  it("returns an explicit failed generation when every candidate fails", async () => {
    const failedBackend: EvolutionExecutionBackend<Spec, Execution, Context> = {
      execute: async () => {
        throw new Error("runtime failed");
      },
    };

    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: failedBackend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "candidate-a", spec: { value: 1 } },
        { id: "candidate-b", spec: { value: 2 } },
      ]),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed result");
    expect(result.finalWinner).toBeNull();
    expect(result.reason).toContain("no successfully evaluated candidates");
    expect(result.generations[0]).toMatchObject({
      generation: 1,
      status: "failed",
      winner: null,
    });
    expect(result.generations[0]?.attempts).toHaveLength(2);
  });

  it("uses the previous winner as the parent of the next generation", async () => {
    const parentIds: string[] = [];
    const generator = makeGenerator(async ({ generation, parent }) => {
      parentIds.push(parent.id);
      if (generation === 1) {
        return [
          { id: "g1-low", spec: { value: 1 } },
          { id: "g1-winner", spec: { value: 3 } },
        ];
      }
      return [
        { id: "g2-winner", spec: { value: parent.spec.value + 2 } },
        { id: "g2-low", spec: { value: parent.spec.value - 1 } },
      ];
    });

    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: backend,
      generations: 2,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: generator,
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(parentIds).toEqual(["seed", "g1-winner"]);
    expect(result.generations[1]?.parent.id).toBe("g1-winner");
    expect(result.finalWinner.candidate.id).toBe("g2-winner");
    expect(result.finalWinner.candidate.parentKey).toBe("g1:g1-winner");
  });

  it("captures evaluator failures without aborting sibling evaluations", async () => {
    const flakyEvaluator: EvolutionEvaluator<Spec, Execution, Context> = {
      evaluate: async ({ candidate, execution }) => {
        if (candidate.id === "bad-score") throw new Error("invalid benchmark evidence");
        return { score: execution.observed };
      },
    };

    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator: flakyEvaluator,
      executionBackend: backend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "bad-score", spec: { value: 5 } },
        { id: "valid-score", spec: { value: 2 } },
      ]),
    });

    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error(result.reason);
    expect(result.finalWinner.candidate.id).toBe("valid-score");
    expect(result.generations[0]?.attempts[0]?.error).toEqual({
      message: "invalid benchmark evidence",
      stage: "evaluation",
    });
  });

  it("rejects duplicate variant ids because they make provenance ambiguous", async () => {
    const result = await runEvolutionLoop({
      context: { offset: 0 },
      evaluator,
      executionBackend: backend,
      generations: 1,
      populationSize: 2,
      seed: { id: "seed", spec: { value: 0 } },
      variantGenerator: makeGenerator(async () => [
        { id: "same", spec: { value: 1 } },
        { id: "same", spec: { value: 2 } },
      ]),
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("Expected failed result");
    expect(result.reason).toContain("duplicate variant ids: same");
    expect(result.generations[0]?.attempts).toEqual([]);
  });
});
