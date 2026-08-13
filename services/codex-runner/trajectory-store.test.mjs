import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTrajectoryStore, stableSpecHash } from "./trajectory-store.mjs";

test("trajectory store persists and ranks replay evidence", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m3-replay-"));
  const store = createTrajectoryStore({ rootDir });
  try {
    const base = {
      runId: "run-1",
      sessionId: "session-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
      episodeIndex: 1,
      generation: 1,
      stateKey: "state-a",
      state: { decision: "none", passBand: "unknown", blockedBand: "unknown", speedBand: "unknown" },
      actionId: "exploit",
      actionMode: "exploit",
      policyVersion: "q0",
      parentKey: "g0:seed",
      candidateSpecHash: stableSpecHash({ hello: "world" }),
      status: "succeeded",
      decision: "promote",
      score: 2.5,
      rewardComponents: { correctness: 1 },
      metrics: { passRatio: 1 },
      evidence: { decision: "promote" },
      nextState: { decision: "promote", passBand: "high", blockedBand: "none", speedBand: "fast" },
    };
    await store.append({ ...base, trajectoryId: "t-low", candidateId: "a", candidateKey: "g1:a", experimentId: "exp-a", reward: 0.4, isWinner: false });
    await store.append({ ...base, trajectoryId: "t-high", candidateId: "b", candidateKey: "g1:b", experimentId: "exp-b", reward: 0.9, isWinner: true });
    const top = await store.top({ workspaceId: "workspace-1", stateKey: "state-a" }, 1);
    assert.equal(top.length, 1);
    assert.equal(top[0].trajectoryId, "t-high");
    const stats = await store.stats({ workspaceId: "workspace-1" });
    assert.equal(stats.count, 2);
    assert.equal(stats.winners, 1);
    assert.equal(stats.byAction.exploit.count, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
