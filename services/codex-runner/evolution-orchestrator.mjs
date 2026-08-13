import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunnerCodexVariantGenerator } from "./codex-evolution-generator.mjs";

const SCHEMA_VERSION = 1;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_GENERATIONS = 50;
const MAX_POPULATION = 12;
const MAX_CANDIDATE_TIMEOUT_MS = 86_400_000;
const MAX_GENERATOR_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const errorMessage = (error) => error instanceof Error && error.message.trim() ? error.message : String(error || "Unknown evolution error");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LOOPBACK_RUNNER_HOSTS = new Set(["127.0.0.1", "localhost"]);
function requireLoopbackRunnerHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!LOOPBACK_RUNNER_HOSTS.has(host)) {
    throw new Error("Evolution runner host must be loopback (127.0.0.1 or localhost).");
  }
  return host;
}

function boundedInteger(value, fallback, max, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}.`);
  }
  return resolved;
}

function validateSpec(spec, label = "spec") {
  if (!isRecord(spec)) throw new Error(`${label} must be an object.`);
  const experimentId = asString(spec.experimentId);
  if (!experimentId) throw new Error(`${label}.experimentId is required.`);
  if (!isRecord(spec.protocol) || spec.protocol.schemaVersion !== 1) {
    throw new Error(`${label}.protocol must use schemaVersion 1.`);
  }
  if (spec.protocol.experimentId !== experimentId) {
    throw new Error(`${label}.protocol.experimentId must match ${label}.experimentId.`);
  }
  if (spec.workspaceFiles !== undefined && !Array.isArray(spec.workspaceFiles)) {
    throw new Error(`${label}.workspaceFiles must be an array when provided.`);
  }
  return { ...spec, experimentId };
}

function validateSeed(seed) {
  if (!isRecord(seed)) throw new Error("seed is required.");
  const id = asString(seed.id);
  if (!id) throw new Error("seed.id is required.");
  return {
    id,
    spec: validateSpec(seed.spec, "seed.spec"),
    ...(isRecord(seed.metadata) ? { metadata: seed.metadata } : {}),
  };
}

function validateEvaluation(evaluation) {
  if (evaluation === null || evaluation === undefined) return null;
  if (!isRecord(evaluation) || typeof evaluation.score !== "number" || !Number.isFinite(evaluation.score)) {
    throw new Error("resumeFrom.evaluation must contain a finite score.");
  }
  return {
    score: evaluation.score,
    ...(isRecord(evaluation.metrics) ? { metrics: evaluation.metrics } : {}),
    ...(isRecord(evaluation.evidence) ? { evidence: evaluation.evidence } : {}),
  };
}

function validateResumePoint(value) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || !isRecord(value.candidate)) throw new Error("resumeFrom.candidate is required.");
  const candidate = value.candidate;
  const id = asString(candidate.id);
  const key = asString(candidate.key);
  const generation = Number(candidate.generation);
  if (!id || !key || !Number.isInteger(generation) || generation < 0) {
    throw new Error("resumeFrom.candidate has invalid identity or generation.");
  }
  if (key !== `g${generation}:${id}`) {
    throw new Error(`resumeFrom.candidate.key must equal g${generation}:${id}.`);
  }
  return {
    candidate: {
      id,
      spec: validateSpec(candidate.spec, "resumeFrom.candidate.spec"),
      ...(isRecord(candidate.metadata) ? { metadata: candidate.metadata } : {}),
      generation,
      key,
      parentKey: candidate.parentKey === null ? null : asString(candidate.parentKey),
    },
    evaluation: validateEvaluation(value.evaluation),
  };
}

function buildWorkspaceFiles(spec) {
  const extra = Array.isArray(spec.workspaceFiles) ? spec.workspaceFiles : [];
  if (extra.some((file) => String(file?.path || "").replaceAll("\\", "/") === ".nodes/tycho-experiment.json")) {
    throw new Error("workspaceFiles must not override .nodes/tycho-experiment.json.");
  }
  return [
    {
      path: ".nodes/tycho-experiment.json",
      content: `${JSON.stringify(spec.protocol, null, 2)}\n`,
      mimeType: "application/json",
    },
    ...extra,
  ];
}

function evaluateTychoResult(result, candidateMetadata) {
  if (!isRecord(result) || !isRecord(result.summary)) throw new Error("Tycho result is missing summary evidence.");
  const summary = result.summary;
  const stepCount = Number(summary.stepCount || 0);
  const passedSteps = Number(summary.passedSteps || 0);
  const failedSteps = Number(summary.failedSteps || 0);
  const blockedSteps = Number(summary.blockedSteps || 0);
  const passRatio = stepCount > 0 ? passedSteps / stepCount : 0;
  const decisionBase = result.decision === "promote" ? 2 : result.decision === "reject" ? 1 : 0;
  const score = decisionBase + Math.min(1, Math.max(0, passRatio)) * 0.5;
  const wallSeconds = typeof result.budget?.wallSeconds === "number" ? result.budget.wallSeconds : 0;
  return {
    score,
    metrics: { passRatio, passedSteps, failedSteps, blockedSteps, wallSeconds },
    evidence: {
      experimentId: result.experimentId,
      decision: result.decision,
      sandbox: result.sandbox,
      summary: result.summary,
      metadata: isRecord(result.metadata) ? result.metadata : {},
      candidateMetadata: candidateMetadata ?? {},
    },
  };
}

function selectWinner(attempts) {
  const successful = attempts.filter((attempt) => attempt.status === "succeeded" && attempt.score !== null);
  if (!successful.length) return null;
  return [...successful].sort((a, b) => {
    const scoreDelta = b.score - a.score;
    if (scoreDelta !== 0) return scoreDelta;
    const indexDelta = a.index - b.index;
    if (indexDelta !== 0) return indexDelta;
    return a.candidateKey.localeCompare(b.candidateKey);
  })[0] ?? null;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function publicRun(run) {
  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    sessionId: run.sessionId,
    projectId: run.projectId,
    workspaceId: run.workspaceId,
    episodeIndex: run.episodeIndex,
    status: run.status,
    phase: run.phase,
    requestedGenerations: run.requestedGenerations,
    populationSize: run.populationSize,
    startGeneration: run.startGeneration,
    nextGeneration: run.parent.generation + 1,
    completedGenerations: run.generations.length,
    generations: run.generations,
    champion: run.champion,
    reason: run.reason,
    activeGeneratorRunId: run.activeGeneratorRunId,
    activeCandidateRunIds: [...run.activeCandidateRunIds],
    cancelRequested: run.cancelRequested,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt,
  };
}

export function createDurableEvolutionOrchestrator(options = {}) {
  const evolutionPort = Number(options.evolutionPort || process.env.TYCHO_EVOLUTION_RUNNER_PORT || (Number(process.env.CODEX_RUNNER_PORT || 8787) + 1));
  const evolutionHost = requireLoopbackRunnerHost(options.host || "127.0.0.1");
  const evolutionBaseUrl = `http://${evolutionHost}:${evolutionPort}`;
  const token = options.token ?? process.env.CODEX_RUNNER_TOKEN?.trim() ?? null;
  const stateDir = path.resolve(options.stateDir || process.env.TYCHO_EVOLUTION_STATE_DIR || path.join(os.homedir(), ".nodes-ai-canvas", "evolution-runs"));
  const candidateConcurrency = boundedInteger(
    options.candidateConcurrency ?? Number(process.env.TYCHO_EVOLUTION_MAX_CONCURRENCY || 4),
    4,
    32,
    "candidateConcurrency",
  );
  const runs = new Map();
  const tasks = new Map();
  const generateVariants = options.generateVariants || createRunnerCodexVariantGenerator({
    host: evolutionHost,
    codexPort: Number(process.env.CODEX_RUNNER_PORT || 8787),
    token,
  });

  const requestHeaders = (ownerId, extra = {}) => ({
    ...extra,
    "x-nodes-owner-id": ownerId,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  });

  const statePath = (runId) => path.join(stateDir, `${runId}.json`);

  async function persist(run) {
    run.updatedAt = new Date().toISOString();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const target = statePath(run.runId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...run, activeCandidateRunIds: [...run.activeCandidateRunIds] }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  function hydrate(value) {
    if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION || !asString(value.runId) || !asString(value.ownerId)) return null;
    return { ...value, activeCandidateRunIds: new Set(Array.isArray(value.activeCandidateRunIds) ? value.activeCandidateRunIds : []) };
  }

  async function readRunnerError(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return asString(body.error) || fallback;
  }

  async function cancelCodex(ownerId, runId) {
    if (!runId) return;
    const codexPort = Number(process.env.CODEX_RUNNER_PORT || 8787);
    await fetch(`http://${evolutionHost}:${codexPort}/v1/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: requestHeaders(ownerId),
    }).catch(() => null);
  }

  async function cancelCandidate(ownerId, runId) {
    if (!runId) return;
    await fetch(`${evolutionBaseUrl}/v1/evolution/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: requestHeaders(ownerId),
    }).catch(() => null);
  }

  async function executeCandidate(run, candidate, index) {
    if (run.cancelRequested) throw new Error("Evolution episode cancelled.");
    const response = await fetch(`${evolutionBaseUrl}/v1/evolution/runs`, {
      method: "POST",
      headers: requestHeaders(run.ownerId, { "content-type": "application/json" }),
      body: JSON.stringify({
        ownerId: run.ownerId,
        workspaceId: run.workspaceId,
        projectId: run.projectId,
        sessionId: run.sessionId,
        candidateKey: candidate.key,
        experimentId: candidate.spec.experimentId,
        workspaceFiles: buildWorkspaceFiles(candidate.spec),
      }),
    });
    if (!response.ok) throw new Error(await readRunnerError(response, `Tycho candidate start failed: ${response.status}.`));
    const started = await response.json();
    const candidateRunId = asString(started.runId);
    if (!candidateRunId) throw new Error("Tycho candidate runner returned an invalid run id.");
    run.activeCandidateRunIds.add(candidateRunId);
    await persist(run);
    const startedAt = Date.now();
    try {
      let snapshot = started;
      while (snapshot.status === "running") {
        if (run.cancelRequested) {
          await cancelCandidate(run.ownerId, candidateRunId);
          throw new Error("Evolution episode cancelled.");
        }
        if (Date.now() - startedAt >= run.candidateTimeoutMs) {
          await cancelCandidate(run.ownerId, candidateRunId);
          throw new Error(`Tycho evolution run timed out: ${candidateRunId}`);
        }
        await sleep(run.pollIntervalMs);
        const statusResponse = await fetch(`${evolutionBaseUrl}/v1/evolution/runs/${encodeURIComponent(candidateRunId)}`, {
          method: "GET",
          headers: requestHeaders(run.ownerId),
        });
        if (!statusResponse.ok) throw new Error(await readRunnerError(statusResponse, `Tycho candidate status failed: ${statusResponse.status}.`));
        snapshot = await statusResponse.json();
      }
      if (snapshot.status !== "completed") {
        throw new Error(`Tycho evolution run ${snapshot.status}: ${snapshot.error || candidateRunId}`);
      }
      const resultResponse = await fetch(`${evolutionBaseUrl}/v1/evolution/runs/${encodeURIComponent(candidateRunId)}/result`, {
        method: "GET",
        headers: requestHeaders(run.ownerId),
      });
      if (!resultResponse.ok) throw new Error(await readRunnerError(resultResponse, `Tycho result fetch failed: ${resultResponse.status}.`));
      const completed = await resultResponse.json();
      if (completed.result?.experimentId !== candidate.spec.experimentId) {
        throw new Error("Tycho evolution result identity does not match the candidate spec.");
      }
      const evaluation = evaluateTychoResult(completed.result, candidate.metadata);
      return {
        candidateId: candidate.id,
        candidateKey: candidate.key,
        decision: completed.result.decision ?? null,
        error: null,
        evidence: evaluation.evidence,
        experimentId: candidate.spec.experimentId,
        generation: candidate.generation,
        index,
        isWinner: false,
        metadata: candidate.metadata ?? null,
        metrics: evaluation.metrics,
        parentKey: candidate.parentKey,
        runId: candidateRunId,
        score: evaluation.score,
        status: "succeeded",
        spec: candidate.spec,
      };
    } catch (error) {
      if (run.cancelRequested) throw error;
      return {
        candidateId: candidate.id,
        candidateKey: candidate.key,
        decision: null,
        error: { message: errorMessage(error), stage: "execution" },
        evidence: null,
        experimentId: candidate.spec.experimentId,
        generation: candidate.generation,
        index,
        isWinner: false,
        metadata: candidate.metadata ?? null,
        metrics: null,
        parentKey: candidate.parentKey,
        runId: candidateRunId,
        score: null,
        status: "failed",
        spec: candidate.spec,
      };
    } finally {
      run.activeCandidateRunIds.delete(candidateRunId);
      await persist(run).catch(() => null);
    }
  }

  function championFromAttempt(attempt) {
    if (!attempt) return null;
    return { ...attempt, isWinner: true, spec: attempt.spec };
  }

  async function failRun(run, reason) {
    run.status = "failed";
    run.phase = "failed";
    run.reason = reason;
    run.finishedAt = new Date().toISOString();
    run.activeGeneratorRunId = null;
    run.activeCandidateRunIds.clear();
    await persist(run);
  }

  async function runLoop(run) {
    if (tasks.has(run.runId)) return tasks.get(run.runId);
    const task = (async () => {
      if (!run.startedAt) run.startedAt = new Date().toISOString();
      run.status = "running";
      run.phase = run.phase === "recovering" ? "recovering" : "generating";
      await persist(run);
      try {
        while (run.generations.length < run.requestedGenerations) {
          if (run.cancelRequested) throw new Error("Evolution episode cancelled.");
          const generation = run.parent.generation + 1;
          run.phase = "generating";
          await persist(run);

          let generated;
          try {
            generated = await generateVariants({
              ownerId: run.ownerId,
              sessionId: run.sessionId,
              projectId: run.projectId,
              workspaceId: run.workspaceId,
              count: run.populationSize,
              generation,
              parent: run.parent,
              parentEvaluation: run.parentEvaluation,
              timeoutMs: run.generatorTimeoutMs,
              maxOutputChars: run.maxOutputChars,
              onRunStarted: async (runId) => {
                run.activeGeneratorRunId = runId;
                await persist(run).catch(() => null);
              },
              onRunFinished: async (runId) => {
                if (run.activeGeneratorRunId === runId) run.activeGeneratorRunId = null;
                await persist(run).catch(() => null);
              },
            });
          } catch (error) {
            if (run.cancelRequested) throw error;
            const reason = `Generation ${generation} variant generation failed: ${errorMessage(error)}`;
            run.generations.push({
              attempts: [], error: reason, generation, parentKey: run.parent.key,
              requestedPopulation: run.populationSize, status: "failed", winnerKey: null,
            });
            await failRun(run, reason);
            return;
          }

          const variants = generated.variants;
          if (!Array.isArray(variants) || variants.length !== run.populationSize) {
            const reason = `Generation ${generation} produced ${Array.isArray(variants) ? variants.length : 0} variants; expected exactly ${run.populationSize}.`;
            run.generations.push({ attempts: [], error: reason, generation, parentKey: run.parent.key, requestedPopulation: run.populationSize, status: "failed", winnerKey: null });
            await failRun(run, reason);
            return;
          }
          const ids = variants.map((variant) => asString(variant.id));
          if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
            const reason = `Generation ${generation} contains empty or duplicate variant ids.`;
            run.generations.push({ attempts: [], error: reason, generation, parentKey: run.parent.key, requestedPopulation: run.populationSize, status: "failed", winnerKey: null });
            await failRun(run, reason);
            return;
          }
          const candidates = variants.map((variant, index) => ({
            ...variant,
            id: ids[index],
            spec: validateSpec(variant.spec, `variants[${index}].spec`),
            generation,
            key: `g${generation}:${ids[index]}`,
            parentKey: run.parent.key,
          }));

          run.phase = "executing_generation";
          await persist(run);
          const attempts = await mapWithConcurrency(
            candidates,
            candidateConcurrency,
            (candidate, index) => executeCandidate(run, candidate, index),
          );
          if (run.cancelRequested) throw new Error("Evolution episode cancelled.");
          const winner = selectWinner(attempts);
          if (!winner) {
            const reason = `Generation ${generation} has no successfully evaluated candidates.`;
            run.generations.push({ attempts, error: reason, generation, parentKey: run.parent.key, requestedPopulation: run.populationSize, status: "failed", winnerKey: null });
            await failRun(run, reason);
            return;
          }
          for (const attempt of attempts) attempt.isWinner = attempt.candidateKey === winner.candidateKey;
          const generationSnapshot = {
            attempts: attempts.map(({ spec, ...attempt }) => attempt),
            error: null,
            generation,
            parentKey: run.parent.key,
            requestedPopulation: run.populationSize,
            status: "completed",
            winnerKey: winner.candidateKey,
          };
          run.generations.push(generationSnapshot);
          run.champion = championFromAttempt(winner);
          run.parent = {
            id: winner.candidateId,
            spec: winner.spec,
            ...(winner.metadata ? { metadata: winner.metadata } : {}),
            generation,
            key: winner.candidateKey,
            parentKey: winner.parentKey,
          };
          run.parentEvaluation = { score: winner.score, metrics: winner.metrics ?? undefined, evidence: winner.evidence ?? undefined };
          run.phase = "checkpointed";
          await persist(run);
        }
        run.status = "completed";
        run.phase = "completed";
        run.reason = null;
        run.finishedAt = new Date().toISOString();
        await persist(run);
      } catch (error) {
        if (run.cancelRequested) {
          run.status = "cancelled";
          run.phase = "cancelled";
          run.reason = "Evolution episode cancelled.";
          run.finishedAt = new Date().toISOString();
          run.activeGeneratorRunId = null;
          run.activeCandidateRunIds.clear();
          await persist(run);
          return;
        }
        await failRun(run, errorMessage(error));
      }
    })().finally(() => tasks.delete(run.runId));
    tasks.set(run.runId, task);
    return task;
  }

  async function start(input, ownerId) {
    if (!asString(ownerId)) throw new Error("Missing owner id.");
    if (!isRecord(input)) throw new Error("Evolution episode body must be an object.");
    const sessionId = asString(input.sessionId);
    const workspaceId = asString(input.workspaceId);
    if (!sessionId || !workspaceId) throw new Error("sessionId and workspaceId are required.");
    const seed = validateSeed(input.seed);
    const resumeFrom = validateResumePoint(input.resumeFrom);
    const requestedGenerations = boundedInteger(input.generations, 4, MAX_GENERATIONS, "generations");
    const populationSize = boundedInteger(input.populationSize, 3, MAX_POPULATION, "populationSize");
    const candidateTimeoutMs = boundedInteger(input.candidateTimeoutMs, 75_000, MAX_CANDIDATE_TIMEOUT_MS, "candidateTimeoutMs");
    const generatorTimeoutMs = boundedInteger(input.generatorTimeoutMs, 45_000, MAX_GENERATOR_TIMEOUT_MS, "generatorTimeoutMs");
    const pollIntervalMs = boundedInteger(input.pollIntervalMs, 250, 10_000, "pollIntervalMs");
    const maxOutputChars = boundedInteger(input.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 5_000_000, "maxOutputChars");
    const parent = resumeFrom?.candidate ?? { ...seed, generation: 0, key: `g0:${seed.id}`, parentKey: null };
    const createdAt = new Date().toISOString();
    const run = {
      schemaVersion: SCHEMA_VERSION,
      runId: randomUUID(),
      ownerId,
      sessionId,
      projectId: asString(input.projectId),
      workspaceId,
      episodeIndex: boundedInteger(input.episodeIndex, 1, 100_000, "episodeIndex"),
      requestedGenerations,
      populationSize,
      candidateTimeoutMs,
      generatorTimeoutMs,
      pollIntervalMs,
      maxOutputChars,
      status: "queued",
      phase: "queued",
      seed,
      parent,
      parentEvaluation: resumeFrom?.evaluation ?? null,
      startGeneration: parent.generation + 1,
      generations: [],
      champion: null,
      reason: null,
      activeGeneratorRunId: null,
      activeCandidateRunIds: new Set(),
      cancelRequested: false,
      createdAt,
      startedAt: null,
      updatedAt: createdAt,
      finishedAt: null,
    };
    runs.set(run.runId, run);
    await persist(run);
    void runLoop(run);
    return publicRun(run);
  }

  async function get(runId, ownerId) {
    const run = runs.get(runId);
    if (!run || run.ownerId !== ownerId) return null;
    return publicRun(run);
  }

  async function cancel(runId, ownerId) {
    const run = runs.get(runId);
    if (!run || run.ownerId !== ownerId) return null;
    if (TERMINAL.has(run.status)) return publicRun(run);
    run.cancelRequested = true;
    run.phase = "cancelling";
    await persist(run);
    await Promise.all([
      cancelCodex(run.ownerId, run.activeGeneratorRunId),
      ...[...run.activeCandidateRunIds].map((candidateRunId) => cancelCandidate(run.ownerId, candidateRunId)),
    ]);
    return publicRun(run);
  }

  async function recover() {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const files = await readdir(stateDir).catch(() => []);
    for (const file of files.filter((entry) => entry.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(await readFile(path.join(stateDir, file), "utf8"));
        const run = hydrate(parsed);
        if (!run) continue;
        runs.set(run.runId, run);
        if (!TERMINAL.has(run.status)) {
          run.activeGeneratorRunId = null;
          run.activeCandidateRunIds.clear();
          if (run.cancelRequested) {
            run.status = "cancelled";
            run.phase = "cancelled";
            run.reason = "Evolution episode cancelled before runner recovery completed.";
            run.finishedAt = new Date().toISOString();
            await persist(run);
            continue;
          }
          run.status = "queued";
          run.phase = "recovering";
          await persist(run);
          void runLoop(run);
        }
      } catch (error) {
        console.warn("[tycho-evolution-orchestrator] unable to recover state", file, errorMessage(error));
      }
    }
  }

  async function shutdown() {
    for (const run of runs.values()) {
      if (TERMINAL.has(run.status)) continue;
      await Promise.all([
        cancelCodex(run.ownerId, run.activeGeneratorRunId),
        ...[...run.activeCandidateRunIds].map((candidateRunId) => cancelCandidate(run.ownerId, candidateRunId)),
      ]);
      run.cancelRequested = false;
      run.status = "queued";
      run.phase = "recovering";
      run.activeGeneratorRunId = null;
      run.activeCandidateRunIds.clear();
      await persist(run).catch(() => null);
    }
  }

  return { start, get, cancel, recover, shutdown, stateDir, activeCount: () => [...runs.values()].filter((run) => !TERMINAL.has(run.status)).length };
}
