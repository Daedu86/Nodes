import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableEvolutionOrchestrator } from "./evolution-orchestrator.mjs";

const ownerId = "owner-hardening";
const protocol = (experimentId) => ({ schemaVersion: 1, experimentId });
const variant = (id) => ({ id, spec: { experimentId: `exp-${id}`, protocol: protocol(`exp-${id}`) } });

const waitFor = async (predicate, timeoutMs = 4_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for durable evolution state.");
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const readJson = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
    catch (error) { reject(error); }
  });
  req.on("error", reject);
});

async function startConcurrencyServer() {
  const runs = new Map();
  let sequence = 0;
  let active = 0;
  let maxActive = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/evolution/runs") {
      const body = await readJson(req);
      const runId = `run-${++sequence}`;
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs.set(runId, {
        runId,
        experimentId: body.experimentId,
        status: "running",
        readyAt: Date.now() + 35,
        released: false,
      });
      return json(res, 202, { runId, status: "running", error: null });
    }
    const resultMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/result$/);
    if (req.method === "GET" && resultMatch) {
      const run = runs.get(resultMatch[1]);
      if (!run) return json(res, 404, { error: "not found" });
      return json(res, 200, {
        run: { runId: run.runId, status: "completed" },
        result: {
          schemaVersion: 1,
          experimentId: run.experimentId,
          decision: "promote",
          sandbox: { runtime: "docker" },
          budget: { wallSeconds: 1 },
          summary: { stepCount: 1, executedSteps: 1, passedSteps: 1, failedSteps: 0, blockedSteps: 0 },
          steps: [],
        },
      });
    }
    const runMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) return json(res, 404, { error: "not found" });
      if (run.status === "running" && Date.now() >= run.readyAt) {
        run.status = "completed";
        if (!run.released) {
          run.released = true;
          active -= 1;
        }
      }
      return json(res, 200, { runId: run.runId, status: run.status, error: null });
    }
    return json(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    maxActive: () => maxActive,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("population larger than runner concurrency is queued instead of over-subscribed", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-evolution-concurrency-"));
  const fake = await startConcurrencyServer();
  const orchestrator = createDurableEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    candidateConcurrency: 2,
    generateVariants: async () => ({
      generatorRunId: "generator-1",
      variants: ["a", "b", "c", "d", "e", "f"].map(variant),
    }),
  });

  try {
    const started = await orchestrator.start({
      sessionId: "session-concurrency",
      workspaceId: "workspace-1",
      episodeIndex: 1,
      generations: 1,
      populationSize: 6,
      pollIntervalMs: 5,
      candidateTimeoutMs: 2_000,
      generatorTimeoutMs: 2_000,
      seed: variant("seed"),
    }, ownerId);
    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, ownerId);
      return current?.status === "completed" ? current : null;
    });
    assert.equal(completed.generations[0].attempts.length, 6);
    assert.equal(completed.generations[0].attempts.filter((attempt) => attempt.status === "succeeded").length, 6);
    assert.ok(fake.maxActive() <= 2, `expected max active <= 2, got ${fake.maxActive()}`);
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("persisted cancellation intent becomes terminal cancelled during recovery", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-evolution-cancel-recover-"));
  await mkdir(stateDir, { recursive: true });
  const runId = "11111111-1111-4111-8111-111111111111";
  const now = new Date().toISOString();
  await writeFile(path.join(stateDir, `${runId}.json`), `${JSON.stringify({
    schemaVersion: 1,
    runId,
    ownerId,
    sessionId: "session-cancelled",
    projectId: null,
    workspaceId: "workspace-1",
    episodeIndex: 1,
    requestedGenerations: 4,
    populationSize: 2,
    candidateTimeoutMs: 2_000,
    generatorTimeoutMs: 2_000,
    pollIntervalMs: 10,
    maxOutputChars: 10_000,
    status: "running",
    phase: "cancelling",
    seed: variant("seed"),
    parent: { ...variant("seed"), generation: 0, key: "g0:seed", parentKey: null },
    parentEvaluation: null,
    startGeneration: 1,
    generations: [],
    champion: null,
    reason: null,
    activeGeneratorRunId: "generator-old",
    activeCandidateRunIds: ["candidate-old"],
    cancelRequested: true,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
  }, null, 2)}\n`, "utf8");

  let generated = false;
  const orchestrator = createDurableEvolutionOrchestrator({
    stateDir,
    evolutionPort: 9,
    generateVariants: async () => {
      generated = true;
      return { generatorRunId: "unexpected", variants: [] };
    },
  });

  try {
    await orchestrator.recover();
    const recovered = await orchestrator.get(runId, ownerId);
    assert.equal(recovered.status, "cancelled");
    assert.equal(recovered.phase, "cancelled");
    assert.equal(generated, false);
    assert.match(recovered.reason, /cancelled before runner recovery/i);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
