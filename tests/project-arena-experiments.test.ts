import { describe, expect, it } from "vitest";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
} from "@/lib/agent-experiments";
import {
  buildProjectArenaExperimentEntries,
  buildProjectArenaExperimentSummary,
  buildProjectArenaPromotion,
} from "@/lib/project-arena-experiments";

const buildRecords = () => {
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
  return plan.candidates.map((candidate) =>
    createExperimentRunRecord({ plan, candidate }),
  );
};

describe("Project Arena experiments", () => {
  it("surfaces Tycho quality, cost, latency, and utility together", () => {
    const records = buildRecords();
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

  it("blocks promotion until every candidate has complete terminal evidence", () => {
    const records = buildRecords();
    records[0]!.status = "completed";
    records[0]!.metrics = { qualityScore: 0.9, costUsd: 0.08, latencyMs: 1200, inputTokens: 800, outputTokens: 200 };
    records[1]!.status = "running";

    const result = buildProjectArenaPromotion(records);
    expect(result.ready).toBe(false);
    expect(result.winner).toBeNull();
    expect(result.reason).toContain("Every candidate");
    expect(result.records.every((record) => record.promotion === "undecided")).toBe(true);
  });

  it("promotes one evidence-backed winner and rejects the remaining candidates", () => {
    const records = buildRecords();
    records[0]!.status = "completed";
    records[0]!.metrics = { qualityScore: 0.95, costUsd: 0.08, latencyMs: 1200, inputTokens: 800, outputTokens: 200 };
    records[1]!.status = "completed";
    records[1]!.metrics = { qualityScore: 0.8, costUsd: 0.02, latencyMs: 500, inputTokens: 600, outputTokens: 160 };

    const result = buildProjectArenaPromotion(records);
    expect(result.ready).toBe(true);
    expect(result.winner?.candidateId).toBe("a");
    expect(result.records.find((record) => record.candidateId === "a")?.promotion).toBe("champion");
    expect(result.records.find((record) => record.candidateId === "b")?.promotion).toBe("rejected");
    expect(result.reason).toContain("Tycho quality");
  });
});