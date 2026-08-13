import { NextResponse } from "next/server";

import { startDurableTychoEvolution } from "@/lib/server/durable-tycho-evolution";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_GENERATIONS = 50;
const MAX_POPULATION = 12;
const MAX_CANDIDATE_TIMEOUT_MS = 86_400_000;
const MAX_GENERATOR_TIMEOUT_MS = 600_000;

const positiveInteger = (value: unknown, fallback: number, max: number, label: string) => {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return resolved;
};

type DurableEvolutionBody = {
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

  let body: DurableEvolutionBody;
  try {
    body = (await request.json()) as DurableEvolutionBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
    if (!sessionId) throw new Error("sessionId query parameter is required.");
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
    if (!workspaceId) throw new Error("workspaceId is required.");
    const projectId = typeof body.projectId === "string" && body.projectId.trim()
      ? body.projectId.trim()
      : null;
    const mode = body.mode === "continue"
      ? "continue"
      : body.mode === undefined || body.mode === "start"
        ? "start"
        : null;
    if (!mode) throw new Error('mode must be either "start" or "continue".');

    const generations = positiveInteger(body.generations, 4, MAX_GENERATIONS, "generations");
    const populationSize = positiveInteger(body.populationSize, 3, MAX_POPULATION, "populationSize");
    const candidateTimeoutMs = positiveInteger(
      body.candidateTimeoutMs,
      75_000,
      MAX_CANDIDATE_TIMEOUT_MS,
      "candidateTimeoutMs",
    );
    const generatorTimeoutMs = positiveInteger(
      body.generatorTimeoutMs,
      45_000,
      MAX_GENERATOR_TIMEOUT_MS,
      "generatorTimeoutMs",
    );

    const started = await startDurableTychoEvolution({
      ownerId: guarded.user.id,
      sessionId,
      projectId,
      workspaceId,
      generations,
      populationSize,
      candidateTimeoutMs,
      generatorTimeoutMs,
      mode,
    });

    return NextResponse.json(
      {
        run: started.run,
        snapshot: started.snapshot,
      },
      { status: 202 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start durable evolution.";
    const conflict = /already|continuation requires|cannot change|reconnect/i.test(message);
    return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
  }
}
