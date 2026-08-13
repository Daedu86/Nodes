import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSkill, skillRef } from "./skill-schema.mjs";
import { createSkillRegistry } from "./skill-registry.mjs";
import { mineSkillCandidates } from "./skill-miner.mjs";
import { createSkillRetriever } from "./skill-retriever.mjs";
import { evaluateSkillValidation } from "./skill-validator.mjs";

function trajectory(id, reward, options = {}) {
  return {
    trajectoryId: id,
    status: "succeeded",
    isWinner: options.isWinner ?? true,
    reward,
    actionId: options.actionId || "repair",
    state: { decision: "reject", passBand: "mid", blockedBand: "some", speedBand: "fast" },
    candidateMetadata: {
      hypothesis: options.hypothesis || `repair mechanism ${id}`,
      rationale: "failed evidence suggests a focused repair",
      multiAgentTeam: { topologyId: options.topologyId || "proposer-critic" },
      ...(options.skillRefs ? { skillContext: { skillRefs: options.skillRefs } } : {}),
    },
  };
}

test("M5 mines a repeatable procedure from successful replay", () => {
  const candidates = mineSkillCandidates([
    trajectory("t1", 0.81), trajectory("t2", 0.84), trajectory("t3", 0.88),
  ], { minSupport: 3, minReward: 0.7 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].status, "candidate");
  assert.match(candidates[0].mechanism, /repair strategy/);
  assert.ok(candidates[0].procedure.length >= 2);
  assert.equal(candidates[0].evidence.support, 3);
});

test("M5 registry persists and retrieves promoted skills", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m5-registry-"));
  try {
    const registry = createSkillRegistry({ rootDir });
    const stored = await registry.upsertCandidate(buildSkill({
      title: "Repair learned procedure",
      domain: "general-evolution",
      mechanism: "repair strategy with proposer-critic team",
      triggers: ["decision=reject", "pass=mid"],
      preconditions: ["strategy=repair", "team=proposer-critic"],
      procedure: ["Target failed evidence first."],
      evidence: { support: 4, meanReward: 0.82 },
    }));
    const promoted = await registry.transition(skillRef(stored), "promoted", { rewardLift: 0.08, validationObservations: 4 });
    const retriever = createSkillRetriever({ skillRegistry: registry, mode: "online", topK: 2, exploration: 0 });
    const result = await retriever.retrieve({
      state: { decision: "reject", passBand: "mid", blockedBand: "some", speedBand: "fast" },
      strategyActionId: "repair",
      seedKey: "m5-retrieve",
    });
    assert.equal(promoted.status, "promoted");
    assert.deepEqual(result.skillRefs, [skillRef(promoted)]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("M5 validator promotes only after matched reward lift", () => {
  const skill = buildSkill({
    title: "Repair learned procedure",
    domain: "general-evolution",
    mechanism: "repair strategy with proposer-critic team",
    status: "validating",
    triggers: ["decision=reject"],
    preconditions: ["strategy=repair", "team=proposer-critic"],
    procedure: ["Target failed evidence first."],
    sourceTrajectoryIds: ["source-1"],
    evidence: { support: 3, meanReward: 0.8 },
  });
  const ref = skillRef(skill);
  const used = [trajectory("u1", 0.88, { skillRefs: [ref] }), trajectory("u2", 0.9, { skillRefs: [ref] }), trajectory("u3", 0.86, { skillRefs: [ref] })];
  const baseline = [trajectory("b1", 0.7), trajectory("b2", 0.72), trajectory("b3", 0.69)];
  const result = evaluateSkillValidation(skill, [...used, ...baseline], { minObservations: 3, minBaseline: 3, minLift: 0.03 });
  assert.equal(result.promote, true);
  assert.ok(result.evidence.rewardLift > 0.1);
});
