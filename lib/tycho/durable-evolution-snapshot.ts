import type { SessionArtifact } from "@/lib/session-artifacts";
import type {
  DurableEvolutionRunPhase,
  DurableEvolutionRunSnapshot,
  DurableEvolutionRunStatus,
} from "@/lib/tycho/evolution-runner-client";

export const DURABLE_EVOLUTION_SCHEMA_VERSION = 1 as const;
export const DURABLE_EVOLUTION_FILE_NAME = ".nodes/evolution-run.json";
export const DURABLE_EVOLUTION_TITLE = "Evolution Run";

export type DurableEvolutionLifecycleSnapshot = {
  schemaVersion: typeof DURABLE_EVOLUTION_SCHEMA_VERSION;
  sessionId: string;
  runId: string;
  episodeIndex: number;
  workspaceId: string;
  status: DurableEvolutionRunStatus;
  phase: DurableEvolutionRunPhase;
  requestedGenerations: number;
  populationSize: number;
  startGeneration: number;
  completedGenerations: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStatus = (value: unknown): value is DurableEvolutionRunStatus =>
  value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "cancelled";

const isPhase = (value: unknown): value is DurableEvolutionRunPhase =>
  value === "queued" ||
  value === "recovering" ||
  value === "generating" ||
  value === "executing_generation" ||
  value === "checkpointed" ||
  value === "cancelling" ||
  value === "completed" ||
  value === "failed" ||
  value === "cancelled";

export function parseDurableEvolutionLifecycleSnapshot(
  value: unknown,
): DurableEvolutionLifecycleSnapshot | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DURABLE_EVOLUTION_SCHEMA_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.runId !== "string" ||
    !Number.isInteger(value.episodeIndex) ||
    typeof value.workspaceId !== "string" ||
    !isStatus(value.status) ||
    !isPhase(value.phase) ||
    !Number.isInteger(value.requestedGenerations) ||
    !Number.isInteger(value.populationSize) ||
    !Number.isInteger(value.startGeneration) ||
    !Number.isInteger(value.completedGenerations) ||
    !(value.reason === null || typeof value.reason === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.finishedAt === null || typeof value.finishedAt === "string")
  ) {
    return null;
  }
  return value as unknown as DurableEvolutionLifecycleSnapshot;
}

export function parseDurableEvolutionLifecycleContent(content: string) {
  try {
    return parseDurableEvolutionLifecycleSnapshot(JSON.parse(content));
  } catch {
    return null;
  }
}

export const getDurableEvolutionLifecycleArtifact = (artifacts: SessionArtifact[]) =>
  artifacts.find((artifact) => artifact.fileName === DURABLE_EVOLUTION_FILE_NAME) ?? null;

export const getDurableEvolutionLifecycleSnapshot = (artifacts: SessionArtifact[]) => {
  const artifact = getDurableEvolutionLifecycleArtifact(artifacts);
  return artifact ? parseDurableEvolutionLifecycleContent(artifact.content) : null;
};

export function lifecycleFromRunner(
  run: DurableEvolutionRunSnapshot,
): DurableEvolutionLifecycleSnapshot {
  return {
    schemaVersion: DURABLE_EVOLUTION_SCHEMA_VERSION,
    sessionId: run.sessionId,
    runId: run.runId,
    episodeIndex: run.episodeIndex,
    workspaceId: run.workspaceId,
    status: run.status,
    phase: run.phase,
    requestedGenerations: run.requestedGenerations,
    populationSize: run.populationSize,
    startGeneration: run.startGeneration,
    completedGenerations: run.completedGenerations,
    reason: run.reason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

const artifactIdForSession = (sessionId: string) => `tycho-evolution-run:${sessionId}`;

export function upsertDurableEvolutionLifecycleArtifact(
  artifacts: SessionArtifact[],
  snapshot: DurableEvolutionLifecycleSnapshot,
): SessionArtifact[] {
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const current = getDurableEvolutionLifecycleArtifact(artifacts);
  const artifact: SessionArtifact = {
    id: current?.id ?? artifactIdForSession(snapshot.sessionId),
    title: DURABLE_EVOLUTION_TITLE,
    artifactType: "file",
    semanticType: "evidence",
    blobRef: null,
    byteSize: new TextEncoder().encode(content).byteLength,
    content,
    fileName: DURABLE_EVOLUTION_FILE_NAME,
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
    createdAt: current?.createdAt ?? snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
  };
  return current
    ? artifacts.map((entry) => (entry.id === current.id ? artifact : entry))
    : [...artifacts, artifact];
}
