import assert from "node:assert/strict";
import test from "node:test";

import { createWorldModelVariantGenerator } from "./world-model-variant-generator.mjs";

function baseGenerator() {
  return async (input) => ({
    generatorRunId: `m8-${input.count}`,
    variants: Array.from({ length: input.count }, (_, index) => ({
      id: `candidate-${index + 1}`,
      spec: { experimentId: `m8-exp-${index + 1}`, protocol: { schemaVersion: 1, experimentId: `m8-exp-${index + 1}` } },
      metadata: { hypothesis: `candidate ${index + 1}` },
    })),
  });
}

function worldModel() {
  return {
    predictBatch: async ({ variants }) => variants.map((variant, index) => ({
      variant,
      prediction: {
        expectedReward: index === 0 ? 0.82 : 0.68,
        confidence: 0.9,
        uncertainty: 0.1,
        expectedWallSeconds: 1,
        likelyNextState: { stateKey: index === 0 ? "short" : "long", probability: 0.9 },
      },
    })),
    report: async () => ({ ready: true }),
  };
}

const planner = {
  mode: "online",
  planBatch: async ({ predictions }) => predictions.map((item, index) => ({
    ...item,
    plan: {
      mode: "online",
      expectedReturn: index === 0 ? 0.62 : 0.91,
      planningUtility: index === 0 ? 0.61 : 0.90,
      depthReached: 3,
      confidence: 0.8,
      uncertainty: 0.2,
      path: [],
    },
  })),
  status: async () => ({ mode: "online", ready: true }),
};

test("M8 online can prefer long-horizon value over M7 immediate reward", async () => {
  const generator = createWorldModelVariantGenerator({
    baseGenerator: baseGenerator(),
    worldModel: worldModel(),
    planner,
    plannerMode: "online",
    mode: "online",
    expansionFactor: 2,
    explorationWeight: 0,
    costWeight: 0,
  });
  const result = await generator.generate({ count: 1, workspaceId: "workspace-m8" });
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].id, "candidate-2");
  assert.equal(result.variants[0].metadata.worldModelPrediction.expectedReward, 0.68);
  assert.equal(result.variants[0].metadata.modelBasedPlan.expectedReturn, 0.91);
  assert.equal(result.worldModelPlan.plannerMode, "online");
});

test("M8 observe records plans but preserves M7 one-step ranking", async () => {
  const generator = createWorldModelVariantGenerator({
    baseGenerator: baseGenerator(),
    worldModel: worldModel(),
    planner: { ...planner, mode: "observe" },
    plannerMode: "observe",
    mode: "online",
    expansionFactor: 2,
    explorationWeight: 0,
    costWeight: 0,
  });
  const result = await generator.generate({ count: 1, workspaceId: "workspace-m8" });
  assert.equal(result.variants[0].id, "candidate-1");
  assert.equal(result.variants[0].metadata.modelBasedPlan.expectedReturn, 0.62);
});
