import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
  asString,
  buildOpenShellCreateArgs,
  createSandboxName,
  isRecord,
  normalizeNooaRun,
  parseOpenShellPolicyMap,
  parseWorkerLine,
  parseWorkspaceMap,
  resolveOpenShellPolicy,
  resolveWorkspace,
} from "./runtime.mjs";

const SERVICE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.NOOA_RUNNER_PORT || 8788);
const HOST = process.env.NOOA_RUNNER_HOST || "127.0.0.1";
const OPENSHELL_BIN = process.env.OPENSHELL_BIN || "openshell";
const RUNNER_TOKEN = process.env.NOOA_RUNNER_TOKEN?.trim() || null;
const DEFAULT_CWD = process.env.NOOA_DEFAULT_CWD?.trim() || null;
const DEFAULT_IMAGE = process.env.NOOA_SANDBOX_IMAGE?.trim() || null;
const MODEL = process.env.NOOA_MODEL?.trim() || "gpt-5-mini";
const positiveInteger = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
};
const MAX_ITERATIONS = positiveInteger(process.env.NOOA_MAX_ITERATIONS, 12);
const MAX_EVENT_BACKLOG = positiveInteger(process.env.NOOA_MAX_EVENT_BACKLOG, 500);
const MAX_CONCURRENT_RUNS = positiveInteger(process.env.NOOA_MAX_CONCURRENT_RUNS, 2);
const OPEN_SHELL_TIMEOUT_MS = positiveInteger(process.env.NOOA_OPENSHELL_TIMEOUT_MS, 900_000, 1_000);
const RUNS_DIR = path.resolve(process.env.NOOA_RUNNER_HOME || path.join(os.tmpdir(), "nodes-nooa-runner"));
const WORKER_PATH = path.resolve(process.env.NOOA_WORKER_PATH || path.join(SERVICE_DIR, "worker.py"));

const WORKSPACES = parseWorkspaceMap(process.env.NOOA_WORKSPACES_JSON);
const POLICIES = parseOpenShellPolicyMap(process.env.NOOA_OPENSHELL_POLICIES_JSON, DEFAULT_IMAGE);
const runs = new Map();

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function assertDirectory(localPath, label) {
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory: ${localPath}`);
  }
  return path.resolve(localPath);
}

function assertFile(localPath, label) {
  if (!existsSync(localPath) || !statSync(localPath).isFile()) {
    throw new Error(`${label} does not exist or is not a file: ${localPath}`);
  }
  return path.resolve(localPath);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function authorize(req) {
  return !RUNNER_TOKEN || req.headers.authorization === `Bearer ${RUNNER_TOKEN}`;
}

function ownerFrom(req, body) {
  return asString(req.headers["x-nodes-owner-id"]) || asString(body?.ownerId);
}

function writeSse(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publish(run, type, source, payload = {}) {
  const event = {
    id: randomUUID(),
    runId: run.runId,
    nodeId: run.nodeId,
    runtime: "nooa",
    type,
    source,
    sequence: run.sequence += 1,
    createdAt: new Date().toISOString(),
    parentRunId: run.parentRunId,
    payload,
  };
  run.events.push(event);
  if (run.events.length > MAX_EVENT_BACKLOG) {
    run.events.splice(0, run.events.length - MAX_EVENT_BACKLOG);
  }
  for (const subscriber of run.subscribers) writeSse(subscriber, event);
  return event;
}

function makeRunRecord({ runId, ownerId, input, workspace, policy, inputPath }) {
  return {
    runId,
    ownerId,
    nodeId: input.nodeId,
    sessionId: input.sessionId,
    projectId: input.projectId,
    workspaceId: workspace?.workspaceId || null,
    parentRunId: input.parentRunId,
    role: input.role,
    label: input.label,
    policyId: policy.id,
    sandboxName: createSandboxName(runId),
    status: "queued",
    events: [],
    subscribers: new Set(),
    sequence: 0,
    child: null,
    inputPath,
    cancelled: false,
    workerError: null,
    createdAt: new Date().toISOString(),
  };
}

function makeSandboxInput(run, input, workspace) {
  return {
    schemaVersion: 1,
    runId: run.runId,
    nodeId: run.nodeId,
    sessionId: run.sessionId,
    role: input.role,
    label: input.label,
    prompt: input.prompt,
    sandbox: { provider: "openshell", policyId: run.policyId },
    workspace: workspace ? { path: "/workspace", mode: "snapshot" } : null,
  };
}

function activeRunCount() {
  return [...runs.values()].filter((run) => !terminalStatuses.has(run.status)).length;
}

function cleanupInput(run) {
  const runDirectory = path.dirname(run.inputPath);
  const relative = path.relative(RUNS_DIR, runDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  rmSync(runDirectory, { recursive: true, force: true });
}

function finishRun(run, status, payload = {}) {
  if (terminalStatuses.has(run.status)) return;
  run.status = status;
  const type = status === "completed" ? "run.completed" : status === "cancelled" ? "run.cancelled" : "run.failed";
  publish(run, type, "runtime", payload);
  cleanupInput(run);
}

function handleWorkerOutput(run, line, stream) {
  const message = parseWorkerLine(line);
  if (message.kind === "event") {
    publish(run, message.type, "runtime", message.payload);
    return;
  }
  if (message.kind === "result") {
    publish(run, "agent.message.completed", "runtime", message.payload);
    return;
  }
  if (message.kind === "error") {
    run.workerError = message.payload;
    publish(run, "runtime.unknown", "runtime", { workerError: message.payload });
    return;
  }
  if (message.text.trim()) {
    publish(run, "runtime.unknown", "sandbox", { stream, text: message.text });
  }
}

function observeChildStream(run, stream, name) {
  if (!stream) return;
  stream.setEncoding("utf8");
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  reader.on("line", (line) => handleWorkerOutput(run, line, name));
}

function deleteSandbox(run) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 10_000);
    try {
      const child = spawn(OPENSHELL_BIN, ["sandbox", "delete", run.sandboxName], {
        cwd: SERVICE_DIR,
        stdio: "ignore",
        env: process.env,
      });
      child.once("error", finish);
      child.once("close", finish);
    } catch {
      finish();
    }
  });
}

function startSandbox(run, input, workspace, policy) {
  const workerPath = assertFile(WORKER_PATH, "NOOA worker");
  const workspacePath = workspace ? assertDirectory(workspace.cwd, "Configured NOOA workspace") : null;
  assertFile(policy.path, `OpenShell policy '${policy.id}'`);

  const args = buildOpenShellCreateArgs({
    sandboxName: run.sandboxName,
    policy,
    workerPath,
    inputPath: run.inputPath,
    workspacePath,
    runnerCwd: SERVICE_DIR,
    model: MODEL,
    maxIterations: Number.isFinite(MAX_ITERATIONS) && MAX_ITERATIONS > 0 ? Math.floor(MAX_ITERATIONS) : 12,
  });
  const child = spawn(OPENSHELL_BIN, args, {
    cwd: SERVICE_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  run.child = child;
  run.status = "running";
  publish(run, "sandbox.policy.decision", "sandbox", {
    policyId: policy.id,
    status: "selected",
    workspaceMode: workspace ? "snapshot" : "none",
  });
  publish(run, "agent.started", "runtime", { label: run.label, role: run.role, sandboxName: run.sandboxName });
  observeChildStream(run, child.stdout, "stdout");
  observeChildStream(run, child.stderr, "stderr");

  const timeout = setTimeout(() => {
    if (terminalStatuses.has(run.status)) return;
    run.cancelled = true;
    child.kill("SIGTERM");
    void deleteSandbox(run);
    finishRun(run, "failed", { message: `NOOA run exceeded ${OPEN_SHELL_TIMEOUT_MS}ms.` });
  }, OPEN_SHELL_TIMEOUT_MS);

  child.once("error", (error) => {
    clearTimeout(timeout);
    finishRun(run, "failed", { message: error.message });
  });
  child.once("close", (code, signal) => {
    clearTimeout(timeout);
    if (terminalStatuses.has(run.status)) return;
    if (run.cancelled) {
      finishRun(run, "cancelled", { sandboxName: run.sandboxName });
      return;
    }
    if (run.workerError || code !== 0) {
      finishRun(run, "failed", {
        message: run.workerError?.message || `OpenShell exited with code ${code ?? "unknown"}.`,
        code,
        signal,
      });
      return;
    }
    finishRun(run, "completed", { sandboxName: run.sandboxName });
  });
}

async function startRun(body, ownerId) {
  if (activeRunCount() >= MAX_CONCURRENT_RUNS) {
    throw new Error(`NOOA runner is at its ${MAX_CONCURRENT_RUNS}-run concurrency limit.`);
  }
  const input = normalizeNooaRun(body.run);
  const workspace = resolveWorkspace(input, WORKSPACES, DEFAULT_CWD);
  const policy = resolveOpenShellPolicy(input.sandbox.policyId, POLICIES);
  const runId = randomUUID();
  mkdirSync(RUNS_DIR, { recursive: true, mode: 0o700 });
  const inputDirectory = mkdtempSync(path.join(RUNS_DIR, "run-"));
  const inputPath = path.join(inputDirectory, "run.json");
  const run = makeRunRecord({ runId, ownerId, input, workspace, policy, inputPath });
  runs.set(runId, run);
  publish(run, "run.queued", "runtime", { policyId: policy.id });

  try {
    writeFileSync(inputPath, JSON.stringify(makeSandboxInput(run, input, workspace)), { encoding: "utf8", mode: 0o600, flag: "wx" });
    startSandbox(run, input, workspace, policy);
    return run;
  } catch (error) {
    finishRun(run, "failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function checkRunnerConfiguration() {
  assertFile(WORKER_PATH, "NOOA worker");
  if (!POLICIES.size) {
    throw new Error("No OpenShell policies configured. Set NOOA_OPENSHELL_POLICIES_JSON.");
  }
  for (const policy of POLICIES.values()) assertFile(policy.path, `OpenShell policy '${policy.id}'`);
}

function checkOpenShellReady() {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["status"], { cwd: SERVICE_DIR, stdio: "ignore", env: process.env });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("OpenShell status check timed out."));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Unable to start OpenShell: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("OpenShell gateway is not ready. Run 'openshell status' locally for details."));
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    return json(res, 200, {
      ok: true,
      runtime: "nooa",
      runs: runs.size,
      activeRuns: activeRunCount(),
      workspaceCount: WORKSPACES.size,
      policyCount: POLICIES.size,
    });
  }
  if (!authorize(req)) return json(res, 401, { error: "Unauthorized." });

  try {
    if (url.pathname === "/readyz" && req.method === "GET") {
      checkRunnerConfiguration();
      await checkOpenShellReady();
      return json(res, 200, { ok: true, runtime: "nooa", openshellReady: true, policyCount: POLICIES.size });
    }

    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readJson(req);
      if (!isRecord(body)) return json(res, 400, { error: "Request body must be a JSON object." });
      const ownerId = ownerFrom(req, body);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      const run = await startRun(body, ownerId);
      return json(res, 202, {
        runId: run.runId,
        runtime: "nooa",
        nodeId: run.nodeId,
        status: run.status,
        providerRunId: run.sandboxName,
      });
    }

    const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (eventsMatch && req.method === "GET") {
      const run = runs.get(decodeURIComponent(eventsMatch[1]));
      const ownerId = ownerFrom(req, {});
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Run not found." });
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      const afterEventId = asString(url.searchParams.get("after")) || asString(req.headers["last-event-id"]);
      let backlog = run.events;
      if (afterEventId) {
        const cursor = run.events.findIndex((event) => event.id === afterEventId);
        backlog = cursor >= 0 ? run.events.slice(cursor + 1) : [];
      }
      for (const event of backlog) writeSse(res, event);
      run.subscribers.add(res);
      const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(keepAlive);
        run.subscribers.delete(res);
      });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const run = runs.get(decodeURIComponent(cancelMatch[1]));
      const ownerId = ownerFrom(req, {});
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Run not found." });
      if (!terminalStatuses.has(run.status)) {
        run.cancelled = true;
        run.child?.kill("SIGTERM");
        await deleteSandbox(run);
        finishRun(run, "cancelled", { sandboxName: run.sandboxName });
      }
      return json(res, 200, { ok: true, runId: run.runId, status: run.status });
    }

    return json(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("[nooa-runner] request failed");
    return json(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nodes NOOA Runner listening on http://${HOST}:${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const run of runs.values()) {
      if (terminalStatuses.has(run.status)) continue;
      run.cancelled = true;
      run.child?.kill("SIGTERM");
      void deleteSandbox(run);
    }
    server.close(() => process.exit(0));
  });
}
