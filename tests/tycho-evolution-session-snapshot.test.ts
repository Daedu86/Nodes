import { describe, expect, it } from "vitest";
import type { SessionArtifact } from "../lib/session-artifacts";
import {
  EVOLUTION_SESSION_FILE_NAME,
  getEvolutionSessionSnapshot,
  parseEvolutionSessionSnapshotContent,
  upsertEvolutionSessionArtifact,
  type EvolutionSessionSnapshot,
} from "../lib/tycho/evolution-session-snapshot";

const snapshot = (updatedAt = "2026-08-13T07:00:00.000Z"): EvolutionSessionSnapshot => {
  const candidate = {
    candidateId: "candidate-b",
    candidateKey: "g1:candidate-b",
    decision: "promote" as const,
    error: null,
    evidence: { decision: "promote" },
    experimentId: "candidate-b-exp",
    generation: 1,
    index: 1,
    isWinner: true,
    metadata: { generator: "codex", generatorRunId: "generator-1" },
    metrics: { passRatio: 1 },
    parentKey: "g0:seed",
    runId: "run-1",
    score: 2.5,
    status: "succeeded" as const,
  };
  const generation = {
    attempts: [candidate],
    error: null,
    generation: 1,
    parentKey: "g0:seed",
    requestedPopulation: 2,
    status: "completed" as const,
    winnerKey: "g1:candidate-b",
  };
  const champion = {
    ...candidate,
    spec: {
      experimentId: "candidate-b-exp",
      protocol: { schemaVersion: 1, experimentId: "candidate-b-exp" },
    },
  };
  const seed = {
    candidateId: "seed",
    candidateKey: "g0:seed",
    experimentId: "seed-exp",
  };

  return {
    schemaVersion: 2,
    sessionId: "session-1",
    projectId: "project-1",
    status: "completed",
    seed,
    episodes: [
      {
        episodeId: "episode-1",
        index: 1,
        status: "completed",
        workspaceId: "workspace-1",
        seed,
        startGeneration: 1,
        endGeneration: 1,
        generations: [generation],
        champion,
        reason: null,
        startedAt: "2026-08-13T06:59:00.000Z",
        updatedAt,
        finishedAt: updatedAt,
      },
    ],
    generations: [generation],
    champion,
    reason: null,
    startedAt: "2026-08-13T06:59:00.000Z",
    updatedAt,
    finishedAt: updatedAt,
  };
};

describe("evolution session snapshot", () => {
  it("persists a stable system-managed evidence artifact and parses it back", () => {
    const first = upsertEvolutionSessionArtifact([], snapshot());
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: "tycho-evolution-session:session-1",
      artifactType: "file",
      semanticType: "evidence",
      fileName: EVOLUTION_SESSION_FILE_NAME,
      mimeType: "application/json",
      syncMode: "paused",
    });
    expect(getEvolutionSessionSnapshot(first)?.champion?.candidateId).toBe("candidate-b");
    expect(getEvolutionSessionSnapshot(first)?.episodes[0]?.workspaceId).toBe("workspace-1");

    const nextSnapshot = snapshot("2026-08-13T07:01:00.000Z");
    nextSnapshot.status = "failed";
    nextSnapshot.reason = "generation failed";
    nextSnapshot.episodes[0]!.status = "failed";
    nextSnapshot.episodes[0]!.reason = "generation failed";
    const second = upsertEvolutionSessionArtifact(first, nextSnapshot);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.createdAt).toBe(first[0]?.createdAt);
    expect(getEvolutionSessionSnapshot(second)?.reason).toBe("generation failed");
  });

  it("fails closed on malformed or unsupported snapshot content", () => {
    expect(parseEvolutionSessionSnapshotContent("not-json")).toBeNull();
    expect(
      parseEvolutionSessionSnapshotContent(
        JSON.stringify({ ...snapshot(), schemaVersion: 3 }),
      ),
    ).toBeNull();
    expect(
      parseEvolutionSessionSnapshotContent(
        JSON.stringify({ ...snapshot(), generations: [{ generation: 1 }] }),
      ),
    ).toBeNull();
  });

  it("preserves unrelated session artifacts while updating evolution evidence", () => {
    const unrelated: SessionArtifact = {
      id: "artifact-1",
      title: "Notes",
      artifactType: "text",
      content: "keep me",
      createdAt: "2026-08-13T06:00:00.000Z",
      updatedAt: "2026-08-13T06:00:00.000Z",
    };
    const result = upsertEvolutionSessionArtifact([unrelated], snapshot());
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(unrelated);
  });
});
