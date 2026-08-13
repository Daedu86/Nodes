import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import { readEvolutionRunnerConfig } from "./evolution-config.mjs";
import { readTychoReadiness } from "./tycho-readiness.mjs";
import { normalizeWorkspaceFiles } from "./workspace-artifacts.mjs";
import { createEvolutionWorkspace, cleanupEvolutionWorkspace } from "./evolution-workspace.mjs";
import { readTychoEvolutionResult } from "./evolution-result.mjs";

const RUNNER_CONFIG = readEvolutionRunnerConfig();
const PORT = RUNNER_CONFIG.port;
const HOST = process.env.CODEX_RUNNER_HOST || "127.0.0.1";
const RUNNER_TOKEN = process.env.CODEX_RUNNER_TOKEN?.trim() || null;
const TYCHO_BIN = process.env.TYCHO_EXPERIMENT_BIN?.trim() || "tycho-experiment";
const MAX_CONCURRENCY = RUNNER_CONFIG.maxConcurrency;
const HARD_TIMEOUT_MS = RUNNER_CONFIG.hardTimeoutMs;
const MAX_CAPTURE_CHARS = 20_000;

const runs = new Map();
const active = new Set();

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function parseWorkspaceMap() {
  const raw = process.env.CODEX_WORKSPACES_JSON?.trim();
  if (!raw) return new Map();
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("CODEX_WORKSPACES_JSON must be an object.");
  return new Map(Object.entries(parsed).flatMap(([workspaceId, value]) => {
    const cwd = asString(value);
    return cwd ? [[workspaceId, path.resolve(cwd)]] : [];
  }));
}

const WORKSPACES = parseWorkspaceMap();

function authorize(req) {
  return !RUNNER_TOKEN || req.headers.authorization === `Bearer ${RUNNER_TOKEN}`;
}

function ownerFrom(req, body = {}) {
  return asString(req.headers["x-nodes-owner-id"]) || asString(body.ownerId);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 700_000) {
        reject(new Error("Evolution request exceeds the runner payload budget."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function appendCapture(current, chunk) {
  const next = current + String(chunk || "");
  return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(next.length - MAX_CAPTURE_CHARS);
}

function publicRun(run) {
  return {
    runId: run.runId,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    sessionId: run.sessionId,
    candidateKey: run.candidateKey,
    experimentId: run.experimentId,
    status: run.status,
    exitCode: run.exitCode,
    error: run.error,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
  };
}

function validateProtocol(workspaceFiles, experimentId) {
  const files = normalizeWorkspaceFiles(workspaceFiles);
  const protocolFile = files.find((file) => file.path === ".nodes/tycho-experiment.json");
  if (!protocolFile) throw new Error("Evolution run requires .nodes/tycho-experiment.json.");
  let protocol;
  try { protocol = JSON.parse(protocolFile.content); }
  catch { throw new Error("Evolution protocol must be valid JSON."); }
  if (!isRecord(protocol) || protocol.schemaVersion !== 1) {
    throw new Error("Evolution protocol schemaVersion must equal 1.");
  }
  if (asString(protocol.experimentId) !== experimentId) {
    throw new Error("Evolution protocol experimentId does not match the requested experiment.");
  }
  return files;
}

function releaseRunWorkspace(run) {
  active.delete(run.runId);
  cleanupEvolutionWorkspace(run.cwd);
  run.cwd = null;
  run.child = null;
}

function startEvolutionRun(body, ownerId) {
  if (active.size >= MAX_CONCURRENCY) {
    const error = new Error("Evolution runner concurrency budget is exhausted.");
    error.statusCode = 429;
    throw error;
  }

  const workspaceId = asString(body.workspaceId);
  const experimentId = asString(body.experimentId);
  const candidateKey = asString(body.candidateKey);
  if (!workspaceId || !experimentId || !candidateKey) {
    const error = new Error("Missing workspaceId, experimentId, or candidateKey.");
    error.statusCode = 400;
    throw error;
  }

  const sourceCwd = WORKSPACES.get(workspaceId);
  if (!sourceCwd || !existsSync(sourceCwd) || !lstatSync(sourceCwd).isDirectory()) {
    const error = new Error(`Unknown or unavailable evolution workspace id: ${workspaceId}`);
    error.statusCode = 400;
    throw error;
  }

  const workspaceFiles = validateProtocol(body.workspaceFiles, experimentId);
  const runId = randomUUID();
  const isolated = createEvolutionWorkspace(sourceCwd, runId, workspaceFiles);
  const run = {
    runId,
    ownerId,
    workspaceId,
    projectId: asString(body.projectId),
    sessionId: asString(body.sessionId),
    candidateKey,
    experimentId,
    status: "running",
    exitCode: null,
    error: null,
    result: null,
    stdout: "",
    stderr: "",
    cwd: isolated.cwd,
    child: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
  };
  runs.set(runId, run);
  active.add(runId);

  const child = spawn(TYCHO_BIN, [
    "--workspace", run.cwd,
    "--protocol", ".nodes/tycho-experiment.json",
    "--result", ".nodes/tycho-result.json",
  ], { cwd: run.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  run.child = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { run.stdout = appendCapture(run.stdout, chunk); });
  child.stderr.on("data", (chunk) => { run.stderr = appendCapture(run.stderr, chunk); });

  const hardTimeout = setTimeout(() => child.kill("SIGKILL"), HARD_TIMEOUT_MS);
  child.on("error", (error) => {
    clearTimeout(hardTimeout);
    if (!run.cwd) return;
    run.status = "failed";
    run.error = error.message;
    run.finishedAt = new Date().toISOString();
    releaseRunWorkspace(run);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(hardTimeout);
    if (!run.cwd) return;
    run.exitCode = code;

    if (run.status === "cancelled") {
      releaseRunWorkspace(run);
      return;
    }

    try {
      if (![0, 3, 4].includes(code)) {
        throw new Error(`tycho-experiment failed with exit ${code ?? "none"}${signal ? ` (${signal})` : ""}: ${run.stderr.trim() || "no stderr"}`);
      }
      run.result = readTychoEvolutionResult(run.cwd, experimentId);
      run.status = "completed";
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    }
    run.finishedAt = new Date().toISOString();
    releaseRunWorkspace(run);
  });

  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, runs: runs.size, activeRuns: active.size, maxConcurrency: MAX_CONCURRENCY });
  if (!authorize(req)) return json(res, 401, { error: "Unauthorized." });

  try {
    if (url.pathname === "/readyz" && req.method === "GET") {
      const tycho = await readTychoReadiness();
      return json(res, tycho.tychoReady ? 200 : 503, { ok: tycho.tychoReady === true, ...tycho, workspaceIds: [...WORKSPACES.keys()], maxConcurrency: MAX_CONCURRENCY });
    }

    if (url.pathname === "/v1/evolution/runs" && req.method === "POST") {
      const body = await readJson(req);
      const ownerId = ownerFrom(req, body);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      const run = startEvolutionRun(body, ownerId);
      return json(res, 202, publicRun(run));
    }

    const resultMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/result$/);
    if (resultMatch && req.method === "GET") {
      const run = runs.get(decodeURIComponent(resultMatch[1]));
      const ownerId = ownerFrom(req);
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Evolution run not found." });
      if (run.status === "running") return json(res, 409, { error: "Evolution run is still running." });
      if (!run.result) return json(res, 409, { error: run.error || "Evolution result is unavailable." });
      return json(res, 200, { run: publicRun(run), result: run.result });
    }

    const cancelMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const run = runs.get(decodeURIComponent(cancelMatch[1]));
      const ownerId = ownerFrom(req);
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Evolution run not found." });
      if (run.status === "running") {
        run.status = "cancelled";
        run.error = "Evolution run cancelled.";
        run.finishedAt = new Date().toISOString();
        run.child?.kill("SIGTERM");
      }
      return json(res, 200, publicRun(run));
    }

    const runMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      const run = runs.get(decodeURIComponent(runMatch[1]));
      const ownerId = ownerFrom(req);
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Evolution run not found." });
      return json(res, 200, publicRun(run));
    }

    return json(res, 404, { error: "Not found." });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    console.error("[tycho-evolution-runner] request failed", error);
    return json(res, status, { error: error instanceof Error ? error.message : "Internal error." });
  }
});

server.listen(PORT, HOST, () => console.log(`Nodes Tycho Evolution Runner listening on http://${HOST}:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const run of runs.values()) {
      run.child?.kill("SIGTERM");
      cleanupEvolutionWorkspace(run.cwd);
    }
    server.close(() => process.exit(0));
  });
}
