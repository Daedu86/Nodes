import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTychoEvolutionResult, readTychoEvolutionResult } from "./evolution-result.mjs";

const validResult = () => ({
  schemaVersion: 1,
  experimentId: "candidate-1",
  decision: "promote",
  sandbox: { runtime: "docker", image: "tycho-sandbox" },
  summary: {
    stepCount: 1,
    executedSteps: 1,
    passedSteps: 1,
    failedSteps: 0,
    blockedSteps: 0,
  },
  steps: [{ id: "verify" }],
});

test("accepts valid Docker and Kubernetes isolated Tycho evolution results", () => {
  assert.equal(parseTychoEvolutionResult(validResult(), "candidate-1").decision, "promote");
  const kubernetes = validResult();
  kubernetes.sandbox = { runtime: "kubernetes", image: "tycho:kubernetes" };
  assert.equal(parseTychoEvolutionResult(kubernetes, "candidate-1").sandbox.runtime, "kubernetes");
});

test("rejects result identity and non-isolated host sandbox", () => {
  assert.throws(() => parseTychoEvolutionResult(validResult(), "candidate-2"), /experimentId mismatch/);
  const host = validResult();
  host.sandbox.runtime = "host";
  assert.throws(() => parseTychoEvolutionResult(host, "candidate-1"), /isolated runtime/);
});

test("reads only the fixed .nodes result path", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "nodes-tycho-result-"));
  mkdirSync(path.join(cwd, ".nodes"), { recursive: true });
  writeFileSync(path.join(cwd, ".nodes", "tycho-result.json"), JSON.stringify(validResult()), "utf8");
  assert.equal(readTychoEvolutionResult(cwd, "candidate-1").experimentId, "candidate-1");
});
