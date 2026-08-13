import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTeamPolicyController, teamContextKey } from "./team-policy-controller.mjs";

test("team policy stays single when disabled", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-team-off-"));
  try {
    const policy = createTeamPolicyController({ rootDir, mode: "off" });
    const selected = await policy.select({ stateKey: "s", strategyActionId: "repair", seedKey: "seed" });
    assert.equal(selected.topology.id, "single");
    assert.equal(selected.mode, "off");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("online team policy learns the better topology and deduplicates outcomes", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-team-online-"));
  try {
    const policy = createTeamPolicyController({ rootDir, mode: "online", epsilon: 0, alpha: 1 });
    const contextKey = teamContextKey("state-a", "diversify");
    await policy.update({ outcomeId: "single-1", contextKey, topologyId: "single", reward: 0.1 });
    await policy.update({ outcomeId: "debate-1", contextKey, topologyId: "debate", reward: 0.9 });
    const duplicate = await policy.update({ outcomeId: "debate-1", contextKey, topologyId: "debate", reward: 0 });
    assert.equal(duplicate.duplicate, true);
    const selected = await policy.select({ stateKey: "state-a", strategyActionId: "diversify", seedKey: "seed" });
    assert.equal(selected.topology.id, "debate");
    const status = await policy.status();
    assert.equal(status.appliedOutcomeCount, 2);
    assert.equal(status.teamPolicyVersion, "t2");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
