import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(runnerDir, "server.mjs");
const source = await readFile(sourcePath, "utf8");

const replaceRequired = (input, before, after, label) => {
  if (input.includes(after)) return input;
  if (!input.includes(before)) throw new Error(`Unable to apply Codex runtime patch: ${label}`);
  return input.replace(before, after);
};

// Codex app-server approval requests are JSON-RPC server requests. The only
// identifier that can be used to answer the request is message.id. Some Codex
// request payloads also contain an optional params.approvalId; if params is
// spread after our canonical id it overwrites message.id and the Canvas later
// sends an id that the runner cannot resolve. Keep the JSON-RPC request id last
// so it is always the canonical approval id exposed to the Canvas.
const approvalBefore = 'publish(run, { method: "approval/requested", params: { approvalId, approvalMethod: method, ...params } });';
const approvalAfter = 'publish(run, { method: "approval/requested", params: { ...params, approvalMethod: method, approvalId } });';
let patched = replaceRequired(source, approvalBefore, approvalAfter, "approval request identity");

// Hypothesis generation is stricter than interactive Codex. It receives a
// read-only sandbox and approvalPolicy=never at the runner boundary; any
// approval request is declined before Canvas can authorize a side effect.
patched = replaceRequired(
  patched,
  'approvalMode: input.approvalMode === "tycho-isolated" ? "tycho-isolated" : "interactive",',
  'approvalMode: input.approvalMode === "tycho-isolated" ? "tycho-isolated" : input.approvalMode === "hypothesis-only" ? "hypothesis-only" : "interactive",',
  "hypothesis-only run record",
);
patched = replaceRequired(
  patched,
  'const approvalMode = parentRun?.approvalMode || (asString(body.approvalMode) === "tycho-isolated" ? "tycho-isolated" : "interactive");',
  'const requestedApprovalMode = asString(body.approvalMode);\n  const approvalMode = parentRun?.approvalMode || (requestedApprovalMode === "tycho-isolated" ? "tycho-isolated" : requestedApprovalMode === "hypothesis-only" ? "hypothesis-only" : "interactive");',
  "hypothesis-only request mode",
);
patched = replaceRequired(
  patched,
  'if (run.approvalMode === "tycho-isolated") {',
  'if (run.approvalMode === "tycho-isolated" || run.approvalMode === "hypothesis-only") {',
  "hypothesis-only automatic approval denial",
);
patched = replaceRequired(
  patched,
  'if (approvalMode === "tycho-isolated") {\n      threadParams.approvalPolicy = "never";\n      threadParams.sandbox = "workspaceWrite";\n    }',
  'if (approvalMode === "tycho-isolated" || approvalMode === "hypothesis-only") {\n      threadParams.approvalPolicy = "never";\n      threadParams.sandbox = approvalMode === "hypothesis-only" ? "readOnly" : "workspaceWrite";\n    }',
  "hypothesis-only read-only sandbox",
);

// server.mjs is executed from a generated file under /tmp. Relative module
// imports would therefore resolve against /tmp rather than this runner
// directory. Rewrite known runner-local imports to absolute file URLs before
// writing the generated runtime module.
const bindLocalImport = (input, fileName) => {
  const relativeImport = `from "./${fileName}";`;
  if (!input.includes(relativeImport)) {
    throw new Error(`Unable to bind runner-local module: ${fileName}`);
  }
  const fileUrl = pathToFileURL(path.join(runnerDir, fileName)).href;
  return input.replace(relativeImport, `from ${JSON.stringify(fileUrl)};`);
};

patched = bindLocalImport(patched, "tycho-readiness.mjs");
patched = bindLocalImport(patched, "workspace-artifacts.mjs");

const runtimePath = path.join(os.tmpdir(), `nodes-codex-runner-${process.pid}.mjs`);
await writeFile(runtimePath, patched, "utf8");

// Both listeners live on the trusted runner machine. The existing Codex
// control plane remains on CODEX_RUNNER_PORT; Tycho candidate execution and the
// durable episode orchestrator share TYCHO_EVOLUTION_RUNNER_PORT. Kubernetes
// execution swaps only this second listener; the Codex hypothesis generator and
// durable episode contract stay unchanged.
const executionBackend = (process.env.TYCHO_EVOLUTION_EXECUTION_BACKEND || "local").trim().toLowerCase();
if (!["local", "kubernetes"].includes(executionBackend)) {
  throw new Error("TYCHO_EVOLUTION_EXECUTION_BACKEND must be local or kubernetes.");
}
const evolutionServerFile = executionBackend === "kubernetes"
  ? "evolution-server-kubernetes.mjs"
  : "evolution-server.mjs";

await import(pathToFileURL(runtimePath).href);
await import(pathToFileURL(path.join(runnerDir, evolutionServerFile)).href);
