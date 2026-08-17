import { describe, expect, it } from "vitest";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
  experimentPlanToTychoVariants,
  rankExperimentRuns,
} from "@/lib/agent-experiments";

describe("Arena durable experiments", () => {
  const champion = {
    runtime: "codex" as const,
    runId: "champion-run",
    fork: () => ({
      kind: "fork" as const,
      sourceRuntime: "codex" as const,
      sourceRunId: "champion-run",
    }),
  };

  it("turns a champion into provider-neutral Tycho challenger variants", () => {
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-42",
      champion,
      challengers: [
        {
          id: "fast",
          title: "Fast challenger",
          runtime: "nooa",
          sessionId: "session-fast",
          projectId: "project-1",
          prompt: "Try a lower-latency strategy",
          model: "model-fast",
        },
        {
          id: "deep",
          runtime: "codex",
          sessionId: "session-deep",
          projectId: "project-1",
          prompt: "Try a deeper strategy",
        },
      ],
    });

    expect(plan.champion).toEqual({ runtime: "codex", runId: "champion-run" });
    expect(plan.candidates[0]?.continuation).toEqual({
      kind: "fork",
      sourceRuntime: "codex",
      sourceRunId: "champion-run",
    });
    expect(plan.candidates[0]?.run).toMatchObject({
      id: "exp-42:fast",
      runtime: "nooa",
      parentRunId: "champion-run",
      continuation: { kind: "fork", sourceRunId: "champion-run" },
      metadata: {
        model: "model-fast",
        nodesExperimentId: "exp-42",
        nodesCandidateId: "fast",
      },
    });
    expect(createExperimentRunRecord({
      plan,
      candidate: plan.candidates[0]!,
    }).model).toBe("model-fast");

    const variants = experimentPlanToTychoVariants(plan);
    expect(variants.map((variant) => variant.id)).toEqual(["fast", "deep"]);
    expect(variants[0]?.spec).not.toBe(plan.candidates[0]?.run);
  });

  it("makes quality/cost/latency trade-offs explicit", () => {
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-rank",
      champion,
      challengers: [
        { id: "quality", runtime: "codex", sessionId: "s1", prompt: "quality" },
        { id: "efficient", runtime: "nooa", sessionId: "s2", prompt: "efficient" },
      ],
    });
    const quality = createExperimentRunRecord({ plan, candidate: plan.candidates[0]! });
    const efficient = createExperimentRunRecord({ plan, candidate: plan.candidates[1]! });
    quality.status = "completed";
    quality.metrics = {
      ...quality.metrics,
      qualityScore: 0.9,
      costUsd: 10,
      latencyMs: 1000,
    };
    efficient.status = "completed";
    efficient.metrics = {
      ...efficient.metrics,
      qualityScore: 0.88,
      costUsd: 1,
      latencyMs: 100,
    };

    const qualityFirst = rankExperimentRuns([quality, efficient]);
    expect(qualityFirst[0]?.record.candidateId).toBe("quality");

    const efficiencyFirst = rankExperimentRuns([quality, efficient], {
      quality: 0.4,
      cost: 0.3,
      latency: 0.3,
    });
    expect(efficiencyFirst[0]?.record.candidateId).toBe("efficient");
  });

  it("does not promote unmetered runs when cost/latency matter", () => {
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-metering",
      champion,
      challengers: [
        { id: "unknown-cost", runtime: "codex", sessionId: "s1", prompt: "test" },
      ],
    });
    const record = createExperimentRunRecord({ plan, candidate: plan.candidates[0]! });
    record.status = "completed";
    record.metrics.qualityScore = 1;
    expect(rankExperimentRuns([record])).toEqual([]);
  });
});
