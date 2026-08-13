import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.TYCHO_EVOLUTION_RUNNER_URL || "").trim().replace(/\/+$/, "");
const token = process.env.CODEX_RUNNER_TOKEN?.trim() || null;
const workspaceId = process.env.NODES_EVOLUTION_SMOKE_WORKSPACE_ID?.trim() || "";
const ownerId = process.env.NODES_EVOLUTION_SMOKE_OWNER_ID?.trim() || "m1-durable-smoke";
const projectId = process.env.NODES_EVOLUTION_SMOKE_PROJECT_ID?.trim() || null;
const sessionId = process.env.NODES_EVOLUTION_SMOKE_SESSION_ID?.trim() || `smoke-${Date.now()}`;
const protocolPath = path.resolve(
  process.env.NODES_EVOLUTION_SMOKE_PROTOCOL_FILE?.trim() || ".nodes/tycho-experiment.json",
);
const generations = Number(process.env.NODES_EVOLUTION_SMOKE_GENERATIONS || 1);
const populationSize = Number(process.env.NODES_EVOLUTION_SMOKE_POPULATION || 2);
const timeoutMs = Number(process.env.NODES_EVOLUTION_SMOKE_TIMEOUT_MS || 600_000);
const pollMs = Number(process.env.NODES_EVOLUTION_SMOKE_POLL_MS || 1_000);

const assertPositiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
};

if (!baseUrl) throw new Error("TYCHO_EVOLUTION_RUNNER_URL is required.");
if (!workspaceId) throw new Error("NODES_EVOLUTION_SMOKE_WORKSPACE_ID is required.");
assertPositiveInteger(generations, "NODES_EVOLUTION_SMOKE_GENERATIONS");
assertPositiveInteger(populationSize, "NODES_EVOLUTION_SMOKE_POPULATION");
assertPositiveInteger(timeoutMs, "NODES_EVOLUTION_SMOKE_TIMEOUT_MS");
assertPositiveInteger(pollMs, "NODES_EVOLUTION_SMOKE_POLL_MS");

const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
if (!protocol || typeof protocol !== "object" || protocol.schemaVersion !== 1) {
  throw new Error("Smoke protocol must be a Tycho schemaVersion 1 object.");
}
if (typeof protocol.experimentId !== "string" || !protocol.experimentId.trim()) {
  throw new Error("Smoke protocol requires experimentId.");
}

const headers = (extra = {}) => ({
  ...extra,
  "x-nodes-owner-id": ownerId,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

const requestJson = async (pathname, init = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: headers(init.headers),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" && body.error.trim()
        ? body.error.trim()
        : `${init.method || "GET"} ${pathname} failed with ${response.status}.`,
    );
  }
  return body;
};

const readiness = await requestJson("/readyz");
if (readiness.durableEvolution !== true || readiness.tychoReady !== true) {
  throw new Error(`Runner is not ready for durable Tycho evolution: ${JSON.stringify(readiness)}`);
}
if (Array.isArray(readiness.workspaceIds) && !readiness.workspaceIds.includes(workspaceId)) {
  throw new Error(`Workspace ${workspaceId} is not present in the runner allowlist.`);
}

const seedId = `seed-${protocol.experimentId}`;
const started = await requestJson("/v1/evolution/episodes", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ownerId,
    sessionId,
    projectId,
    workspaceId,
    episodeIndex: 1,
    generations,
    populationSize,
    seed: {
      id: seedId,
      spec: {
        experimentId: protocol.experimentId,
        protocol,
      },
      metadata: { smoke: true },
    },
  }),
});

if (typeof started.runId !== "string" || !started.runId) {
  throw new Error("Durable runner did not return runId.");
}

const runId = started.runId;
let cancelled = false;
const cancel = async () => {
  if (cancelled) return;
  cancelled = true;
  await requestJson(`/v1/evolution/episodes/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).catch(() => null);
};
process.once("SIGINT", () => { void cancel().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void cancel().finally(() => process.exit(143)); });

console.log(`[m1-smoke] started durable episode ${runId} (${generations} generation(s), population ${populationSize})`);
const deadline = Date.now() + timeoutMs;
let snapshot = started;
while (snapshot.status === "queued" || snapshot.status === "running") {
  if (Date.now() >= deadline) {
    await cancel();
    throw new Error(`Durable evolution smoke timed out after ${timeoutMs}ms.`);
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  snapshot = await requestJson(`/v1/evolution/episodes/${encodeURIComponent(runId)}`);
  console.log(
    `[m1-smoke] ${snapshot.status}/${snapshot.phase} checkpointed=${snapshot.completedGenerations}/${snapshot.requestedGenerations} next=g${snapshot.nextGeneration}`,
  );
}

if (snapshot.status !== "completed") {
  throw new Error(`Durable evolution smoke ended ${snapshot.status}: ${snapshot.reason || "no reason"}`);
}
if (snapshot.completedGenerations !== generations) {
  throw new Error(`Expected ${generations} checkpointed generations, got ${snapshot.completedGenerations}.`);
}
if (!snapshot.champion || typeof snapshot.champion.score !== "number" || !Number.isFinite(snapshot.champion.score)) {
  throw new Error("Durable evolution smoke completed without a finite scored champion.");
}
if (!Array.isArray(snapshot.generations) || snapshot.generations.length !== generations) {
  throw new Error("Durable evolution smoke returned an inconsistent generation history.");
}
for (const generation of snapshot.generations) {
  if (generation.status !== "completed" || !generation.winnerKey) {
    throw new Error(`Generation ${generation.generation} did not complete with a winner.`);
  }
  if (!Array.isArray(generation.attempts) || generation.attempts.length !== populationSize) {
    throw new Error(`Generation ${generation.generation} did not preserve the requested population.`);
  }
}

console.log(
  `[m1-smoke] PASS champion=${snapshot.champion.candidateKey} score=${snapshot.champion.score} generations=${snapshot.completedGenerations}`,
);
