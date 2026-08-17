import { describe, expect, it } from "vitest";
import type {
  AgentEventCreateInput,
  AgentEventRecord,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
} from "@/lib/agent-experiments";
import {
  listExperimentRuns,
  persistExperimentRun,
} from "@/lib/server/agent-experiment-store";

const createRepository = () => {
  const events: AgentEventRecord[] = [];
  let sequence = 0;
  const repository = {
    async recordAgentEvent(ownerId: string, input: AgentEventCreateInput) {
      sequence += 1;
      events.push({
        ...input,
        id: input.id ?? `event-${sequence}`,
        ownerId,
        createdAt: input.createdAt ?? `2026-08-17T08:00:0${sequence}.000Z`,
      });
    },
    async listAgentEvents(ownerId: string) {
      return events.filter((event) => event.ownerId === ownerId);
    },
  } as unknown as AgentWorkRepository;
  return { repository, events };
};

describe("agent experiment store", () => {
  it("returns the latest append-only snapshot per candidate", async () => {
    const { repository, events } = createRepository();
    const champion = {
      runtime: "codex" as const,
      runId: "champion",
      fork: () => ({
        kind: "fork" as const,
        sourceRuntime: "codex" as const,
        sourceRunId: "champion",
      }),
    };
    const plan = buildArenaExperimentPlan({
      experimentId: "exp-store",
      champion,
      challengers: [
        { id: "a", runtime: "codex", sessionId: "s-a", projectId: "p-1", prompt: "A" },
      ],
    });
    const record = createExperimentRunRecord({ plan, candidate: plan.candidates[0]! });

    await persistExperimentRun({ ownerId: "owner", record, repository });
    record.status = "completed";
    record.runId = "run-a";
    record.metrics = {
      ...record.metrics,
      qualityScore: 0.91,
      costUsd: 0.04,
      latencyMs: 800,
    };
    await persistExperimentRun({ ownerId: "owner", record, repository });

    expect(events).toHaveLength(2);
    const loaded = await listExperimentRuns({
      ownerId: "owner",
      experimentId: "exp-store",
      projectId: "p-1",
      repository,
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      candidateId: "a",
      status: "completed",
      runId: "run-a",
      metrics: { qualityScore: 0.91, costUsd: 0.04, latencyMs: 800 },
    });
  });
});
