import assert from "node:assert/strict";
import test from "node:test";

import { createPredictiveWorldModel } from "./predictive-world-model.mjs";

function trajectory(id, reward, hypothesis, nextDecision = "promote") {
  return {
    trajectoryId: id,
    workspaceId: "workspace-m7",
    stateKey: "decision=none|pass=unknown|blocked=unknown|speed=unknown",
    actionId: "exploit",
    reward,
    metrics: { wallSeconds: reward > 0.7 ? 8 : 40 },
    nextState: { decision: nextDecision, passBand: reward > 0.7 ? "high" : "low", blockedBand: "low", speedBand: "fast" },
    candidateMetadata: {
      hypothesis,
      rationale: hypothesis,
      learningPolicy: { actionId: "exploit", stateKey: "decision=none|pass=unknown|blocked=unknown|speed=unknown" },
      multiAgentTeam: { topologyId: "single" },
    },
  };
}

test("M7 predicts stronger reward and lower cost from similar successful trajectories", async () => {
  const trajectories = [
    trajectory("good-1", 0.92, "preserve passing behavior and regularize grouped features"),
    trajectory("good-2", 0.86, "regularize grouped features while preserving passing behavior"),
    trajectory("bad-1", 0.18, "replace the entire pipeline with unrelated random transforms", "reject"),
  ];
  const model = createPredictiveWorldModel({
    trajectoryStore: { list: async () => trajectories },
    minSupport: 2,
    minSimilarity: 0.1,
  });
  const input = {
    workspaceId: "workspace-m7",
    parentEvaluation: { evidence: { learningPolicy: { actionId: "exploit", stateKey: trajectories[0].stateKey } } },
  };
  const good = await model.predict({ workspaceId: "workspace-m7", input, variant: { metadata: { hypothesis: "regularize grouped features and preserve passing behavior" } } });
  const bad = await model.predict({ workspaceId: "workspace-m7", input, variant: { metadata: { hypothesis: "unrelated random transforms replace the entire pipeline" } } });
  assert.ok(good.expectedReward > bad.expectedReward);
  assert.ok(good.expectedWallSeconds < bad.expectedWallSeconds);
  assert.ok(good.support >= 2);
  assert.equal(good.modelVersion, "empirical-knn-v1");
  assert.match(good.likelyNextState.stateKey, /decision=promote/);
});

test("M7 reports calibration from executed world-model predictions", async () => {
  const trajectories = [
    { ...trajectory("cal-1", 0.8, "stable"), candidateMetadata: { ...trajectory("cal-1", 0.8, "stable").candidateMetadata, worldModelPrediction: { expectedReward: 0.75 } } },
    { ...trajectory("cal-2", 0.4, "unstable"), candidateMetadata: { ...trajectory("cal-2", 0.4, "unstable").candidateMetadata, worldModelPrediction: { expectedReward: 0.5 } } },
  ];
  const model = createPredictiveWorldModel({ trajectoryStore: { list: async () => trajectories }, minSupport: 2 });
  const report = await model.report("workspace-m7");
  assert.equal(report.ready, true);
  assert.equal(report.calibration.observations, 2);
  assert.ok(Math.abs(report.calibration.meanAbsoluteError - 0.075) < 1e-9);
});
