import assert from "node:assert/strict";
import test from "node:test";

import { deriveCapabilityProfiles } from "./capability-model.mjs";
import { createCurriculumController } from "./curriculum-controller.mjs";
import { validateCurriculumTask } from "./curriculum-validator.mjs";

function trajectory(id, reward, createdAt, overrides = {}) {
  return {
    trajectoryId: id,
    status: "succeeded",
    reward,
    createdAt,
    state: { decision: "promote", passBand: "medium", blockedBand: "low", speedBand: "normal" },
    candidateMetadata: { domain: "tabular-ml", ...overrides },
  };
}

test("M6 capability model prioritizes uncertain stalled frontiers", () => {
  const profiles = deriveCapabilityProfiles([
    trajectory("a1", 0.92, "2026-01-01T00:00:00Z", { curriculumContext: { task: { domain: "tabular-ml", capabilityKey: "easy" } } }),
    trajectory("a2", 0.94, "2026-01-02T00:00:00Z", { curriculumContext: { task: { domain: "tabular-ml", capabilityKey: "easy" } } }),
    trajectory("b1", 0.55, "2026-01-03T00:00:00Z", { curriculumContext: { task: { domain: "tabular-ml", capabilityKey: "frontier" } } }),
  ], []);
  assert.equal(profiles[0].capabilityKey, "frontier");
  assert.ok(profiles[0].learningValue > profiles[1].learningValue);
});

test("M6 controller emits bounded validated tasks and stops at run budget", async () => {
  const controller = createCurriculumController({
    mode: "online",
    maxTasksPerRun: 2,
    maxDifficulty: 0.7,
    targetReward: 0.65,
    allowedDomains: ["tabular-ml"],
  });
  const trajectories = [
    trajectory("b1", 0.55, "2026-01-01T00:00:00Z"),
    trajectory("b2", 0.57, "2026-01-02T00:00:00Z"),
  ];
  const plan = await controller.plan({ trajectories, skills: [], workspaceId: "workspace", generation: 1, defaultDomain: "tabular-ml" });
  assert.equal(plan.mode, "online");
  assert.equal(plan.task.domain, "tabular-ml");
  assert.ok(plan.task.difficulty <= 0.7);
  assert.equal(validateCurriculumTask(plan.task, { maxDifficulty: 0.7, allowedDomains: ["tabular-ml"] }).taskId, plan.task.taskId);

  const exhausted = await controller.plan({ trajectories, skills: [], workspaceId: "workspace", generation: 3, defaultDomain: "tabular-ml" });
  assert.equal(exhausted.task, null);
  assert.equal(exhausted.reason, "task-budget-exhausted");
});

test("M6 off mode is an exact no-task path", async () => {
  const controller = createCurriculumController({ mode: "off" });
  const plan = await controller.plan({ trajectories: [], skills: [], workspaceId: "workspace", generation: 1 });
  assert.equal(plan.task, null);
  assert.equal(plan.reason, "curriculum-off");
});
