import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLearningEvolutionOrchestrator } from "./learning-evolution-orchestrator.mjs";
import { createTeamPolicyController } from "./team-policy-controller.mjs";

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for M4 episode.");
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
        const runId = `candidate-${runs.size + 1}`;
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

test("M4 learns team topology on top of the M3 strategy decision", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m4-state-"));
  const learningDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m4-learning-"));
  const fake = await fakeEvolutionServer();
  const teamPolicy = createTeamPolicyController({ rootDir: learningDir, mode: "online", epsilon: 0, alpha: 1 });
  const orchestrator = createLearningEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    learning: { rootDir: learningDir, mode: "online", epsilon: 0, alpha: 0.5, gamma: 0 },
    teamPolicyController: teamPolicy,
    generateVariants: async (input) => ({
      generatorRunId: `generator-${input.generation}`,
      variants: [{
        id: "candidate-a",
        spec: { experimentId: "exp-a", protocol: { schemaVersion: 1, experimentId: "exp-a", objective: "test" } },
        metadata: { hypothesis: "hierarchical test" },
      }],
    }),
  });
  try {
    const started = await orchestrator.start({
      sessionId: "session-m4",
      workspaceId: "workspace-m4",
      episodeIndex: 1,
      generations: 1,
      populationSize: 1,
      pollIntervalMs: 10,
      candidateTimeoutMs: 1_000,
      generatorTimeoutMs: 1_000,
      seed: { id: "seed", spec: { experimentId: "seed-exp", protocol: { schemaVersion: 1, experimentId: "seed-exp", objective: "seed" } } },
    }, "owner-m4");
    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, "owner-m4");
      return current?.status === "completed" ? current : null;
    });
    const attempt = completed.generations[0].attempts[0];
    assert.equal(typeof attempt.metadata.learningPolicy.actionId, "string");
    assert.equal(attempt.metadata.multiAgentTeam.topologyId, "single");
    assert.equal(attempt.metadata.multiAgentTeam.strategyActionId, attempt.metadata.learningPolicy.actionId);
    assert.equal(completed.learning.replay.count, 1);
    assert.equal(completed.learning.policy.appliedTransitionCount, 1);
    assert.equal(completed.learning.team.appliedOutcomeCount, 1);
    assert.equal(completed.learning.team.teamPolicyVersion, "t1");
  } finally {
    await orchestrator.shutdown();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(learningDir, { recursive: true, force: true });
  }
});
