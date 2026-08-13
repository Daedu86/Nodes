import assert from "node:assert/strict";
import test from "node:test";

import { createModelBasedPlanner } from "./model-based-planner.mjs";

function trajectory(id, stateKey, actionId, reward, nextState) {
  return {
    trajectoryId: id,
    workspaceId: "workspace-m8",
    stateKey,
    actionId,
    reward,
    nextState,
  };
}

const stateA = "decision=promote|passBand=high|blockedBand=low|speedBand=fast";
const stateB = "decision=reject|passBand=mid|blockedBand=low|speedBand=fast";
const stateC = "decision=promote|passBand=high|blockedBand=low|speedBand=fast";
const promoted = { decision: "promote", passBand: "high", blockedBand: "low", speedBand: "fast" };
const rejected = { decision: "reject", passBand: "mid", blockedBand: "low", speedBand: "fast" };

function store(values) {
  return { list: async (filter = {}) => values.filter((item) => !filter.workspaceId || item.workspaceId === filter.workspaceId) };
}

test("M8 prefers a lower immediate reward when its predicted state has stronger long-horizon value", async () => {
  const replay = store([
    trajectory("a1", stateA, "exploit", 0.55, promoted),
    trajectory("a2", stateA, "exploit", 0.58, promoted),
    trajectory("a3", stateA, "repair", 0.50, rejected),
    trajectory("b1", stateB, "diversify", 0.94, promoted),
    trajectory("b2", stateB, "diversify", 0.91, promoted),
    trajectory("b3", stateB, "diversify", 0.93, promoted),
  ]);
  const planner = createModelBasedPlanner({ trajectoryStore: replay, mode: "online", maxDepth: 3, gamma: 0.9, minConfidence: 0.2, minSupport: 2, uncertaintyPenalty: 0 });
  const [shortHigh, longHigh] = await planner.planBatch({
    workspaceId: "workspace-m8",
    predictions: [
      { variant: { id: "short" }, prediction: { expectedReward: 0.80, confidence: 0.9, uncertainty: 0.1, likelyNextState: { stateKey: stateA, probability: 0.9 } } },
      { variant: { id: "long" }, prediction: { expectedReward: 0.68, confidence: 0.9, uncertainty: 0.1, likelyNextState: { stateKey: stateB, probability: 0.9 } } },
    ],
  });
  assert.ok(longHigh.plan.expectedReturn > shortHigh.plan.expectedReturn);
  assert.equal(longHigh.plan.path[0].actionId, "diversify");
  assert.ok(longHigh.plan.depthReached >= 2);
});

test("M8 stops at one real step when M7 confidence is below the planning threshold", async () => {
  const planner = createModelBasedPlanner({ trajectoryStore: store([]), mode: "online", minConfidence: 0.6 });
  const plan = await planner.planPrediction({
    workspaceId: "workspace-m8",
    prediction: { expectedReward: 0.72, confidence: 0.3, uncertainty: 0.7, likelyNextState: { stateKey: stateC, probability: 0.4 } },
  });
  assert.equal(plan.depthReached, 1);
  assert.equal(plan.stopReason, "low-confidence");
  assert.deepEqual(plan.path, []);
});

test("M8 planner remains disabled without changing the M7 one-step prediction", async () => {
  const planner = createModelBasedPlanner({ trajectoryStore: store([]), mode: "off" });
  const plan = await planner.planPrediction({ prediction: { expectedReward: 0.64, confidence: 0.8, uncertainty: 0.2, likelyNextState: { stateKey: stateA } } });
  assert.equal(plan.mode, "off");
  assert.equal(plan.expectedReturn, 0.64);
  assert.equal(plan.stopReason, "disabled");
});
