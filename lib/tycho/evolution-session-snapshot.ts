import type { SessionArtifact } from "@/lib/session-artifacts";
import type {
  EvolutionAttempt,
  EvolutionGeneration,
} from "@/lib/tycho-evolution-loop";
import type {
  TychoEvolutionExecution,
  TychoEvolutionSpec,
} from "@/lib/tycho/evolution-backend";

export const EVOLUTION_SESSION_SCHEMA_VERSION = 2 as const;
export const EVOLUTION_SESSION_FILE_NAME = ".nodes/evolution-session.json";
export const EVOLUTION_SESSION_TITLE = "Evolution Session";

export type EvolutionCandidateSnapshot = {
  candidateId: string;
  candidateKey: string;
  decision: "promote" | "reject" | "blocked" | null;
  error: { message: string; stage: "execution" | "evaluation" } | null;
  evidence: Record<string, unknown> | null;
  experimentId: string;
  generation: number;
  index: number;
  isWinner: boolean;
  metadata: Record<string, unknown> | null;
  metrics: Record<string, number> | null;
  parentKey: string | null;
  runId: string | null;
  score: number | null;
  status: "succeeded" | "failed";
};

export type EvolutionGenerationSnapshot = {
  attempts: EvolutionCandidateSnapshot[];
  error: string | null;
  generation: number;
  parentKey: string;
  requestedPopulation: number;
  status: "completed" | "failed";
  winnerKey: string | null;
};

export type EvolutionChampionSnapshot = EvolutionCandidateSnapshot & {
  spec: TychoEvolutionSpec;
};

export type EvolutionSeedSnapshot = {
  candidateId: string;
  candidateKey: string;
  experimentId: string;
};

export type EvolutionEpisodeSnapshot = {
  episodeId: string;
  index: number;
  status: "running" | "completed" | "failed";
  seed: EvolutionSeedSnapshot;
  startGeneration: number;
  endGeneration: number | null;
  generations: EvolutionGenerationSnapshot[];
  champion: EvolutionChampionSnapshot | null;
  reason: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type EvolutionSessionSnapshot = {
  schemaVersion: typeof EVOLUTION_SESSION_SCHEMA_VERSION;
  sessionId: string;
  projectId: string | null;
  status: "running" | "completed" | "failed";
  seed: EvolutionSeedSnapshot;
  episodes: EvolutionEpisodeSnapshot[];
  generations: EvolutionGenerationSnapshot[];
  champion: EvolutionChampionSnapshot | null;
  reason: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDecision = (
  value: unknown,
): value is EvolutionCandidateSnapshot["decision"] =>
  value === null || value === "promote" || value === "reject" || value === "blocked";

const isAttemptStatus = (value: unknown): value is EvolutionCandidateSnapshot["status"] =>
  value === "succeeded" || value === "failed";

const isSnapshotStatus = (value: unknown): value is EvolutionSessionSnapshot["status"] =>
  value === "running" || value === "completed" || value === "failed";

const isGenerationStatus = (value: unknown): value is EvolutionGenerationSnapshot["status"] =>
  value === "completed" || value === "failed";

const nullableString = (value: unknown) =>
  value === null || typeof value === "string";

const finiteOrNull = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isFinite(value));

const numericRecordOrNull = (value: unknown) => {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === "number" && Number.isFinite(entry),
  );
};

const recordOrNull = (value: unknown) => value === null || isRecord(value);

const isCandidateSnapshot = (
  value: unknown,
  options: { allowMissingMetadata?: boolean } = {},
): value is EvolutionCandidateSnapshot => {
  if (!isRecord(value)) return false;
  const error = value.error;
  const validError =
    error === null ||
    (isRecord(error) &&
      typeof error.message === "string" &&
      (error.stage === "execution" || error.stage === "evaluation"));
  const validMetadata = options.allowMissingMetadata && value.metadata === undefined
    ? true
    : recordOrNull(value.metadata);
  return (
    typeof value.candidateId === "string" &&
    typeof value.candidateKey === "string" &&
    isDecision(value.decision) &&
    validError &&
    (value.evidence === null || isRecord(value.evidence)) &&
    typeof value.experimentId === "string" &&
    Number.isInteger(value.generation) &&
    Number.isInteger(value.index) &&
    typeof value.isWinner === "boolean" &&
    validMetadata &&
    numericRecordOrNull(value.metrics) &&
    nullableString(value.parentKey) &&
    nullableString(value.runId) &&
    finiteOrNull(value.score) &&
    isAttemptStatus(value.status)
  );
};

const normalizeCandidateMetadata = <T extends EvolutionCandidateSnapshot>(value: T): T =>
  ({ ...value, metadata: value.metadata ?? null });

const isSeedSnapshot = (value: unknown): value is EvolutionSeedSnapshot =>
  isRecord(value) &&
  typeof value.candidateId === "string" &&
  typeof value.candidateKey === "string" &&
  typeof value.experimentId === "string";

const parseGeneration = (
  value: unknown,
  options: { allowMissingMetadata?: boolean } = {},
): EvolutionGenerationSnapshot | null => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.attempts) ||
    !value.attempts.every((attempt) => isCandidateSnapshot(attempt, options)) ||
    !nullableString(value.error) ||
    !Number.isInteger(value.generation) ||
    typeof value.parentKey !== "string" ||
    !Number.isInteger(value.requestedPopulation) ||
    !isGenerationStatus(value.status) ||
    !nullableString(value.winnerKey)
  ) {
    return null;
  }
  return {
    ...(value as unknown as EvolutionGenerationSnapshot),
    attempts: value.attempts.map((attempt) =>
      normalizeCandidateMetadata(attempt as EvolutionCandidateSnapshot),
    ),
  };
};

const parseChampion = (
  value: unknown,
  options: { allowMissingMetadata?: boolean } = {},
): EvolutionChampionSnapshot | null | undefined => {
  if (value === null) return null;
  const championSpec = isRecord(value) ? value.spec : null;
  if (!isCandidateSnapshot(value, options) || !isRecord(championSpec)) return undefined;
  if (
    typeof championSpec.experimentId !== "string" ||
    !isRecord(championSpec.protocol)
  ) {
    return undefined;
  }
  return normalizeCandidateMetadata(value as EvolutionChampionSnapshot);
};

const parseV2 = (value: Record<string, unknown>): EvolutionSessionSnapshot | null => {
  if (
    value.schemaVersion !== EVOLUTION_SESSION_SCHEMA_VERSION ||
    typeof value.sessionId !== "string" ||
    !nullableString(value.projectId) ||
    !isSnapshotStatus(value.status) ||
    !isSeedSnapshot(value.seed) ||
    !Array.isArray(value.episodes) ||
    !Array.isArray(value.generations) ||
    !nullableString(value.reason) ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !nullableString(value.finishedAt)
  ) {
    return null;
  }

  const generations = value.generations.map((generation) => parseGeneration(generation));
  if (generations.some((generation) => generation === null)) return null;

  const champion = parseChampion(value.champion);
  if (champion === undefined) return null;

  const episodes: EvolutionEpisodeSnapshot[] = [];
  for (const rawEpisode of value.episodes) {
    if (
      !isRecord(rawEpisode) ||
      typeof rawEpisode.episodeId !== "string" ||
      !Number.isInteger(rawEpisode.index) ||
      !isSnapshotStatus(rawEpisode.status) ||
      !isSeedSnapshot(rawEpisode.seed) ||
      !Number.isInteger(rawEpisode.startGeneration) ||
      !(rawEpisode.endGeneration === null || Number.isInteger(rawEpisode.endGeneration)) ||
      !Array.isArray(rawEpisode.generations) ||
      !nullableString(rawEpisode.reason) ||
      typeof rawEpisode.startedAt !== "string" ||
      typeof rawEpisode.updatedAt !== "string" ||
      !nullableString(rawEpisode.finishedAt)
    ) {
      return null;
    }
    const episodeGenerations = rawEpisode.generations.map((generation) => parseGeneration(generation));
    if (episodeGenerations.some((generation) => generation === null)) return null;
    const episodeChampion = parseChampion(rawEpisode.champion);
    if (episodeChampion === undefined) return null;
    episodes.push({
      ...(rawEpisode as unknown as EvolutionEpisodeSnapshot),
      generations: episodeGenerations as EvolutionGenerationSnapshot[],
      champion: episodeChampion,
    });
  }

  return {
    ...(value as unknown as EvolutionSessionSnapshot),
    episodes,
    generations: generations as EvolutionGenerationSnapshot[],
    champion,
  };
};

const migrateV1 = (value: Record<string, unknown>): EvolutionSessionSnapshot | null => {
  if (
    value.schemaVersion !== 1 ||
    typeof value.sessionId !== "string" ||
    !nullableString(value.projectId) ||
    !isSnapshotStatus(value.status) ||
    !isSeedSnapshot(value.seed) ||
    !Array.isArray(value.generations) ||
    !nullableString(value.reason) ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !nullableString(value.finishedAt)
  ) {
    return null;
  }

  const generations = value.generations.map((generation) =>
    parseGeneration(generation, { allowMissingMetadata: true }),
  );
  if (generations.some((generation) => generation === null)) return null;
  const champion = parseChampion(value.champion, { allowMissingMetadata: true });
  if (champion === undefined) return null;
  const normalizedGenerations = generations as EvolutionGenerationSnapshot[];
  const startGeneration = normalizedGenerations[0]?.generation ?? 1;
  const endGeneration = normalizedGenerations.at(-1)?.generation ?? null;
  const episode: EvolutionEpisodeSnapshot = {
    episodeId: "episode-1",
    index: 1,
    status: value.status,
    seed: value.seed,
    startGeneration,
    endGeneration,
    generations: normalizedGenerations,
    champion,
    reason: value.reason,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: value.finishedAt,
  };

  return {
    schemaVersion: EVOLUTION_SESSION_SCHEMA_VERSION,
    sessionId: value.sessionId,
    projectId: value.projectId,
    status: value.status,
    seed: value.seed,
    episodes: [episode],
    generations: normalizedGenerations,
    champion,
    reason: value.reason,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    finishedAt: value.finishedAt,
  };
};

export function parseEvolutionSessionSnapshot(value: unknown): EvolutionSessionSnapshot | null {
  if (!isRecord(value)) return null;
  return value.schemaVersion === 1 ? migrateV1(value) : parseV2(value);
}

export function parseEvolutionSessionSnapshotContent(content: string) {
  try {
    return parseEvolutionSessionSnapshot(JSON.parse(content));
  } catch {
    return null;
  }
}

export const getEvolutionSessionArtifact = (artifacts: SessionArtifact[]) =>
  artifacts.find((artifact) => artifact.fileName === EVOLUTION_SESSION_FILE_NAME) ?? null;

export const getEvolutionSessionSnapshot = (artifacts: SessionArtifact[]) => {
  const artifact = getEvolutionSessionArtifact(artifacts);
  return artifact ? parseEvolutionSessionSnapshotContent(artifact.content) : null;
};

const artifactIdForSession = (sessionId: string) => `tycho-evolution-session:${sessionId}`;

export function upsertEvolutionSessionArtifact(
  artifacts: SessionArtifact[],
  snapshot: EvolutionSessionSnapshot,
): SessionArtifact[] {
  const now = snapshot.updatedAt;
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const current = getEvolutionSessionArtifact(artifacts);
  const artifact: SessionArtifact = {
    id: current?.id ?? artifactIdForSession(snapshot.sessionId),
    title: EVOLUTION_SESSION_TITLE,
    artifactType: "file",
    semanticType: "evidence",
    blobRef: null,
    byteSize: new TextEncoder().encode(content).byteLength,
    content,
    fileName: EVOLUTION_SESSION_FILE_NAME,
    language: "json",
    mimeType: "application/json",
    position: current?.position ?? null,
    sourceDataUrl: null,
    promptStatus: null,
    promptResult: null,
    promptError: null,
    promptRunId: null,
    promptModel: null,
    promptProvider: null,
    promptStartedAt: null,
    promptCompletedAt: null,
    syncMode: "paused",
    revisions: [],
    createdAt: current?.createdAt ?? snapshot.startedAt,
    updatedAt: now,
  };
  return current
    ? artifacts.map((entry) => (entry.id === current.id ? artifact : entry))
    : [...artifacts, artifact];
}

export function snapshotEvolutionAttempt(
  attempt: EvolutionAttempt<TychoEvolutionSpec, TychoEvolutionExecution>,
  winnerKey: string | null,
): EvolutionCandidateSnapshot {
  return {
    candidateId: attempt.candidate.id,
    candidateKey: attempt.candidate.key,
    decision: attempt.execution?.result.decision ?? null,
    error: attempt.error,
    evidence: attempt.evaluation?.evidence ?? null,
    experimentId: attempt.candidate.spec.experimentId,
    generation: attempt.candidate.generation,
    index: attempt.index,
    isWinner: attempt.candidate.key === winnerKey,
    metadata: attempt.candidate.metadata ?? null,
    metrics: attempt.evaluation?.metrics ?? null,
    parentKey: attempt.candidate.parentKey,
    runId: attempt.execution?.run.runId ?? null,
    score: attempt.evaluation?.score ?? null,
    status: attempt.status,
  };
}

export function snapshotEvolutionGeneration(
  generation: EvolutionGeneration<TychoEvolutionSpec, TychoEvolutionExecution>,
): EvolutionGenerationSnapshot {
  const winnerKey = generation.winner?.candidate.key ?? null;
  return {
    attempts: generation.attempts.map((attempt) => snapshotEvolutionAttempt(attempt, winnerKey)),
    error: generation.error,
    generation: generation.generation,
    parentKey: generation.parent.key,
    requestedPopulation: generation.requestedPopulation,
    status: generation.status,
    winnerKey,
  };
}

export function snapshotEvolutionChampion(
  attempt: EvolutionAttempt<TychoEvolutionSpec, TychoEvolutionExecution> | null,
): EvolutionChampionSnapshot | null {
  if (!attempt) return null;
  return {
    ...snapshotEvolutionAttempt(attempt, attempt.candidate.key),
    spec: attempt.candidate.spec,
  };
}
