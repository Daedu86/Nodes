import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { readTychoReadiness } from "./tycho-readiness.mjs";
import { materializeWorkspaceFiles } from "./workspace-artifacts.mjs";

const PORT = Number(process.env.CODEX_RUNNER_PORT || 8787);
const HOST = process.env.CODEX_RUNNER_HOST || "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const MODEL = process.env.CODEX_RUNNER_MODEL?.trim() || "gpt-5.6-luna";
const RUNNER_TOKEN = process.env.CODEX_RUNNER_TOKEN?.trim() || null;
const DEFAULT_CWD = process.env.CODEX_DEFAULT_CWD?.trim() || null;
const AUTO_APPROVE = process.env.CODEX_RUNNER_AUTO_APPROVE === "1";
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_RUNNER_REQUEST_TIMEOUT_MS || 30_000);
const APPROVAL_TIMEOUT_MS = Number(process.env.CODEX_RUNNER_APPROVAL_TIMEOUT_MS || 300_000);
const MAX_EVENT_BACKLOG = 500;

const runs = new Map();
const runByThreadId = new Map();
const runByTurnId = new Map();
const approvals = new Map();

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function parseWorkspaceMap() {
  const raw = process.env.CODEX_WORKSPACES_JSON?.trim();
  if (!raw) return new Map();
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("CODEX_WORKSPACES_JSON must be an object.");
  return new Map(
    Object.entries(parsed).flatMap(([workspaceId, value]) => {
      const cwd = asString(value);
      return cwd ? [[workspaceId, path.resolve(cwd)]] : [];
    }),
  );
}

const WORKSPACES = parseWorkspaceMap();

function assertWorkspacePath(cwd) {
  const resolved = path.resolve(cwd);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`Configured Codex workspace does not exist or is not a directory: ${resolved}`);
  }
  return resolved;
}

function resolveWorkspace(body) {
  const workspaceId = asString(body.workspaceId);
  if (workspaceId) {
    const configured = WORKSPACES.get(workspaceId);
    if (!configured) throw new Error(`Unknown Codex workspace id: ${workspaceId}`);
    return { workspaceId, cwd: assertWorkspacePath(configured) };
  }
  if (DEFAULT_CWD) return { workspaceId: null, cwd: assertWorkspacePath(DEFAULT_CWD) };
  throw new Error("No Codex workspace configured. Set CODEX_DEFAULT_CWD or CODEX_WORKSPACES_JSON on the runner.");
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

function getNested(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current ?? null;
}

function getNestedString(value, keys) {
  return asString(getNested(value, keys));
}

function inferThreadId(params) {
  if (!isRecord(params)) return null;
  return asString(params.threadId) || asString(params.thread_id) || getNestedString(params, ["thread", "id"]) || getNestedString(params, ["item", "threadId"]) || getNestedString(params, ["item", "thread_id"]);
}

function inferTurnId(params) {
  if (!isRecord(params)) return null;
  return asString(params.turnId) || asString(params.turn_id) || getNestedString(params, ["turn", "id"]) || getNestedString(params, ["item", "turnId"]) || getNestedString(params, ["item", "turn_id"]);
}

function inferParentThreadId(params) {
  if (!isRecord(params)) return null;
  return asString(params.parentThreadId) || asString(params.parent_thread_id) || getNestedString(params, ["thread", "parentThreadId"]) || getNestedString(params, ["thread", "parent_thread_id"]);
}

function findRunForParams(params) {
  const threadId = inferThreadId(params);
  if (threadId && runByThreadId.has(threadId)) return runs.get(runByThreadId.get(threadId)) || null;
  const turnId = inferTurnId(params);
  if (turnId && runByTurnId.has(turnId)) return runs.get(runByTurnId.get(turnId)) || null;
  const parentThreadId = inferParentThreadId(params);
  if (parentThreadId && runByThreadId.has(parentThreadId)) return runs.get(runByThreadId.get(parentThreadId)) || null;
  return null;
}

function makeEnvelope(run, notification) {
  return {
    id: randomUUID(),
    runId: run.runId,
    threadId: run.threadId,
    parentRunId: run.parentRunId,
    agentId: run.agentId,
    sessionId: run.sessionId,
    projectId: run.projectId,
    createdAt: new Date().toISOString(),
    notification,
  };
}

function writeSse(res, envelope) {
  res.write(`id: ${envelope.id}\n`);
  res.write(`data: ${JSON.stringify(envelope)}\n\n`);
}

function publish(run, notification) {
  const envelope = makeEnvelope(run, notification);
  run.events.push(envelope);
  if (run.events.length > MAX_EVENT_BACKLOG) run.events.splice(0, run.events.length - MAX_EVENT_BACKLOG);
  for (const subscriber of run.subscribers) writeSse(subscriber, envelope);
  return envelope;
}

function updateRunStatus(run, method, params) {
  if (method === "turn/started") run.status = "running";
  if (method === "turn/completed") {
    const rawStatus = getNestedString(params, ["turn", "status"]) || asString(params?.status);
    run.status = rawStatus === "failed" ? "failed" : ["interrupted", "cancelled", "canceled"].includes(rawStatus) ? "cancelled" : "completed";
  }
  if (method === "turn/failed") run.status = "failed";
}

function makeRunRecord(input) {
  return {
    runId: input.runId || randomUUID(),
    agentId: input.agentId || `codex-${randomUUID().slice(0, 8)}`,
    ownerId: input.ownerId,
    parentRunId: input.parentRunId || null,
    sessionId: input.sessionId || null,
    projectId: input.projectId || null,
    workspaceId: input.workspaceId || null,
    cwd: input.cwd || null,
    role: input.role || "coder",
    label: input.label || "Codex Agent",
    approvalMode: input.approvalMode === "tycho-isolated" ? "tycho-isolated" : "interactive",
    workspaceArtifactPaths: Array.isArray(input.workspaceArtifactPaths) ? input.workspaceArtifactPaths : [],
    status: input.status || "queued",
    threadId: input.threadId || null,
    turnId: input.turnId || null,
    events: [],
    subscribers: new Set(),
    createdAt: new Date().toISOString(),
  };
}

function registerRun(run) {
  runs.set(run.runId, run);
  if (run.threadId) runByThreadId.set(run.threadId, run.runId);
  if (run.turnId) runByTurnId.set(run.turnId, run.runId);
  return run;
}

function spawnChildRun(parentRun, params) {
  const childThreadId = inferThreadId(params);
  if (!childThreadId || childThreadId === parentRun.threadId) return null;
  const existingRunId = runByThreadId.get(childThreadId);
  if (existingRunId) return runs.get(existingRunId) || null;
  const thread = isRecord(params?.thread) ? params.thread : {};
  const child = registerRun(makeRunRecord({
    ownerId: parentRun.ownerId,
    parentRunId: parentRun.runId,
    sessionId: parentRun.sessionId,
    projectId: parentRun.projectId,
    workspaceId: parentRun.workspaceId,
    cwd: parentRun.cwd,
    role: "custom",
    label: asString(thread.name) || "Codex Subagent",
    approvalMode: parentRun.approvalMode,
    workspaceArtifactPaths: parentRun.workspaceArtifactPaths,
    status: "running",
    threadId: childThreadId,
  }));
  publish(parentRun, { method: "agent/child/spawned", params: { childRunId: child.runId, childThreadId, childAgentId: child.agentId, parentRunId: parentRun.runId, parentThreadId: parentRun.threadId, label: child.label, role: child.role } });
  publish(child, { method: "thread/started", params });
  return child;
}

function deniedApprovalResult(method) {
  return method.toLowerCase().includes("permissions/requestapproval")
    ? { scope: "turn", permissions: {} }
    : { decision: "decline" };
}

class CodexAppServer {
  constructor() {
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
  }

  async ensureStarted() {
    if (this.proc) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  async start() {
    const proc = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    this.proc = proc;
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => process.stderr.write(`[codex] ${chunk}`));
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));
    proc.on("exit", (code, signal) => this.handleExit(code, signal));
    proc.on("error", (error) => this.handleExit(null, error.message));
    await this.request("initialize", { clientInfo: { name: "nodes_ai_canvas", title: "Nodes AI Canvas Codex Runner", version: "0.3.0" }, capabilities: { experimentalApi: true } });
    this.notify("initialized");
  }

  write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex app-server is not running.");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = String(this.nextId++);
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { console.warn("[codex-runner] ignoring non-JSON stdout line", line.slice(0, 300)); return; }
    if (!isRecord(message)) return;
    if (message.method && message.id !== undefined) { void this.handleServerRequest(message); return; }
    if (message.method) { this.handleNotification(message.method, message.params); return; }
    if (message.id !== undefined) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message || `Codex request failed: ${pending.method}`));
      else pending.resolve(message.result);
    }
  }

  async handleServerRequest(message) {
    const method = String(message.method);
    const params = isRecord(message.params) ? message.params : {};
    const run = findRunForParams(params);
    if (!method.toLowerCase().includes("requestapproval")) { this.write({ id: message.id, result: {} }); return; }
    if (!run) { this.write({ id: message.id, result: { decision: AUTO_APPROVE ? "accept" : "decline" } }); return; }

    const approvalId = String(message.id);
    if (run.approvalMode === "tycho-isolated") {
      publish(run, { method: "approval/requested", params: { approvalId, approvalMethod: method, ...params } });
      this.write({ id: message.id, result: deniedApprovalResult(method) });
      publish(run, { method: "approval/resolved", params: { approvalId, decision: "decline", automatic: true, reason: "tycho-isolated sandbox boundary" } });
      return;
    }

    run.status = "waiting_for_approval";
    publish(run, { method: "approval/requested", params: { approvalId, approvalMethod: method, ...params } });
    if (AUTO_APPROVE) {
      this.write({ id: message.id, result: { decision: "accept" } });
      run.status = "running";
      publish(run, { method: "approval/resolved", params: { approvalId, decision: "accept", automatic: true } });
      return;
    }
    const timeout = setTimeout(() => {
      if (!approvals.has(approvalId)) return;
      approvals.delete(approvalId);
      this.write({ id: message.id, result: { decision: "decline" } });
      run.status = "running";
      publish(run, { method: "approval/resolved", params: { approvalId, decision: "decline", timeout: true } });
    }, APPROVAL_TIMEOUT_MS);
    approvals.set(approvalId, { approvalId, rpcId: message.id, runId: run.runId, timeout });
  }

  handleNotification(method, params) {
    const threadId = inferThreadId(params);
    const parentThreadId = inferParentThreadId(params);
    if (method === "thread/started" && threadId && parentThreadId && threadId !== parentThreadId) {
      const parentRunId = runByThreadId.get(parentThreadId);
      const parentRun = parentRunId ? runs.get(parentRunId) : null;
      if (parentRun) {
        const child = spawnChildRun(parentRun, params);
        if (child) return;
      }
    }
    const run = findRunForParams(params);
    if (!run) return;
    const turnId = inferTurnId(params);
    if (threadId && !run.threadId) { run.threadId = threadId; runByThreadId.set(threadId, run.runId); }
    if (turnId && !run.turnId) { run.turnId = turnId; runByTurnId.set(turnId, run.runId); }
    updateRunStatus(run, method, params);
    publish(run, { method, params });
  }

  handleExit(code, signal) {
    this.proc = null;
    const reason = `Codex app-server exited (${code ?? "no-code"}, ${signal ?? "no-signal"}).`;
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(new Error(reason)); }
    this.pending.clear();
    for (const run of runs.values()) {
      if (["completed", "failed", "cancelled"].includes(run.status)) continue;
      run.status = "failed";
      publish(run, { method: "turn/failed", params: { message: reason } });
    }
  }

  stop() { this.proc?.kill("SIGTERM"); this.proc = null; }
}

const codex = new CodexAppServer();

async function readAccountUsage() {
  await codex.ensureStarted();
  const account = await codex.request("account/read", {});
  const rateLimits = await codex.request("account/rateLimits/read", {}).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const usage = await codex.request("account/usage/read", {}).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  return { account, rateLimits, usage, updatedAt: new Date().toISOString() };
}

async function startRun(body, ownerId) {
  await codex.ensureStarted();
  const parentRunId = asString(body.parentRunId);
  const parentRun = parentRunId ? runs.get(parentRunId) : null;
  if (parentRunId && (!parentRun || parentRun.ownerId !== ownerId)) throw new Error("Parent Codex run was not found for this owner.");
  const workspace = parentRun ? { workspaceId: parentRun.workspaceId, cwd: parentRun.cwd } : resolveWorkspace(body);
  const approvalMode = parentRun?.approvalMode || (asString(body.approvalMode) === "tycho-isolated" ? "tycho-isolated" : "interactive");

  let workspaceArtifacts = parentRun
    ? { count: parentRun.workspaceArtifactPaths.length, created: 0, unchanged: parentRun.workspaceArtifactPaths.length, paths: parentRun.workspaceArtifactPaths }
    : materializeWorkspaceFiles(workspace.cwd, body.workspaceFiles);

  if (approvalMode === "tycho-isolated") {
    const tycho = await readTychoReadiness();
    if (!tycho.tychoReady || !["docker", "finch"].includes(tycho.tychoRuntime)) {
      throw new Error("Tycho-isolated run requested, but Docker/Finch isolation is not ready.");
    }
    if (!workspaceArtifacts.paths.includes(".nodes/tycho-experiment.json")) {
      throw new Error("Tycho-isolated run requires the authoritative .nodes/tycho-experiment.json primary-session artifact.");
    }
  }

  const runId = randomUUID();
  const run = registerRun(makeRunRecord({ runId, agentId: asString(body.agentId) || `codex-${runId.slice(0, 8)}`, ownerId, parentRunId, sessionId: asString(body.sessionId), projectId: asString(body.projectId), workspaceId: workspace.workspaceId, cwd: workspace.cwd, role: asString(body.role) || "coder", label: asString(body.label) || (parentRun ? "Codex Subagent" : "Codex Agent"), approvalMode, workspaceArtifactPaths: workspaceArtifacts.paths }));
  try {
    const threadParams = { cwd: workspace.cwd, model: MODEL };
    if (approvalMode === "tycho-isolated") {
      threadParams.approvalPolicy = "never";
      threadParams.sandbox = "workspaceWrite";
    }
    const threadResult = await codex.request("thread/start", threadParams);
    const threadId = getNestedString(threadResult, ["thread", "id"]);
    if (!threadId) throw new Error("Codex did not return a thread id.");
    run.threadId = threadId;
    runByThreadId.set(threadId, runId);
    publish(run, { method: "thread/started", params: { threadId, thread: threadResult.thread, approvalMode, workspaceArtifacts } });
    const turnResult = await codex.request("turn/start", { threadId, input: [{ type: "text", text: String(body.prompt || "") }] });
    const turnId = getNestedString(turnResult, ["turn", "id"]);
    if (!turnId) throw new Error("Codex did not return a turn id.");
    run.turnId = turnId;
    runByTurnId.set(turnId, runId);
    run.status = "running";
    publish(run, { method: "turn/started", params: { threadId, turnId, turn: turnResult.turn } });
    return run;
  } catch (error) {
    run.status = "failed";
    publish(run, { method: "turn/failed", params: { message: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
}

function resolveApproval(run, approvalId, decision) {
  const approval = approvals.get(approvalId);
  if (!approval || approval.runId !== run.runId) return false;
  clearTimeout(approval.timeout);
  approvals.delete(approvalId);
  codex.write({ id: approval.rpcId, result: { decision } });
  run.status = decision === "cancel" ? "cancelled" : "running";
  publish(run, { method: "approval/resolved", params: { approvalId, decision, automatic: false } });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") return json(res, 200, { ok: true, codexRunning: Boolean(codex.proc), model: MODEL, runs: runs.size, workspaceCount: WORKSPACES.size, hasDefaultWorkspace: Boolean(DEFAULT_CWD) });
  if (!authorize(req)) return json(res, 401, { error: "Unauthorized." });

  try {
    if (url.pathname === "/readyz" && req.method === "GET") {
      await codex.ensureStarted();
      const [account, tycho] = await Promise.all([
        codex.request("account/read", {}),
        readTychoReadiness(),
      ]);
      return json(res, 200, {
        ok: true,
        codexRunning: true,
        model: MODEL,
        authenticated: Boolean(account),
        workspaceCount: WORKSPACES.size,
        workspaceIds: [...WORKSPACES.keys()],
        hasDefaultWorkspace: Boolean(DEFAULT_CWD),
        ...tycho,
      });
    }

    if (url.pathname === "/v1/account/usage" && req.method === "GET") {
      const snapshot = await readAccountUsage();
      return json(res, 200, { ok: true, ...snapshot });
    }

    if (req.method === "POST" && url.pathname === "/v1/runs") {
      const body = await readJson(req);
      const ownerId = ownerFrom(req, body);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      if (!asString(body.sessionId) || !asString(body.prompt)) return json(res, 400, { error: "Missing sessionId or prompt." });
      const run = await startRun(body, ownerId);
      return json(res, 202, { runId: run.runId, threadId: run.threadId, status: run.status, agentId: run.agentId, parentRunId: run.parentRunId });
    }

    const eventsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/events$/);
    if (req.method === "GET" && eventsMatch) {
      const run = runs.get(decodeURIComponent(eventsMatch[1]));
      const ownerId = ownerFrom(req, {});
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Run not found." });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      const afterEventId = asString(url.searchParams.get("after")) || asString(req.headers["last-event-id"]);
      let backlog = run.events;
      if (afterEventId) {
        const cursor = run.events.findIndex((event) => event.id === afterEventId);
        backlog = cursor >= 0 ? run.events.slice(cursor + 1) : [];
      }
      for (const event of backlog) writeSse(res, event);
      run.subscribers.add(res);
      const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
      req.on("close", () => { clearInterval(keepAlive); run.subscribers.delete(res); });
      return;
    }

    const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const run = runs.get(decodeURIComponent(cancelMatch[1]));
      const ownerId = ownerFrom(req, {});
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Run not found." });
      if (run.threadId && run.turnId && !["completed", "failed", "cancelled"].includes(run.status)) await codex.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
      run.status = "cancelled";
      publish(run, { method: "turn/cancelled", params: { threadId: run.threadId, turnId: run.turnId } });
      return json(res, 200, { ok: true, runId: run.runId, status: run.status });
    }

    const approvalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/approvals\/([^/]+)$/);
    if (req.method === "POST" && approvalMatch) {
      const run = runs.get(decodeURIComponent(approvalMatch[1]));
      const approvalId = decodeURIComponent(approvalMatch[2]);
      const ownerId = ownerFrom(req, {});
      if (!run || run.ownerId !== ownerId) return json(res, 404, { error: "Run not found." });
      const body = await readJson(req);
      const decision = asString(body.decision);
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(decision)) return json(res, 400, { error: "Invalid approval decision." });
      if (!resolveApproval(run, approvalId, decision)) return json(res, 404, { error: "Approval request not found." });
      return json(res, 200, { ok: true, runId: run.runId, approvalId, decision });
    }

    return json(res, 404, { error: "Not found." });
  } catch (error) {
    console.error("[codex-runner] request failed", error);
    return json(res, 500, { error: error instanceof Error ? error.message : "Internal error." });
  }
});

server.listen(PORT, HOST, () => console.log(`Nodes Codex Runner listening on http://${HOST}:${PORT}`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { codex.stop(); server.close(() => process.exit(0)); });
}
