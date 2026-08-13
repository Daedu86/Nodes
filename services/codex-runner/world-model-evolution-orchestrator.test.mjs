import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCurriculumEvolutionOrchestrator } from "./curriculum-evolution-orchestrator.mjs";

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for M7 episode.");
};

function historical(id, reward, hypothesis) {
  return {
    trajectoryId: id,
    runId: `run-${id}`,
    sessionId: "history",
    workspaceId: "workspace-m7",
    episodeIndex: 1,
    generation: 1,
    stateKey: "decision=none|pass=unknown|blocked=unknown|speed=unknown",
    state: { decision: "none", passBand: "unknown", blockedBand: "unknown", speedBand: "unknown" },
    actionId: "exploit",
    actionMode: "observe",
    policyVersion: "history-v1",
    candidateKey: id,
    candidateMetadata: {
      hypothesis,
      rationale: hypothesis,
      learningPolicy: { actionId: "exploit", stateKey: "decision=none|pass=unknown|blocked=unknown|speed=unknown" },
      multiAgentTeam: { topologyId: "single" },
    },
    reward,
    metrics: { wallSeconds: reward > 0.7 ? 5 : 30 },
    nextState: { decision: reward > 0.7 ? "promote" : "reject", passBand: reward > 0.7 ? "high" : "low", blockedBand: "low", speedBand: "fast" },
    isWinner: reward > 0.7,
    status: "succeeded",
  };
}

function memoryStore(seed) {
  const values = [...seed];
  return {
    list: async (filter = {}) => values.filter((item) => !filter.workspaceId || item.workspaceId === filter.workspaceId),
    append: async (value) => { values.push(value); return value; },
    top: async (filter = {}, limit = 5) => values.filter((item) => (!filter.workspaceId || item.workspaceId === filter.workspaceId) && (!filter.stateKey || item.stateKey === filter.stateKey)).sort((a, b) => b.reward - a.reward).slice(0, limit),
    stats: async (filter = {}) => {
      const selected = values.filter((item) => !filter.workspaceId || item.workspaceId === filter.workspaceId);
      return { schemaVersion: 1, count: selected.length, winners: selected.filter((item) => item.isWinner).length, meanReward: selected.length ? selected.reduce((sum, item) => sum + item.reward, 0) / selected.length : 0, byAction: {} };
    },
    values,
  };
}

async function fakeEvolutionServer() {
  const runs = new Map();
  const startedExperiments = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && url.pathname === "/v1/evolution/runs") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const runId = `m7-candidate-${runs.size + 1}`;
        startedExperiments.push(body.experimentId);
        runs.set(runId, { runId, status: "completed", experimentId: body.experimentId });
        send(202, runs.get(runId));
      });
      return;
    }
    const result = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/result$/);
    if (req.method === "GET" && result) {
      const run = runs.get(result[1]);
      return send(200, { run, result: {
        schemaVersion: 1,
        experimentId: run.experimentId,
        decision: "promote",
        sandbox: { runtime: "docker" },
        budget: { wallSeconds: 1 },
        summary: { stepCount: 2, executedSteps: 2, passedSteps: 2, failedSteps: 0, blockedSteps: 0 },
        steps: [],
      } });
    }
    const status = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)$/);
    if (req.method === "GET" && status) return send(200, runs.get(status[1]));
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, startedExperiments, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("M7 preselects from an expanded proposal pool and executes only the predicted candidate", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m7-state-"));
  const learningDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m7-learning-"));
  const fake = await fakeEvolutionServer();
  const store = memoryStore([
    historical("good-1", 0.92, "regularize grouped features while preserving passing behavior"),
    historical("good-2", 0.88, "preserve passing behavior and regularize grouped features"),
    historical("bad-1", 0.12, "replace pipeline with unrelated random transforms"),
  ]);
  const orchestrator = createCurriculumEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    trajectoryStore: store,
    learning: {
      rootDir: learningDir,
      mode: "observe",
      epsilon: 0,
      teamMode: "off",
      skillMode: "off",
      curriculumMode: "off",
      worldModelMode: "online",
      worldModelExpansionFactor: 2,
      worldModelExplorationWeight: 0,
      worldModelCostWeight: 0,
      worldModelMinSupport: 2,
      worldModelMinSimilarity: 0.1,
    },
    generateVariants: async (input) => ({
      generatorRunId: `m7-generator-${input.count}`,
      variants: Array.from({ length: input.count }, (_, index) => {
        const good = index === 1;
        const experimentId = good ? "m7-good-exp" : `m7-bad-exp-${index}`;
        return {
          id: good ? "good-candidate" : `bad-candidate-${index}`,
          spec: { experimentId, protocol: { schemaVersion: 1, experimentId, objective: "test M7 preselection" } },
          metadata: { hypothesis: good ? "regularize grouped features and preserve passing behavior" : "replace pipeline with unrelated random transforms" },
        };
      }),
    }),
  });
  try {
    const started = await orchestrator.start({
      sessionId: "session-m7",
      workspaceId: "workspace-m7",
      episodeIndex: 1,
      generations: 1,
      populationSize: 1,
      pollIntervalMs: 10,
      candidateTimeoutMs: 1_000,
      generatorTimeoutMs: 1_000,
      seed: { id: "seed", spec: { experimentId: "seed-exp", protocol: { schemaVersion: 1, experimentId: "seed-exp", objective: "seed" } } },
    }, "owner-m7");
    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, "owner-m7");
      return current?.status === "completed" ? current : null;
    });
    assert.deepEqual(fake.startedExperiments, ["m7-good-exp"]);
    const attempt = completed.generations[0].attempts[0];
    assert.ok(attempt.candidateId.endsWith("good-candidate"));
    assert.equal(attempt.metadata.worldModelPrediction.predictedPoolSize, 2);
    assert.equal(attempt.metadata.worldModelPrediction.estimatedTychoJobsAvoided, 1);
    assert.equal(completed.learning.worldModel.mode, "online");
    assert.ok(store.values.some((item) => item.candidateMetadata?.worldModelPrediction?.expectedReward !== undefined));
  } finally {
    await orchestrator.shutdown();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(learningDir, { recursive: true, force: true });
  }
});
