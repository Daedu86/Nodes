import { describe, expect, it } from "vitest";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
} from "@/lib/agent-experiments";
import {
  buildProjectArenaExperimentEntries,
  buildProjectArenaExperimentSummary,
} from "@/lib/project-arena-experiments";

describe("Project Arena experiments", () => {
  it("surfaces Tycho quality, cost, latency, and utility together", () => {
    const champion = {
      runtime: "codex" as const,
      runId: "champion",
      fork: () => ({ kind: "fork" as const, sourceRuntime: "codex" as const, sourceRunId: "champion" }),
    };
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-arena",
      champion,
      challengers: [
        { id: "a", title: "A", runtime: "codex", sessionId: "s-a", prompt: "A" },
        { id: "b", title: "B", runtime: "nooa", sessionId: "s-b", prompt: "B" },
      ],
    });
    const records = plan.candidates.map((candidate) =>
      createExperimentRunRecord({ plan, candidate }),
    );
    records[0]!.status = "completed";
    records[0]!.metrics = { qualityScore: 0.9, costUsd: 0.08, latencyMs: 1200, inputTokens: 800, outputTokens: 200 };
    records[1]!.status = "completed";
    records[1]!.metrics = { qualityScore: 0.89, costUsd: 0.02, latencyMs: 500, inputTokens: 600, outputTokens: 160 };

    const entries = buildProjectArenaExperimentEntries(records);
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.utility !== null)).toBe(true);
    expect(entries[0]).toMatchObject({ experimentId: "exp-arena", status: "completed" });

    const summary = buildProjectArenaExperimentSummary(records);
    expect(summary?.comparedCount).toBe(2);
    expect(summary?.summary).toContain("Tycho quality");
    expect(summary?.summary).toContain("cost $");
  });
});
