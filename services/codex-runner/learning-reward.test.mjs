import assert from "node:assert/strict";
import test from "node:test";

import { buildLearningReward, buildLearningRewardFromEvaluation } from "./learning-reward.mjs";

test("learning reward prefers promoted passing evidence", () => {
  const strong = buildLearningReward({
    decision: "promote",
    summary: { stepCount: 4, passedSteps: 4, failedSteps: 0, blockedSteps: 0 },
    budget: { wallSeconds: 2 },
  });
  const weak = buildLearningReward({
    decision: "reject",
    summary: { stepCount: 4, passedSteps: 1, failedSteps: 2, blockedSteps: 1 },
    budget: { wallSeconds: 40 },
  });
  assert.ok(strong.reward > weak.reward);
  assert.ok(strong.reward <= 1 && strong.reward >= 0);
  assert.equal(strong.components.correctness, 1);
  assert.equal(strong.components.passRatio, 1);
});

test("persisted evaluation produces the same reward evidence", () => {
  const reward = buildLearningRewardFromEvaluation({
    score: 2.5,
    metrics: { passRatio: 0.75, passedSteps: 3, failedSteps: 1, blockedSteps: 0, wallSeconds: 10 },
    evidence: { decision: "promote", summary: { stepCount: 4, passedSteps: 3, failedSteps: 1, blockedSteps: 0 } },
  });
  assert.equal(reward.evidence.decision, "promote");
  assert.equal(reward.components.passRatio, 0.75);
  assert.ok(reward.reward > 0.7);
});
