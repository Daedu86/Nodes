import { describe, expect, it } from "vitest";
import { parseEvolutionSessionSnapshot } from "../lib/tycho/evolution-session-snapshot";

const v1Snapshot = {
  schemaVersion: 1,
  sessionId: "session-1",
  projectId: "project-1",
  status: "completed",
  seed: {
    candidateId: "seed",
    candidateKey: "g0:seed",
    experimentId: "experiment-seed",
  },
  generations: [
    {
      attempts: [
        {
          candidateId: "winner",
          candidateKey: "g1:winner",
          decision: "promote",
          error: null,
          evidence: { decision: "promote" },
          experimentId: "experiment-winner",
          generation: 1,
          index: 0,
          isWinner: true,
          metrics: { passRatio: 1 },
          parentKey: "g0:seed",
          runId: "run-1",
          score: 1,
          status: "succeeded",
        },
      ],
      error: null,
      generation: 1,
      parentKey: "g0:seed",
      requestedPopulation: 1,
      status: "completed",
      winnerKey: "g1:winner",
    },
  ],
  champion: {
    candidateId: "winner",
    candidateKey: "g1:winner",
    decision: "promote",
    error: null,
    evidence: { decision: "promote" },
    experimentId: "experiment-winner",
    generation: 1,
    index: 0,
    isWinner: true,
    metrics: { passRatio: 1 },
    parentKey: "g0:seed",
    runId: "run-1",
    score: 1,
    status: "succeeded",
    spec: {
      experimentId: "experiment-winner",
      protocol: { schemaVersion: 1, experimentId: "experiment-winner" },
    },
  },
  reason: null,
  startedAt: "2026-08-13T08:00:00.000Z",
  updatedAt: "2026-08-13T08:01:00.000Z",
  finishedAt: "2026-08-13T08:01:00.000Z",
};

describe("evolution session episode snapshots", () => {
  it("migrates the v1 flat history into one v2 episode without losing lineage", () => {
    const migrated = parseEvolutionSessionSnapshot(v1Snapshot);

    expect(migrated).not.toBeNull();
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.episodes).toHaveLength(1);
    expect(migrated?.episodes[0]).toMatchObject({
      episodeId: "episode-1",
      index: 1,
      workspaceId: null,
      startGeneration: 1,
      endGeneration: 1,
      status: "completed",
    });
    expect(migrated?.episodes[0]?.generations[0]?.winnerKey).toBe("g1:winner");
    expect(migrated?.champion?.candidateKey).toBe("g1:winner");
    expect(migrated?.champion?.metadata).toBeNull();
    expect(migrated?.generations).toHaveLength(1);
  });
});
