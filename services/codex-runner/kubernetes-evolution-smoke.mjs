import { readFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.env.TYCHO_EVOLUTION_RUNNER_URL || "http://127.0.0.1:8788").trim().replace(/\/+$/, "");
const token = process.env.CODEX_RUNNER_TOKEN?.trim() || null;
const workspaceId = process.env.NODES_EVOLUTION_SMOKE_WORKSPACE_ID?.trim() || "";
const ownerId = process.env.NODES_EVOLUTION_SMOKE_OWNER_ID?.trim() || "m2-kubernetes-smoke";
const projectId = process.env.NODES_EVOLUTION_SMOKE_PROJECT_ID?.trim() || null;
const sessionId = process.env.NODES_EVOLUTION_SMOKE_SESSION_ID?.trim() || `m2-smoke-${Date.now()}`;
const protocolPath = path.resolve(process.env.NODES_EVOLUTION_SMOKE_PROTOCOL_FILE?.trim() || ".nodes/tycho-experiment.json");
const generations = Number(process.env.NODES_EVOLUTION_SMOKE_GENERATIONS || 1);
const populationSize = Number(process.env.NODES_EVOLUTION_SMOKE_POPULATION || 2);
const timeoutMs = Number(process.env.NODES_EVOLUTION_SMOKE_TIMEOUT_MS || 900_000);
const pollMs = Number(process.env.NODES_EVOLUTION_SMOKE_POLL_MS || 1_000);

const assertPositiveInteger = (value, label) => {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
};
if (!workspaceId) throw new Error("NODES_EVOLUTION_SMOKE_WORKSPACE_ID is required.");
assertPositiveInteger(generations, "NODES_EVOLUTION_SMOKE_GENERATIONS");
assertPositiveInteger(populationSize, "NODES_EVOLUTION_SMOKE_POPULATION");
assertPositiveInteger(timeoutMs, "NODES_EVOLUTION_SMOKE_TIMEOUT_MS");
assertPositiveInteger(pollMs, "NODES_EVOLUTION_SMOKE_POLL_MS");

const protocol = JSON.parse(await readFile(protocolPath, "utf8"));
if (!protocol || typeof protocol !== "object" || protocol.schemaVersion !== 1 || typeof protocol.experimentId !== "string" || !protocol.experimentId.trim()) {
  throw new Error("Smoke protocol must be Tycho schemaVersion 1 with experimentId.");
}

const headers = (extra = {}) => ({
  ...extra,
  "x-nodes-owner-id": ownerId,
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
const requestJson = async (pathname, init = {}) => {
  const response = await fetch(`${baseUrl}${pathname}`, { ...init, headers: headers(init.headers) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : `${init.method || "GET"} ${pathname} failed with ${response.status}.`);
  return body;
};

const readiness = await requestJson("/readyz");
if (readiness.executionBackend !== "kubernetes" || readiness.kubernetesReady !== true) {
  throw new Error(`Kubernetes evolution backend is not ready: ${JSON.stringify(readiness)}`);
}
if (readiness.kagentReady !== true) {
  throw new Error("kagent Agent CRDs are not installed/visible to the runner.");
}
if (!Array.isArray(readiness.workspaceIds) || !readiness.workspaceIds.includes(workspaceId)) {
  throw new Error(`Workspace ${workspaceId} is not configured for Kubernetes execution.`);
}

const seedId = `seed-${protocol.experimentId}`;
let snapshot = await requestJson("/v1/evolution/episodes", {
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
    seed: { id: seedId, spec: { experimentId: protocol.experimentId, protocol }, metadata: { smoke: "m2-kubernetes" } },
  }),
});
if (typeof snapshot.runId !== "string" || !snapshot.runId) throw new Error("Durable Kubernetes runner did not return runId.");

const runId = snapshot.runId;
const deadline = Date.now() + timeoutMs;
let cancelling = false;
const cancel = async () => {
  if (cancelling) return;
  cancelling = true;
  await requestJson(`/v1/evolution/episodes/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).catch(() => null);
};
process.once("SIGINT", () => { void cancel().finally(() => process.exit(130)); });
process.once("SIGTERM", () => { void cancel().finally(() => process.exit(143)); });

console.log(`[m2-k8s-smoke] started ${runId} (${generations} generation(s), population ${populationSize})`);
while (snapshot.status === "queued" || snapshot.status === "running") {
  if (Date.now() >= deadline) {
    await cancel();
    throw new Error(`Kubernetes evolution smoke timed out after ${timeoutMs}ms.`);
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs));
  snapshot = await requestJson(`/v1/evolution/episodes/${encodeURIComponent(runId)}`);
  console.log(`[m2-k8s-smoke] ${snapshot.status}/${snapshot.phase} checkpointed=${snapshot.completedGenerations}/${snapshot.requestedGenerations}`);
}

if (snapshot.status !== "completed") throw new Error(`Kubernetes evolution smoke ended ${snapshot.status}: ${snapshot.reason || "no reason"}`);
if (snapshot.completedGenerations !== generations) throw new Error(`Expected ${generations} generations, got ${snapshot.completedGenerations}.`);
if (!snapshot.champion || typeof snapshot.champion.score !== "number" || !Number.isFinite(snapshot.champion.score)) {
  throw new Error("Kubernetes evolution completed without a finite champion score.");
}
for (const generation of snapshot.generations || []) {
  if (generation.status !== "completed" || !generation.winnerKey) throw new Error(`Generation ${generation.generation} has no winner.`);
  if (!Array.isArray(generation.attempts) || generation.attempts.length !== populationSize) throw new Error(`Generation ${generation.generation} population mismatch.`);
  for (const attempt of generation.attempts.filter((item) => item.status === "succeeded")) {
    if (attempt.evidence?.sandbox?.runtime !== "kubernetes") {
      throw new Error(`Candidate ${attempt.candidateKey} did not return Kubernetes sandbox evidence.`);
    }
  }
}

console.log(`[m2-k8s-smoke] PASS champion=${snapshot.champion.candidateKey} score=${snapshot.champion.score} generations=${snapshot.completedGenerations}`);
