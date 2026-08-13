import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPolicyController, derivePolicyState } from "./policy-controller.mjs";

test("policy selection is deterministic for the same state and seed", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m3-policy-"));
  const policy = createPolicyController({ rootDir, mode: "online", epsilon: 0.5 });
  try {
    const state = derivePolicyState(null);
    const first = await policy.select({ state, seedKey: "same-seed" });
    const second = await policy.select({ state, seedKey: "same-seed" });
    assert.equal(first.action.id, second.action.id);
    assert.equal(first.mode, second.mode);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("online q update is persistent and idempotent by transition id", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m3-policy-update-"));
  try {
    const policy = createPolicyController({ rootDir, mode: "online", epsilon: 0, alpha: 0.5, gamma: 0 });
    const state = derivePolicyState(null);
    const selected = await policy.select({ state, seedKey: "seed" });
    const nextState = { decision: "promote", passBand: "high", blockedBand: "none", speedBand: "fast" };
    const first = await policy.update({ transitionId: "transition-1", stateKey: selected.stateKey, actionId: selected.action.id, reward: 1, nextState });
    const duplicate = await policy.update({ transitionId: "transition-1", stateKey: selected.stateKey, actionId: selected.action.id, reward: 0, nextState });
    assert.equal(first.updated, true);
    assert.equal(duplicate.updated, false);
    assert.equal(duplicate.duplicate, true);
    const status = await policy.status();
    assert.equal(status.appliedTransitionCount, 1);
    assert.equal(status.policyVersion, "q1");

    const reloaded = createPolicyController({ rootDir, mode: "online", epsilon: 0, alpha: 0.5, gamma: 0 });
    const reloadedStatus = await reloaded.status();
    assert.equal(reloadedStatus.appliedTransitionCount, 1);
    assert.equal(reloadedStatus.policyVersion, "q1");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
