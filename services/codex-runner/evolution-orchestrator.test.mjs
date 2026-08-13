import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDurableEvolutionOrchestrator } from "./evolution-orchestrator.mjs";

const ownerId = "owner-test";
const protocol = (experimentId) => ({ schemaVersion: 1, experimentId, objective: experimentId });
const variant = (id, experimentId) => ({ id, spec: { experimentId, protocol: protocol(experimentId) } });

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test condition.");
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

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function startFakeEvolutionServer({ holdRuns = false } = {}) {
  const runs = new Map();
  let cancelled = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/evolution/runs") {
      const body = await readJson(req);
      const runId = `candidate-${runs.size + 1}`;
      runs.set(runId, {
        runId,
        status: holdRuns ? "running" : "completed",
        experimentId: body.experimentId,
        error: null,
      });
      return sendJson(res, 202, runs.get(runId));
    }
    const cancelMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const run = runs.get(cancelMatch[1]);
      if (!run) return sendJson(res, 404, { error: "not found" });
      run.status = "cancelled";
      run.error = "cancelled";
      cancelled += 1;
      return sendJson(res, 200, run);
    }
    const resultMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/result$/);
    if (req.method === "GET" && resultMatch) {
      const run = runs.get(resultMatch[1]);
      if (!run) return sendJson(res, 404, { error: "not found" });
      const promote = run.experimentId.endsWith("-b");
      return sendJson(res, 200, {
        run,
        result: {
          schemaVersion: 1,
          experimentId: run.experimentId,
          decision: promote ? "promote" : "reject",
          sandbox: { runtime: "docker" },
          budget: { wallSeconds: 1 },
          summary: {
            stepCount: 2,
            executedSteps: 2,
            passedSteps: promote ? 2 : 1,
            failedSteps: promote ? 0 : 1,
            blockedSteps: 0,
          },
          steps: [],
        },
      });
    }
    const runMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const run = runs.get(runMatch[1]);
      return run ? sendJson(res, 200, run) : sendJson(res, 404, { error: "not found" });
    }
    return sendJson(res, 404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: address.port,
    cancelled: () => cancelled,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("durable orchestrator checkpoints generations and feeds winner reward forward", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-evolution-orchestrator-"));
  const fake = await startFakeEvolutionServer();
  const calls = [];
  const orchestrator = createDurableEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    generateVariants: async (input) => {
      calls.push({ generation: input.generation, parentKey: input.parent.key, parentEvaluation: input.parentEvaluation });
      return {
        generatorRunId: `generator-${input.generation}`,
        variants: [
          variant(`v${input.generation}a`, `exp-${input.generation}-a`),
          variant(`v${input.generation}b`, `exp-${input.generation}-b`),
        ],
      };
    },
  });

  try {
    const started = await orchestrator.start({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      episodeIndex: 1,
      generations: 2,
      populationSize: 2,
      candidateTimeoutMs: 2_000,
      generatorTimeoutMs: 2_000,
      seed: variant("seed", "seed-exp"),
    }, ownerId);

    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, ownerId);
      return current?.status === "completed" ? current : null;
    });
    assert.equal(completed.completedGenerations, 2);
    assert.equal(completed.generations[0].generation, 1);
    assert.equal(completed.generations[1].generation, 2);
    assert.equal(completed.generations[0].winnerKey, "g1:v1b");
    assert.equal(completed.generations[1].winnerKey, "g2:v2b");
    assert.equal(completed.champion.candidateKey, "g2:v2b");
    assert.equal(calls[0].parentEvaluation, null);
    assert.equal(calls[1].parentKey, "g1:v1b");
    assert.ok(calls[1].parentEvaluation.score > 2);

    const state = JSON.parse(await readFile(path.join(stateDir, `${started.runId}.json`), "utf8"));
    assert.equal(state.status, "completed");
    assert.equal(state.generations.length, 2);

    const recovered = createDurableEvolutionOrchestrator({
      stateDir,
      evolutionPort: fake.port,
      generateVariants: async () => { throw new Error("terminal run must not restart"); },
    });
    await recovered.recover();
    const recoveredRun = await recovered.get(started.runId, ownerId);
    assert.equal(recoveredRun.status, "completed");
    assert.equal(recoveredRun.champion.candidateKey, "g2:v2b");
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("durable orchestrator cancellation propagates to active Tycho child runs", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-evolution-cancel-"));
  const fake = await startFakeEvolutionServer({ holdRuns: true });
  const orchestrator = createDurableEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    generateVariants: async () => ({
      generatorRunId: "generator-1",
      variants: [variant("one", "exp-one")],
    }),
  });

  try {
    const started = await orchestrator.start({
      sessionId: "session-2",
      workspaceId: "workspace-1",
      episodeIndex: 1,
      generations: 1,
      populationSize: 1,
      pollIntervalMs: 10,
      candidateTimeoutMs: 2_000,
      generatorTimeoutMs: 2_000,
      seed: variant("seed", "seed-exp"),
    }, ownerId);

    await waitFor(async () => {
      const current = await orchestrator.get(started.runId, ownerId);
      return current?.activeCandidateRunIds.length ? current : null;
    });
    await orchestrator.cancel(started.runId, ownerId);
    const cancelled = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, ownerId);
      return current?.status === "cancelled" ? current : null;
    });
    assert.equal(cancelled.phase, "cancelled");
    assert.ok(fake.cancelled() >= 1);
  } finally {
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});