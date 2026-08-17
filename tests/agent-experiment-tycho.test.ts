import { describe, expect, it } from "vitest";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
} from "@/lib/agent-experiments";
import {
  applyTychoEvaluation,
  recordExperimentPromotion,
} from "@/lib/agent-experiment-tycho";

describe("Tycho experiment binding", () => {
  const champion = {
    runtime: "codex" as const,
    runId: "champion",
    fork: () => ({ kind: "fork" as const, sourceRuntime: "codex" as const, sourceRunId: "champion" }),
  };

  it("keeps Tycho score authoritative while attaching operational evidence", () => {
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-tycho",
      champion,
      challengers: [
        { id: "a", runtime: "codex", sessionId: "s-a", prompt: "A" },
        { id: "b", runtime: "nooa", sessionId: "s-b", prompt: "B" },
      ],
    });
    const records = plan.candidates.map((candidate) =>
      createExperimentRunRecord({ plan, candidate }),
    );
    const evaluated = applyTychoEvaluation(records[0]!, {
      score: 0.93,
      metrics: { costUsd: 0.05, latencyMs: 700 },
      evidence: { verifier: "passed" },
    }, { inputTokens: 900, outputTokens: 180 });

    expect(evaluated).toMatchObject({
      status: "completed",
      metrics: {
        qualityScore: 0.93,
        costUsd: 0.05,
        latencyMs: 700,
        inputTokens: 900,
        outputTokens: 180,
      },
      evaluation: { score: 0.93 },
    });

    const promoted = recordExperimentPromotion({
      records: [evaluated, records[1]!],
      winnerCandidateId: "a",
      reason: "Tycho gate passed with the strongest verified utility.",
    });
    expect(promoted.map((record) => record.promotion)).toEqual(["challenger", "rejected"]);
  });
});
