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
  throw new Error("Timed out waiting for M6 episode.");
};

async function fakeEvolutionServer() {
  const runs = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && url.pathname === "/v1/evolution/runs") {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        const runId = `m6-candidate-${runs.size + 1}`;
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
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("M6 injects a bounded task into generation and persists provenance", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m6-state-"));
  const learningDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m6-learning-"));
  const fake = await fakeEvolutionServer();
  let observedTask = null;
  const orchestrator = createCurriculumEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    learning: {
      rootDir: learningDir,
      mode: "online",
      epsilon: 0,
      alpha: 0.5,
      gamma: 0,
      teamMode: "off",
      skillMode: "off",
      curriculumMode: "online",
      curriculumMaxTasksPerRun: 2,
      curriculumMaxDifficulty: 0.7,
      curriculumTargetReward: 0.65,
      curriculumAllowedDomains: ["general-evolution"],
    },
    generateVariants: async (input) => {
      observedTask = input.parentEvaluation?.evidence?.curriculumTask || null;
      return {
        generatorRunId: `m6-generator-${input.generation}`,
        variants: [{
          id: "candidate-a",
          spec: { experimentId: "m6-exp-a", protocol: { schemaVersion: 1, experimentId: "m6-exp-a", objective: "practice frontier" } },
          metadata: { hypothesis: "target current curriculum frontier", domain: "general-evolution" },
        }],
      };
    },
  });
  try {
    const started = await orchestrator.start({
      sessionId: "session-m6",
      workspaceId: "workspace-m6",
      episodeIndex: 1,
      generations: 1,
      populationSize: 1,
      pollIntervalMs: 10,
      candidateTimeoutMs: 1_000,
      generatorTimeoutMs: 1_000,
      seed: { id: "seed", metadata: { domain: "general-evolution" }, spec: { experimentId: "seed-exp", protocol: { schemaVersion: 1, experimentId: "seed-exp", objective: "seed" } } },
    }, "owner-m6");
    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, "owner-m6");
      return current?.status === "completed" ? current : null;
    });
    assert.ok(observedTask);
    assert.equal(observedTask.schemaVersion, 1);
    assert.ok(observedTask.difficulty <= 0.7);
    const attempt = completed.generations[0].attempts[0];
    assert.equal(attempt.metadata.curriculumContext.task.taskId, observedTask.taskId);
    assert.equal(completed.learning.curriculum.mode, "online");
    assert.equal(completed.learning.replay.count, 1);
    const report = await orchestrator.curriculumReport("workspace-m6");
    assert.ok(report.profiles.some((profile) => profile.domain === "general-evolution"));
  } finally {
    await orchestrator.shutdown();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(learningDir, { recursive: true, force: true });
  }
});
