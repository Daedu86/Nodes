import "server-only";

import { getSession, patchSession } from "@/lib/session-store";
import type { EvolutionEvaluation, EvolutionResumePoint, TychoVariant } from "@/lib/tycho-evolution-loop";
import type { TychoEvolutionSpec } from "@/lib/tycho/evolution-backend";
import {
  cancelDurableEvolutionRun,
  getDurableEvolutionRun,
  startDurableEvolutionRun,
  type DurableEvolutionRunSnapshot,
} from "@/lib/tycho/evolution-runner-client";
import {
  getDurableEvolutionLifecycleSnapshot,
  lifecycleFromRunner,
  upsertDurableEvolutionLifecycleArtifact,
} from "@/lib/tycho/durable-evolution-snapshot";
import {
  EVOLUTION_SESSION_SCHEMA_VERSION,
  getEvolutionSessionSnapshot,
  upsertEvolutionSessionArtifact,
  type EvolutionChampionSnapshot,
  type EvolutionEpisodeSnapshot,
  type EvolutionSeedSnapshot,
  type EvolutionSessionSnapshot,
} from "@/lib/tycho/evolution-session-snapshot";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function protocolFromSessionArtifacts(
  artifacts: Awaited<ReturnType<typeof getSession>>["artifacts"],
): TychoEvolutionSpec | null {
  const protocolArtifact = artifacts.find((artifact) =>
    artifact.fileName === ".nodes/tycho-experiment.json" ||
    artifact.title === ".nodes/tycho-experiment.json" ||
    artifact.title.toLowerCase().includes("tycho experiment"),
  );
  if (!protocolArtifact?.content.trim()) return null;
  let protocol: unknown;
  try {
    protocol = JSON.parse(protocolArtifact.content);
  } catch {
    throw new Error("The Session Tycho experiment artifact contains invalid JSON.");
  }
  if (!isRecord(protocol) || protocol.schemaVersion !== 1) {
    throw new Error("The Session Tycho experiment artifact must use schemaVersion 1.");
  }
  const experimentId = typeof protocol.experimentId === "string" ? protocol.experimentId.trim() : "";
  if (!experimentId) throw new Error("The Session Tycho experiment artifact is missing experimentId.");
  return { experimentId, protocol };
}

const evaluationFromChampion = (champion: EvolutionChampionSnapshot): EvolutionEvaluation => {
  if (champion.score === null || !Number.isFinite(champion.score)) {
    throw new Error("Evolution continuation requires a persisted champion with a finite score.");
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

const seedSnapshot = (
  candidate: { id: string; spec: TychoEvolutionSpec; generation: number; key: string },
): EvolutionSeedSnapshot => ({
  candidateId: candidate.id,
  candidateKey: candidate.key,
  experimentId: candidate.spec.experimentId,
});

const terminalSessionStatus = (run: DurableEvolutionRunSnapshot) =>
  run.status === "completed" ? "completed" as const : run.status === "failed" || run.status === "cancelled" ? "failed" as const : "running" as const;

const previousChampion = (
  episodes: EvolutionEpisodeSnapshot[],
  excludeEpisodeIndex: number,
) => [...episodes]
  .reverse()
  .find((episode) => episode.index !== excludeEpisodeIndex && episode.champion)?.champion ?? null;

async function patchArtifactsWithRetry(
  ownerId: string,
  sessionId: string,
  update: (artifacts: Awaited<ReturnType<typeof getSession>>["artifacts"]) => Awaited<ReturnType<typeof getSession>>["artifacts"],
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await getSession(sessionId, ownerId);
    try {
      return await patchSession(
        sessionId,
        { artifacts: update(session.artifacts) },
        { expectedVersion: session.version, ownerId },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to persist durable evolution state.");
}

export type StartDurableTychoEvolutionInput = {
  ownerId: string;
  sessionId: string;
  projectId?: string | null;
  workspaceId: string;
  generations: number;
  populationSize: number;
  mode: "start" | "continue";
  candidateTimeoutMs?: number;
  generatorTimeoutMs?: number;
};

export async function startDurableTychoEvolution(input: StartDurableTychoEvolutionInput) {
  const session = await getSession(input.sessionId, input.ownerId);
  const existing = getEvolutionSessionSnapshot(session.artifacts);
  const lifecycle = getDurableEvolutionLifecycleSnapshot(session.artifacts);

  if (lifecycle && ACTIVE_RUN_STATUSES.has(lifecycle.status)) {
    throw new Error(`This Session already has durable evolution run ${lifecycle.runId} in ${lifecycle.phase}.`);
  }
  if (existing?.status === "running") {
    throw new Error("This Session is marked as running evolution; reconnect to its durable run before starting another episode.");
  }
  if (input.mode === "start" && existing) {
    throw new Error("This Session already has evolution history; continue from its persisted champion.");
  }
  if (input.mode === "continue" && !existing) {
    throw new Error("Evolution continuation requires existing persisted history.");
  }
  if (existing?.projectId && input.projectId && existing.projectId !== input.projectId) {
    throw new Error("Evolution continuation cannot change the persisted projectId.");
  }

  let seed: TychoVariant<TychoEvolutionSpec>;
  let resumeFrom: EvolutionResumePoint<TychoEvolutionSpec> | undefined;
  if (input.mode === "continue") {
    const champion = existing?.champion;
    if (!champion) throw new Error("Evolution continuation requires a persisted champion.");
    seed = {
      id: champion.candidateId,
      spec: champion.spec,
      ...(champion.metadata ? { metadata: champion.metadata } : {}),
    };
    resumeFrom = resumePointFromChampion(champion);
  } else {
    const protocolSpec = protocolFromSessionArtifacts(session.artifacts);
    if (!protocolSpec) {
      throw new Error("No .nodes/tycho-experiment.json artifact is available in this Session to use as the seed.");
    }
    seed = {
      id: `seed-${protocolSpec.experimentId}`,
      spec: protocolSpec,
      metadata: { seedSource: "session-tycho-protocol" },
    };
  }

  const projectId = existing?.projectId ?? input.projectId ?? null;
  const episodeIndex = (existing?.episodes.length ?? 0) + 1;
  const started = await startDurableEvolutionRun({
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    projectId,
    workspaceId: input.workspaceId,
    episodeIndex,
    generations: input.generations,
    populationSize: input.populationSize,
    candidateTimeoutMs: input.candidateTimeoutMs,
    generatorTimeoutMs: input.generatorTimeoutMs,
    seed,
    ...(resumeFrom ? { resumeFrom } : {}),
  });

  const startingCandidate = resumeFrom?.candidate ?? {
    ...seed,
    generation: 0,
    key: `g0:${seed.id}`,
    parentKey: null,
  };
  const episode: EvolutionEpisodeSnapshot = {
    episodeId: `episode-${episodeIndex}`,
    index: episodeIndex,
    status: "running",
    workspaceId: input.workspaceId,
    seed: seedSnapshot(startingCandidate),
    startGeneration: started.startGeneration,
    endGeneration: null,
    generations: [],
    champion: null,
    reason: null,
    startedAt: started.createdAt,
    updatedAt: started.updatedAt,
    finishedAt: null,
  };
  const snapshot: EvolutionSessionSnapshot = existing
    ? {
        ...existing,
        schemaVersion: EVOLUTION_SESSION_SCHEMA_VERSION,
        projectId,
        status: "running",
        episodes: [...existing.episodes, episode],
        reason: null,
        updatedAt: started.updatedAt,
        finishedAt: null,
      }
    : {
        schemaVersion: EVOLUTION_SESSION_SCHEMA_VERSION,
        sessionId: input.sessionId,
        projectId,
        status: "running",
        seed: seedSnapshot(startingCandidate),
        episodes: [episode],
        generations: [],
        champion: null,
        reason: null,
        startedAt: started.createdAt,
        updatedAt: started.updatedAt,
        finishedAt: null,
      };

  try {
    await patchArtifactsWithRetry(input.ownerId, input.sessionId, (artifacts) => {
      const withEvidence = upsertEvolutionSessionArtifact(artifacts, snapshot);
      return upsertDurableEvolutionLifecycleArtifact(withEvidence, lifecycleFromRunner(started));
    });
  } catch (error) {
    await cancelDurableEvolutionRun(input.ownerId, started.runId).catch(() => null);
    throw error;
  }

  return { run: started, snapshot };
}

export async function reconcileDurableTychoEvolution(
  ownerId: string,
  sessionId: string,
  runId: string,
) {
  const session = await getSession(sessionId, ownerId);
  const lifecycle = getDurableEvolutionLifecycleSnapshot(session.artifacts);
  const existing = getEvolutionSessionSnapshot(session.artifacts);
  if (!lifecycle || lifecycle.runId !== runId || lifecycle.sessionId !== sessionId) {
    throw new Error("Durable evolution run is not linked to this Session.");
  }
  if (!existing) throw new Error("Durable evolution Session evidence is missing.");

  const run = await getDurableEvolutionRun(ownerId, runId);
  if (run.sessionId !== sessionId || run.episodeIndex !== lifecycle.episodeIndex) {
    throw new Error("Durable evolution runner identity does not match the Session lifecycle artifact.");
  }
  const episodeIndex = run.episodeIndex;
  const currentEpisode = existing.episodes.find((episode) => episode.index === episodeIndex);
  if (!currentEpisode) throw new Error(`Evolution episode ${episodeIndex} is missing from Session evidence.`);

  const mappedStatus = terminalSessionStatus(run);
  const episodeChampion = run.champion;
  const updatedEpisode: EvolutionEpisodeSnapshot = {
    ...currentEpisode,
    status: mappedStatus,
    generations: run.generations,
    champion: episodeChampion,
    reason: run.reason,
    endGeneration: run.generations.at(-1)?.generation ?? null,
    updatedAt: run.updatedAt,
    finishedAt: mappedStatus === "running" ? null : run.finishedAt ?? run.updatedAt,
  };
  const episodes = existing.episodes.map((episode) =>
    episode.index === episodeIndex ? updatedEpisode : episode,
  );
  const priorChampion = previousChampion(episodes, episodeIndex);
  const snapshot: EvolutionSessionSnapshot = {
    ...existing,
    projectId: existing.projectId ?? run.projectId,
    status: mappedStatus,
    episodes,
    generations: episodes.flatMap((episode) => episode.generations),
    champion: episodeChampion ?? priorChampion,
    reason: run.reason,
    updatedAt: run.updatedAt,
    finishedAt: mappedStatus === "running" ? null : run.finishedAt ?? run.updatedAt,
  };

  await patchArtifactsWithRetry(ownerId, sessionId, (artifacts) => {
    const withEvidence = upsertEvolutionSessionArtifact(artifacts, snapshot);
    return upsertDurableEvolutionLifecycleArtifact(withEvidence, lifecycleFromRunner(run));
  });
  return { run, snapshot };
}

export async function cancelDurableTychoEvolution(
  ownerId: string,
  sessionId: string,
  runId: string,
) {
  const session = await getSession(sessionId, ownerId);
  const lifecycle = getDurableEvolutionLifecycleSnapshot(session.artifacts);
  if (!lifecycle || lifecycle.runId !== runId) {
    throw new Error("Durable evolution run is not linked to this Session.");
  }
  await cancelDurableEvolutionRun(ownerId, runId);
  return reconcileDurableTychoEvolution(ownerId, sessionId, runId);
}
