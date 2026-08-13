import { requireLocalApiUser } from "@/lib/server/request-guards";
import { runCodexTychoEvolution } from "@/lib/server/codex-tycho-evolution";
import { getSession } from "@/lib/session-store";
import { getEvolutionSessionSnapshot } from "@/lib/tycho/evolution-session-snapshot";
import type { TychoEvolutionSpec } from "@/lib/tycho/evolution-backend";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_GENERATIONS = 6;
const MAX_POPULATION = 12;
const MAX_CANDIDATE_TIMEOUT_MS = 120_000;
const MAX_GENERATOR_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BUDGET_MS = 240_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const positiveInteger = (value: unknown, fallback: number, max: number, label: string) => {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return resolved;
};

const boundedDuration = (value: unknown, fallback: number, max: number, label: string) => {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be a positive number no greater than ${max}.`);
  }
  return Math.trunc(resolved);
};

function protocolFromSessionArtifacts(artifacts: Awaited<ReturnType<typeof getSession>>["artifacts"]): TychoEvolutionSpec | null {
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

type EvolutionRunBody = {
  workspaceId?: unknown;
  projectId?: unknown;
  generations?: unknown;
  populationSize?: unknown;
  candidateTimeoutMs?: unknown;
  generatorTimeoutMs?: unknown;
  mode?: unknown;
};

export async function POST(request: Request) {
  const guarded = await requireLocalApiUser(request);
  if ("response" in guarded) return guarded.response;

  let body: EvolutionRunBody;
  try {
    body = (await request.json()) as EvolutionRunBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (!workspaceId) throw new Error("workspaceId is required.");
    const projectId = typeof body.projectId === "string" && body.projectId.trim()
      ? body.projectId.trim()
      : null;
    const mode = body.mode === "continue" ? "continue" : body.mode === undefined || body.mode === "start"
      ? "start"
      : null;
    if (!mode) throw new Error('mode must be either "start" or "continue".');
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
    if (!sessionId) throw new Error("sessionId query parameter is required.");

    const generations = positiveInteger(body.generations, 2, MAX_GENERATIONS, "generations");
    const populationSize = positiveInteger(body.populationSize, 3, MAX_POPULATION, "populationSize");
    const timeoutMs = boundedDuration(
      body.candidateTimeoutMs,
      75_000,
      MAX_CANDIDATE_TIMEOUT_MS,
      "candidateTimeoutMs",
    );
    const generatorTimeoutMs = boundedDuration(
      body.generatorTimeoutMs,
      45_000,
      MAX_GENERATOR_TIMEOUT_MS,
      "generatorTimeoutMs",
    );
    const theoreticalBudgetMs = generations * (timeoutMs + generatorTimeoutMs);
    if (theoreticalBudgetMs > MAX_REQUEST_BUDGET_MS) {
      throw new Error(
        `Requested evolution budget (${theoreticalBudgetMs}ms) exceeds the ${MAX_REQUEST_BUDGET_MS}ms request safety budget. Reduce generations or timeouts.`,
      );
    }

    const session = await getSession(sessionId, guarded.user.id);
    const existingSnapshot = getEvolutionSessionSnapshot(session.artifacts);
    if (existingSnapshot?.status === "running") {
      return Response.json(
        { error: "This Session already has an evolution episode running.", code: "evolution_running" },
        { status: 409 },
      );
    }

    if (mode === "start" && existingSnapshot) {
      return Response.json(
        {
          error: "This Session already has evolution history. Continue from its persisted champion instead.",
          code: "evolution_history_exists",
        },
        { status: 409 },
      );
    }
    if (mode === "continue" && !existingSnapshot) {
      return Response.json(
        {
          error: "Evolution continuation requires an existing persisted history.",
          code: "evolution_history_missing",
        },
        { status: 409 },
      );
    }

    let seed;
    if (mode === "continue") {
      const champion = existingSnapshot!.champion;
      if (!champion || champion.score === null) {
        return Response.json(
          {
            error: "Evolution continuation requires a persisted scored champion.",
            code: "evolution_champion_missing",
          },
          { status: 409 },
        );
      }
      seed = {
        id: champion.candidateId,
        spec: champion.spec,
        ...(champion.metadata ? { metadata: champion.metadata } : {}),
      };
    } else {
      const protocolSpec = protocolFromSessionArtifacts(session.artifacts);
      if (!protocolSpec) {
        throw new Error(
          "No .nodes/tycho-experiment.json artifact is available in this Session to use as the seed.",
        );
      }
      seed = {
        id: `seed-${protocolSpec.experimentId}`,
        spec: protocolSpec,
        metadata: { seedSource: "session-tycho-protocol" },
      };
    }

    const completed = await runCodexTychoEvolution({
      ownerId: guarded.user.id,
      sessionId,
      projectId: existingSnapshot?.projectId ?? projectId,
      workspaceId,
      generations,
      populationSize,
      seed,
      timeoutMs,
      continueFromChampion: mode === "continue",
      generatorOptions: { timeoutMs: generatorTimeoutMs },
    });

    const latestEpisode = completed.snapshot.episodes.at(-1) ?? null;
    return Response.json({
      status: completed.result.status,
      episode: latestEpisode
        ? {
            episodeId: latestEpisode.episodeId,
            index: latestEpisode.index,
            startGeneration: latestEpisode.startGeneration,
            endGeneration: latestEpisode.endGeneration,
          }
        : null,
      finalWinner:
        completed.result.status === "completed"
          ? {
              candidateKey: completed.result.finalWinner.candidate.key,
              score: completed.result.finalWinner.evaluation?.score ?? null,
            }
          : null,
      snapshot: completed.snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evolution run failed.";
    return Response.json({ error: message }, { status: 400 });
  }
}
