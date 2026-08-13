import type { CodexWorkspaceFile } from "@/lib/agents/codex/types";
import type { EvolutionEvaluation, EvolutionResumePoint, TychoVariant } from "@/lib/tycho-evolution-loop";
import type { TychoEvolutionSpec } from "@/lib/tycho/evolution-backend";
import type {
  EvolutionChampionSnapshot,
  EvolutionGenerationSnapshot,
} from "@/lib/tycho/evolution-session-snapshot";

export type TychoEvolutionDecision = "promote" | "reject" | "blocked";
export type TychoEvolutionRunStatus = "running" | "completed" | "failed" | "cancelled";

export type TychoEvolutionRunSnapshot = {
  runId: string;
  workspaceId: string;
  projectId: string | null;
  sessionId: string | null;
  candidateKey: string;
  experimentId: string;
  status: TychoEvolutionRunStatus;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type TychoEvolutionResult = {
  schemaVersion: 1;
  experimentId: string;
  objective?: string;
  decision: TychoEvolutionDecision;
  sandbox: { runtime: "docker" | "finch"; image?: string | null };
  budget?: {
    maxSteps?: number;
    stepsUsed?: number;
    maxWallSeconds?: number;
    wallSeconds?: number;
    stopReason?: string | null;
  };
  summary: {
    stepCount: number;
    executedSteps: number;
    passedSteps: number;
    failedSteps: number;
    blockedSteps: number;
    requireAllSteps?: boolean;
    minPassedSteps?: number;
  };
  steps: unknown[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

export type StartTychoEvolutionRunInput = {
  ownerId: string;
  workspaceId: string;
  projectId?: string | null;
  sessionId?: string | null;
  candidateKey: string;
  experimentId: string;
  workspaceFiles: CodexWorkspaceFile[];
};

export type DurableEvolutionRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type DurableEvolutionRunPhase =
  | "queued"
  | "recovering"
  | "generating"
  | "executing_generation"
  | "checkpointed"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export type DurableEvolutionRunSnapshot = {
  schemaVersion: 1;
  runId: string;
  sessionId: string;
  projectId: string | null;
  workspaceId: string;
  episodeIndex: number;
  status: DurableEvolutionRunStatus;
  phase: DurableEvolutionRunPhase;
  requestedGenerations: number;
  populationSize: number;
  startGeneration: number;
  nextGeneration: number;
  completedGenerations: number;
  generations: EvolutionGenerationSnapshot[];
  champion: EvolutionChampionSnapshot | null;
  reason: string | null;
  activeGeneratorRunId: string | null;
  activeCandidateRunIds: string[];
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

export type StartDurableEvolutionRunInput = {
  ownerId: string;
  sessionId: string;
  projectId?: string | null;
  workspaceId: string;
  episodeIndex: number;
  generations: number;
  populationSize: number;
  candidateTimeoutMs?: number;
  generatorTimeoutMs?: number;
  pollIntervalMs?: number;
  seed: TychoVariant<TychoEvolutionSpec>;
  resumeFrom?: EvolutionResumePoint<TychoEvolutionSpec>;
};

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const getRunnerConfig = () => {
  const rawUrl = process.env.TYCHO_EVOLUTION_RUNNER_URL?.trim();
  if (!rawUrl) throw new Error("TYCHO_EVOLUTION_RUNNER_URL is not configured.");

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(new URL(rawUrl).toString());
  } catch {
    throw new Error("TYCHO_EVOLUTION_RUNNER_URL must be a valid absolute URL.");
  }

  return {
    baseUrl,
    token: process.env.CODEX_RUNNER_TOKEN?.trim() || null,
  };
};

const buildHeaders = (ownerId: string, init?: HeadersInit) => {
  const { token } = getRunnerConfig();
  const headers = new Headers(init);
  headers.set("x-nodes-owner-id", ownerId);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
};

async function runnerFetch(ownerId: string, path: string, init?: RequestInit) {
  const { baseUrl } = getRunnerConfig();
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: buildHeaders(ownerId, init?.headers),
    cache: "no-store",
  });
}

async function readError(response: Response) {
  const fallback = `Tycho evolution runner request failed: ${response.status}`;
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error.trim() ? body.error.trim() : fallback;
}

export async function startTychoEvolutionRun(
  input: StartTychoEvolutionRunInput,
): Promise<TychoEvolutionRunSnapshot> {
  const response = await runnerFetch(input.ownerId, "/v1/evolution/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as TychoEvolutionRunSnapshot;
}

export async function getTychoEvolutionRun(ownerId: string, runId: string) {
  const response = await runnerFetch(ownerId, `/v1/evolution/runs/${encodeURIComponent(runId)}`, {
    method: "GET",
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as TychoEvolutionRunSnapshot;
}

export async function getTychoEvolutionResult(ownerId: string, runId: string) {
  const response = await runnerFetch(
    ownerId,
    `/v1/evolution/runs/${encodeURIComponent(runId)}/result`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as {
    run: TychoEvolutionRunSnapshot;
    result: TychoEvolutionResult;
  };
}

export async function cancelTychoEvolutionRun(ownerId: string, runId: string) {
  const response = await runnerFetch(
    ownerId,
    `/v1/evolution/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as TychoEvolutionRunSnapshot;
}

export async function startDurableEvolutionRun(
  input: StartDurableEvolutionRunInput,
): Promise<DurableEvolutionRunSnapshot> {
  const response = await runnerFetch(input.ownerId, "/v1/evolution/episodes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as DurableEvolutionRunSnapshot;
}

export async function getDurableEvolutionRun(ownerId: string, runId: string) {
  const response = await runnerFetch(
    ownerId,
    `/v1/evolution/episodes/${encodeURIComponent(runId)}`,
    { method: "GET" },
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as DurableEvolutionRunSnapshot;
}

export async function cancelDurableEvolutionRun(ownerId: string, runId: string) {
  const response = await runnerFetch(
    ownerId,
    `/v1/evolution/episodes/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as DurableEvolutionRunSnapshot;
}

export type { EvolutionEvaluation };
