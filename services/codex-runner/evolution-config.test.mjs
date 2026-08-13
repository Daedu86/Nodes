import assert from "node:assert/strict";
import test from "node:test";

import { readEvolutionRunnerConfig } from "./evolution-config.mjs";

test("uses bounded evolution runner defaults", () => {
  assert.deepEqual(readEvolutionRunnerConfig({ CODEX_RUNNER_PORT: "8787" }), {
    port: 8788,
    maxConcurrency: 4,
    hardTimeoutMs: 1_200_000,
  });
});

test("rejects invalid concurrency, timeout and port values", () => {
  assert.throws(
    () => readEvolutionRunnerConfig({ TYCHO_EVOLUTION_MAX_CONCURRENCY: "0" }),
    /TYCHO_EVOLUTION_MAX_CONCURRENCY/,
  );
  assert.throws(
    () => readEvolutionRunnerConfig({ TYCHO_EVOLUTION_HARD_TIMEOUT_MS: "NaN" }),
    /TYCHO_EVOLUTION_HARD_TIMEOUT_MS/,
  );
  assert.throws(
    () => readEvolutionRunnerConfig({ TYCHO_EVOLUTION_RUNNER_PORT: "70000" }),
    /TYCHO_EVOLUTION_RUNNER_PORT/,
  );
});
