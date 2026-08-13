import assert from "node:assert/strict";
import test from "node:test";

import { createWorldModelVariantGenerator } from "./world-model-variant-generator.mjs";

function baseGenerator() {
  return async (input) => ({
    generatorRunId: `gen-${input.count}`,
    variants: Array.from({ length: input.count }, (_, index) => ({
      id: `candidate-${index + 1}`,
      spec: { experimentId: `exp-${index + 1}`, protocol: { schemaVersion: 1, experimentId: `exp-${index + 1}` } },
      metadata: { hypothesis: `hypothesis-${index + 1}` },
    })),
  });
}

test("M7 online expands logical proposals but returns only the requested Tycho population", async () => {
  const generator = createWorldModelVariantGenerator({
    baseGenerator: baseGenerator(),
    mode: "online",
    expansionFactor: 2,
    explorationWeight: 0,
    costWeight: 0,
    worldModel: {
      predictBatch: async ({ variants }) => variants.map((variant, index) => ({
        variant,
        prediction: {
          schemaVersion: 1,
          modelVersion: "test",
          expectedReward: [0.1, 0.9, 0.7, 0.2][index],
          uncertainty: 0.1,
          confidence: 0.9,
          support: 5,
          expectedWallSeconds: 1,
          likelyNextState: null,
          coldStart: false,
        },
      })),
      report: async () => ({ ready: true }),
    },
  });
  const result = await generator.generate({ count: 2, workspaceId: "w" });
  assert.equal(result.variants.length, 2);
  assert.deepEqual(result.variants.map((variant) => variant.id), ["candidate-2", "candidate-3"]);
  assert.equal(result.worldModelPlan.predictedPoolSize, 4);
  assert.equal(result.worldModelPlan.estimatedTychoJobsAvoided, 2);
  assert.equal(result.variants[0].metadata.worldModelPrediction.rank, 1);
});

test("M7 observe annotates predictions without expanding or changing candidate identity", async () => {
  const generator = createWorldModelVariantGenerator({
    baseGenerator: baseGenerator(),
    mode: "observe",
    worldModel: {
      predictBatch: async ({ variants }) => variants.map((variant) => ({
        variant,
        prediction: {
          schemaVersion: 1,
          modelVersion: "test",
          expectedReward: 0.5,
          uncertainty: 0.5,
          confidence: 0.5,
          support: 1,
          expectedWallSeconds: 0,
          likelyNextState: null,
          coldStart: true,
        },
      })),
      report: async () => ({ ready: false }),
    },
  });
  const result = await generator.generate({ count: 2, workspaceId: "w" });
  assert.deepEqual(result.variants.map((variant) => variant.id), ["candidate-1", "candidate-2"]);
  assert.equal(result.variants[0].metadata.worldModelPrediction.mode, "observe");
  assert.equal(result.variants[0].metadata.worldModelPrediction.predictedPoolSize, 2);
});
