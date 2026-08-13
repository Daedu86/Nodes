export function boundedPositiveInteger(value, fallback, label, max) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : null;
  const resolved = raw === null ? fallback : Number(raw);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return resolved;
}

export function readEvolutionRunnerConfig(env = process.env) {
  const basePort = boundedPositiveInteger(env.CODEX_RUNNER_PORT, 8787, "CODEX_RUNNER_PORT", 65_534);
  return {
    port: boundedPositiveInteger(
      env.TYCHO_EVOLUTION_RUNNER_PORT,
      basePort + 1,
      "TYCHO_EVOLUTION_RUNNER_PORT",
      65_535,
    ),
    maxConcurrency: boundedPositiveInteger(
      env.TYCHO_EVOLUTION_MAX_CONCURRENCY,
      4,
      "TYCHO_EVOLUTION_MAX_CONCURRENCY",
      32,
    ),
    hardTimeoutMs: boundedPositiveInteger(
      env.TYCHO_EVOLUTION_HARD_TIMEOUT_MS,
      1_200_000,
      "TYCHO_EVOLUTION_HARD_TIMEOUT_MS",
      86_400_000,
    ),
  };
}
