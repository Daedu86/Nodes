import "server-only";

import { getSession, patchSession } from "@/lib/session-store";
import {
  runEvolutionLoop,
  type EvolutionResult,
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
  snapshotEvolutionChampion,
  snapshotEvolutionGeneration,
  upsertEvolutionSessionArtifact,
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

export async function runPersistedTychoEvolution(
  input: RunPersistedTychoEvolutionInput,
): Promise<{
  result: EvolutionResult<TychoEvolutionSpec, TychoEvolutionExecution>;
  snapshot: EvolutionSessionSnapshot;
}> {
  const session = await getSession(input.sessionId, input.ownerId);
  const seedId = input.seed.id.trim();
  const experimentId = input.seed.spec.experimentId.trim();
  if (!seedId) throw new Error("Evolution seed id must not be empty.");
  if (!experimentId) throw new Error("Evolution seed experimentId must not be empty.");

  const startedAt = new Date().toISOString();
  let snapshot: EvolutionSessionSnapshot = {
    schemaVersion: 1,
    sessionId: input.sessionId,
    projectId: input.projectId ?? null,
    status: "running",
    seed: {
      candidateId: seedId,
      candidateKey: `g0:${seedId}`,
      experimentId,
    },
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

  const context: TychoEvolutionContext = {
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
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
      variantGenerator: input.variantGenerator,
      observer: {
        onGenerationComplete: async ({ generations, latestWinner }) => {
          const now = new Date().toISOString();
          const failedGeneration = generations.find((generation) => generation.status === "failed");
          snapshot = {
            ...snapshot,
            generations: generations.map(snapshotEvolutionGeneration),
            champion: snapshotEvolutionChampion(latestWinner),
            status: failedGeneration ? "failed" : "running",
            reason: failedGeneration?.error ?? null,
            updatedAt: now,
            finishedAt: failedGeneration ? now : null,
          };
          await persistSnapshot(input.ownerId, snapshot);
        },
      },
    });

    const finishedAt = new Date().toISOString();
    snapshot = {
      ...snapshot,
      generations: result.generations.map(snapshotEvolutionGeneration),
      champion: snapshotEvolutionChampion(
        result.status === "completed" ? result.finalWinner : snapshot.champion
          ? result.generations
              .flatMap((generation) => generation.attempts)
              .find((attempt) => attempt.candidate.key === snapshot.champion?.candidateKey) ?? null
          : null,
      ),
      status: result.status,
      reason: result.status === "failed" ? result.reason : null,
      updatedAt: finishedAt,
      finishedAt,
    };
    await persistSnapshot(input.ownerId, snapshot);
    return { result, snapshot };
  } catch (error) {
    if (snapshot.status !== "failed") {
      const finishedAt = new Date().toISOString();
      const failedSnapshot: EvolutionSessionSnapshot = {
        ...snapshot,
        status: "failed",
        reason: errorMessage(error),
        updatedAt: finishedAt,
        finishedAt,
      };
      await persistSnapshot(input.ownerId, failedSnapshot).catch(() => null);
      snapshot = failedSnapshot;
    }
    throw error;
  }
}
