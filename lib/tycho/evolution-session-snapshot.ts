import type { SessionArtifact } from "@/lib/session-artifacts";
import type {
  EvolutionAttempt,
  EvolutionGeneration,
} from "@/lib/tycho-evolution-loop";
import type {
  TychoEvolutionExecution,
  TychoEvolutionSpec,
} from "@/lib/tycho/evolution-backend";

export const EVOLUTION_SESSION_SCHEMA_VERSION = 1 as const;
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

export type EvolutionSessionSnapshot = {
  schemaVersion: typeof EVOLUTION_SESSION_SCHEMA_VERSION;
  sessionId: string;
  projectId: string | null;
  status: "running" | "completed" | "failed";
  seed: {
    candidateId: string;
    candidateKey: string;
    experimentId: string;
  };
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

const isCandidateSnapshot = (value: unknown): value is EvolutionCandidateSnapshot => {
  if (!isRecord(value)) return false;
  const error = value.error;
  const validError =
    error === null ||
    (isRecord(error) &&
      typeof error.message === "string" &&
      (error.stage === "execution" || error.stage === "evaluation"));
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
    numericRecordOrNull(value.metrics) &&
    nullableString(value.parentKey) &&
    nullableString(value.runId) &&
    finiteOrNull(value.score) &&
    isAttemptStatus(value.status)
  );
};

export function parseEvolutionSessionSnapshot(value: unknown): EvolutionSessionSnapshot | null {
  if (!isRecord(value) || value.schemaVersion !== EVOLUTION_SESSION_SCHEMA_VERSION) return null;
  if (
    typeof value.sessionId !== "string" ||
    !nullableString(value.projectId) ||
    !isSnapshotStatus(value.status) ||
    !Array.isArray(value.generations) ||
    !nullableString(value.reason) ||
    typeof value.startedAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !nullableString(value.finishedAt)
  ) {
    return null;
  }

  if (!isRecord(value.seed)) return null;
  if (
    typeof value.seed.candidateId !== "string" ||
    typeof value.seed.candidateKey !== "string" ||
    typeof value.seed.experimentId !== "string"
  ) {
    return null;
  }

  const generations = value.generations as unknown[];
  for (const generation of generations) {
    if (
      !isRecord(generation) ||
      !Array.isArray(generation.attempts) ||
      !generation.attempts.every(isCandidateSnapshot) ||
      !nullableString(generation.error) ||
      !Number.isInteger(generation.generation) ||
      typeof generation.parentKey !== "string" ||
      !Number.isInteger(generation.requestedPopulation) ||
      !isGenerationStatus(generation.status) ||
      !nullableString(generation.winnerKey)
    ) {
      return null;
    }
  }

  if (value.champion !== null) {
    const championSpec = isRecord(value.champion) ? value.champion.spec : null;
    if (!isCandidateSnapshot(value.champion) || !isRecord(championSpec)) return null;
    if (
      typeof championSpec.experimentId !== "string" ||
      !isRecord(championSpec.protocol)
    ) {
      return null;
    }
  }

  return value as EvolutionSessionSnapshot;
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
