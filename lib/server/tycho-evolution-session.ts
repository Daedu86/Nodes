import "server-only";

import { getSession, patchSession } from "@/lib/session-store";
import {
  runEvolutionLoop,
  type EvolutionEvaluation,
  type EvolutionResult,
  type EvolutionResumePoint,
  type EvolutionVariantGenerator,
  type TychoVariant,
} from "@/lib/tycho-evolution-loop";
import {
  createTychoEvolutionExecutionBackend,
  tychoPromotionEvaluator,
  type TychoEvolutionContext,
  type TychoEvolutionExecution,
  type TychoEvolutionSpec,
} from "@/lib/tycho/evolution-backend";
import {
  EVOLUTION_SESSION_SCHEMA_VERSION,
  getEvolutionSessionSnapshot,
  snapshotEvolutionChampion,
  snapshotEvolutionGeneration,
  upsertEvolutionSessionArtifact,
  type EvolutionChampionSnapshot,
  type EvolutionEpisodeSnapshot,
  type EvolutionSeedSnapshot,
  type EvolutionSessionSnapshot,
} from "@/lib/tycho/evolution-session-snapshot";

export type RunPersistedTychoEvolutionInput = {
  ownerId: string;
  projectId?: string | null;
  sessionId: string;
  workspaceId: string;
  generations: number;
  populationSize: number;
  seed: TychoVariant<TychoEvolutionSpec>;
  variantGenerator: EvolutionVariantGenerator<TychoEvolutionSpec, TychoEvolutionContext>;
  continueFromChampion?: boolean;
  pollIntervalMs?: number;
  timeoutMs?: number;
};

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim()
    ? error.message
    : typeof error === "string" && error.trim()
      ? error
      : "Unknown evolution session error";

async function persistSnapshot(ownerId: string, snapshot: EvolutionSessionSnapshot) {
  const session = await getSession(snapshot.sessionId, ownerId);
  const artifacts = upsertEvolutionSessionArtifact(session.artifacts, snapshot);
  return patchSession(
    snapshot.sessionId,
    { artifacts },
    { expectedVersion: session.version, ownerId },
  );
}

const seedSnapshot = (
  candidate: { id: string; key: string; spec: TychoEvolutionSpec },
): EvolutionSeedSnapshot => ({
  candidateId: candidate.id,
  candidateKey: candidate.key,
  experimentId: candidate.spec.experimentId,
});

const evaluationFromChampion = (
  champion: EvolutionChampionSnapshot,
): EvolutionEvaluation => {
  if (champion.score === null || !Number.isFinite(champion.score)) {
    throw new Error("Persisted evolution champion is missing a finite score and cannot be resumed.");
  }
  return {
    score: champion.score,
    ...(champion.metrics ? { metrics: champion.metrics } : {}),
    ...(champion.evidence ? { evidence: champion.evidence } : {}),
  };
};

const resumePointFromChampion = (
  champion: EvolutionChampionSnapshot,
): EvolutionResumePoint<TychoEvolutionSpec> => ({
  candidate: {
    id: champion.candidateId,
    spec: champion.spec,
    ...(champion.metadata ? { metadata: champion.metadata } : {}),
    generation: champion.generation,
    key: champion.candidateKey,
    parentKey: champion.parentKey,
  },
  evaluation: evaluationFromChampion(champion),
});

const updateEpisode = (
  snapshot: EvolutionSessionSnapshot,
  episode: EvolutionEpisodeSnapshot,
) => ({
  ...snapshot,
  episodes: snapshot.episodes.map((entry) =>
    entry.episodeId === episode.episodeId ? episode : entry,
  ),
});

export async function runPersistedTychoEvolution(
  input: RunPersistedTychoEvolutionInput,
): Promise<{
  result: EvolutionResult<TychoEvolutionSpec, TychoEvolutionExecution>;
  snapshot: EvolutionSessionSnapshot;
}> {
  const session = await getSession(input.sessionId, input.ownerId);
  const existingSnapshot = getEvolutionSessionSnapshot(session.artifacts);
  const continueFromChampion = input.continueFromChampion === true;

  if (continueFromChampion && !existingSnapshot) {
    throw new Error("Evolution continuation requires an existing persisted evolution history.");
  }
  if (!continueFromChampion && existingSnapshot) {
    throw new Error("This Session already has evolution history; use continuation from its champion.");
  }
  if (existingSnapshot?.status === "running") {
    throw new Error("This Session already has an evolution episode running.");
  }
  if (
    existingSnapshot?.projectId &&
    input.projectId &&
    existingSnapshot.projectId !== input.projectId
  ) {
    throw new Error("Evolution continuation cannot change the persisted projectId.");
  }

  const seedId = input.seed.id.trim();
  const experimentId = input.seed.spec.experimentId.trim();
  if (!seedId) throw new Error("Evolution seed id must not be empty.");
  if (!experimentId) throw new Error("Evolution seed experimentId must not be empty.");

  const resumeFrom = continueFromChampion
    ? resumePointFromChampion(existingSnapshot!.champion ?? (() => {
        throw new Error("Evolution continuation requires a persisted champion.");
      })())
    : undefined;
  const startingCandidate = resumeFrom?.candidate ?? {
    ...input.seed,
    id: seedId,
    generation: 0,
    key: `g0:${seedId}`,
    parentKey: null,
  };
  const episodeIndex = (existingSnapshot?.episodes.length ?? 0) + 1;
  const episodeId = `episode-${episodeIndex}`;
  const startedAt = new Date().toISOString();
  const episode: EvolutionEpisodeSnapshot = {
    episodeId,
    index: episodeIndex,
    status: "running",
    workspaceId: input.workspaceId,
    seed: seedSnapshot(startingCandidate),
    startGeneration: startingCandidate.generation + 1,
    endGeneration: null,
    generations: [],
    champion: null,
    reason: null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
  };

  let snapshot: EvolutionSessionSnapshot = existingSnapshot
    ? {
        ...existingSnapshot,
        schemaVersion: EVOLUTION_SESSION_SCHEMA_VERSION,
        projectId: existingSnapshot.projectId ?? input.projectId ?? null,
        status: "running",
        episodes: [...existingSnapshot.episodes, episode],
        reason: null,
        updatedAt: startedAt,
        finishedAt: null,
      }
    : {
        schemaVersion: EVOLUTION_SESSION_SCHEMA_VERSION,
        sessionId: input.sessionId,
        projectId: input.projectId ?? null,
        status: "running",
        seed: seedSnapshot(startingCandidate),
        episodes: [episode],
        generations: [],
        champion: null,
        reason: null,
        startedAt,
        updatedAt: startedAt,
        finishedAt: null,
      };

  await patchSession(
    input.sessionId,
    { artifacts: upsertEvolutionSessionArtifact(session.artifacts, snapshot) },
    { expectedVersion: session.version, ownerId: input.ownerId },
  );

  const previousGenerations = existingSnapshot?.generations ?? [];
  const previousChampion = existingSnapshot?.champion ?? null;
  const context: TychoEvolutionContext = {
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    projectId: snapshot.projectId,
    sessionId: input.sessionId,
    pollIntervalMs: input.pollIntervalMs,
    timeoutMs: input.timeoutMs,
  };

  try {
    const result = await runEvolutionLoop<TychoEvolutionSpec, TychoEvolutionExecution, TychoEvolutionContext>({
      context,
      evaluator: tychoPromotionEvaluator,
      executionBackend: createTychoEvolutionExecutionBackend(),
      generations: input.generations,
      populationSize: input.populationSize,
      seed: input.seed,
      ...(resumeFrom ? { resumeFrom } : {}),
      variantGenerator: input.variantGenerator,
      observer: {
        onGenerationComplete: async ({ generations, latestWinner }) => {
          const now = new Date().toISOString();
          const localGenerations = generations.map(snapshotEvolutionGeneration);
          const failedGeneration = generations.find((generation) => generation.status === "failed");
          const episodeChampion = snapshotEvolutionChampion(latestWinner);
          const currentEpisode: EvolutionEpisodeSnapshot = {
            ...episode,
            status: failedGeneration ? "failed" : "running",
            generations: localGenerations,
            champion: episodeChampion,
            reason: failedGeneration?.error ?? null,
            endGeneration: localGenerations.at(-1)?.generation ?? null,
            updatedAt: now,
            finishedAt: failedGeneration ? now : null,
          };
          snapshot = updateEpisode(
            {
              ...snapshot,
              generations: [...previousGenerations, ...localGenerations],
              champion: episodeChampion ?? previousChampion,
              status: failedGeneration ? "failed" : "running",
              reason: failedGeneration?.error ?? null,
              updatedAt: now,
              finishedAt: failedGeneration ? now : null,
            },
            currentEpisode,
          );
          await persistSnapshot(input.ownerId, snapshot);
        },
      },
    });

    const finishedAt = new Date().toISOString();
    const localGenerations = result.generations.map(snapshotEvolutionGeneration);
    const finalEpisodeChampion = result.status === "completed"
      ? snapshotEvolutionChampion(result.finalWinner)
      : snapshot.episodes.at(-1)?.champion ?? null;
    const finalEpisode: EvolutionEpisodeSnapshot = {
      ...(snapshot.episodes.at(-1) ?? episode),
      status: result.status,
      generations: localGenerations,
      champion: finalEpisodeChampion,
      reason: result.status === "failed" ? result.reason : null,
      endGeneration: localGenerations.at(-1)?.generation ?? null,
      updatedAt: finishedAt,
      finishedAt,
    };
    snapshot = updateEpisode(
      {
        ...snapshot,
        generations: [...previousGenerations, ...localGenerations],
        champion: finalEpisodeChampion ?? previousChampion,
        status: result.status,
        reason: result.status === "failed" ? result.reason : null,
        updatedAt: finishedAt,
        finishedAt,
      },
      finalEpisode,
    );
    await persistSnapshot(input.ownerId, snapshot);
    return { result, snapshot };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const currentEpisode = snapshot.episodes.at(-1) ?? episode;
    const failedEpisode: EvolutionEpisodeSnapshot = {
      ...currentEpisode,
      status: "failed",
      reason: errorMessage(error),
      updatedAt: finishedAt,
      finishedAt,
    };
    const failedSnapshot = updateEpisode(
      {
        ...snapshot,
        status: "failed",
        reason: errorMessage(error),
        updatedAt: finishedAt,
        finishedAt,
      },
      failedEpisode,
    );
    await persistSnapshot(input.ownerId, failedSnapshot).catch(() => null);
    snapshot = failedSnapshot;
    throw error;
  }
}
