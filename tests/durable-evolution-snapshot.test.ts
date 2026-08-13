import { describe, expect, it } from "vitest";

import {
  getDurableEvolutionLifecycleSnapshot,
  lifecycleFromRunner,
  parseDurableEvolutionLifecycleContent,
  upsertDurableEvolutionLifecycleArtifact,
} from "@/lib/tycho/durable-evolution-snapshot";
import type { DurableEvolutionRunSnapshot } from "@/lib/tycho/evolution-runner-client";

const run = (overrides: Partial<DurableEvolutionRunSnapshot> = {}): DurableEvolutionRunSnapshot => ({
  schemaVersion: 1,
  runId: "run-1",
  sessionId: "session-1",
  projectId: "project-1",
  workspaceId: "workspace-1",
  episodeIndex: 2,
  status: "running",
  phase: "checkpointed",
  requestedGenerations: 4,
  populationSize: 3,
  startGeneration: 5,
  nextGeneration: 7,
  completedGenerations: 2,
  generations: [],
  champion: null,
  reason: null,
  activeGeneratorRunId: null,
  activeCandidateRunIds: [],
  cancelRequested: false,
  createdAt: "2026-08-13T08:00:00.000Z",
  startedAt: "2026-08-13T08:00:01.000Z",
  updatedAt: "2026-08-13T08:02:00.000Z",
  finishedAt: null,
  ...overrides,
});

describe("durable evolution lifecycle artifact", () => {
  it("round-trips the runner identity and checkpoint state", () => {
    const lifecycle = lifecycleFromRunner(run());
    const artifacts = upsertDurableEvolutionLifecycleArtifact([], lifecycle);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.fileName).toBe(".nodes/evolution-run.json");
    expect(artifacts[0]?.semanticType).toBe("evidence");
    expect(artifacts[0]?.syncMode).toBe("paused");
    expect(getDurableEvolutionLifecycleSnapshot(artifacts)).toEqual(lifecycle);
  });

  it("keeps one stable artifact while lifecycle state advances", () => {
    const initial = lifecycleFromRunner(run());
    const first = upsertDurableEvolutionLifecycleArtifact([], initial);
    const completed = lifecycleFromRunner(run({
      status: "completed",
      phase: "completed",
      completedGenerations: 4,
      updatedAt: "2026-08-13T08:04:00.000Z",
      finishedAt: "2026-08-13T08:04:00.000Z",
    }));
    const second = upsertDurableEvolutionLifecycleArtifact(first, completed);

    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(getDurableEvolutionLifecycleSnapshot(second)?.status).toBe("completed");
    expect(getDurableEvolutionLifecycleSnapshot(second)?.completedGenerations).toBe(4);
  });

  it("fails closed on malformed lifecycle content", () => {
    expect(parseDurableEvolutionLifecycleContent('{"schemaVersion":1,"runId":"missing-fields"}')).toBeNull();
    expect(parseDurableEvolutionLifecycleContent("not-json")).toBeNull();
  });
});
