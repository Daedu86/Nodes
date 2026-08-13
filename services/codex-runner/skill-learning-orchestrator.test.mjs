import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLearningEvolutionOrchestrator } from "./learning-evolution-orchestrator.mjs";
import { createSkillRegistry } from "./skill-registry.mjs";
import { createSkillRetriever } from "./skill-retriever.mjs";
import { buildSkill, skillRef } from "./skill-schema.mjs";

const waitFor = async (predicate, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for M5 episode.");
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
        const runId = `m5-candidate-${runs.size + 1}`;
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

test("M5 injects a promoted skill into a candidate and records provenance", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m5-state-"));
  const learningDir = await mkdtemp(path.join(os.tmpdir(), "nodes-m5-learning-"));
  const fake = await fakeEvolutionServer();
  const registry = createSkillRegistry({ rootDir: learningDir });
  const candidate = await registry.upsertCandidate(buildSkill({
    title: "Diversify learned procedure",
    domain: "general-evolution",
    mechanism: "diversify strategy with single team",
    triggers: ["decision=none", "pass=unknown"],
    preconditions: ["strategy=diversify", "team=single"],
    procedure: ["Explore structurally distinct falsifiable mechanisms."],
    evidence: { support: 5, meanReward: 0.84 },
  }));
  const promoted = await registry.transition(skillRef(candidate), "promoted", { validationObservations: 4, rewardLift: 0.08 });
  const retriever = createSkillRetriever({ skillRegistry: registry, mode: "online", topK: 1, exploration: 0 });
  const orchestrator = createLearningEvolutionOrchestrator({
    stateDir,
    evolutionPort: fake.port,
    skillRegistry: registry,
    skillRetriever: retriever,
    learning: { rootDir: learningDir, mode: "online", epsilon: 0, alpha: 0.5, gamma: 0, teamMode: "off", skillMode: "online" },
    generateVariants: async (input) => ({
      generatorRunId: `m5-generator-${input.generation}`,
      variants: [{
        id: "candidate-a",
        spec: { experimentId: "m5-exp-a", protocol: { schemaVersion: 1, experimentId: "m5-exp-a", objective: "test skill reuse" } },
        metadata: { hypothesis: "reuse validated procedural evidence" },
      }],
    }),
  });
  try {
    const started = await orchestrator.start({
      sessionId: "session-m5",
      workspaceId: "workspace-m5",
      episodeIndex: 1,
      generations: 1,
      populationSize: 1,
      pollIntervalMs: 10,
      candidateTimeoutMs: 1_000,
      generatorTimeoutMs: 1_000,
      seed: { id: "seed", spec: { experimentId: "seed-exp", protocol: { schemaVersion: 1, experimentId: "seed-exp", objective: "seed" } } },
    }, "owner-m5");
    const completed = await waitFor(async () => {
      const current = await orchestrator.get(started.runId, "owner-m5");
      return current?.status === "completed" ? current : null;
    });
    const attempt = completed.generations[0].attempts[0];
    assert.deepEqual(attempt.metadata.skillContext.skillRefs, [skillRef(promoted)]);
    assert.equal(completed.learning.replay.count, 1);
    assert.equal(completed.learning.skills.registry.byStatus.promoted, 1);
  } finally {
    await orchestrator.shutdown();
    await fake.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(learningDir, { recursive: true, force: true });
  }
});
