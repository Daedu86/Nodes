import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(runnerDir, "server.mjs");
const source = await readFile(sourcePath, "utf8");

// Codex app-server approval requests are JSON-RPC server requests. The only
// identifier that can be used to answer the request is message.id. Some Codex
// request payloads also contain an optional params.approvalId; if params is
// spread after our canonical id it overwrites message.id and the Canvas later
// sends an id that the runner cannot resolve. Keep the JSON-RPC request id last
// so it is always the canonical approval id exposed to the Canvas.
const before = 'publish(run, { method: "approval/requested", params: { approvalId, approvalMethod: method, ...params } });';
const after = 'publish(run, { method: "approval/requested", params: { ...params, approvalMethod: method, approvalId } });';

let patched = source.includes(before) ? source.replace(before, after) : source;
if (patched === source && !source.includes(after)) {
  throw new Error("Unable to apply Codex approval compatibility patch: expected approval publish statement was not found.");
}

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
// control plane remains on CODEX_RUNNER_PORT; the Tycho evolution worker uses
// TYCHO_EVOLUTION_RUNNER_PORT (default CODEX_RUNNER_PORT + 1).
await import(pathToFileURL(runtimePath).href);
await import(pathToFileURL(path.join(runnerDir, "evolution-server.mjs")).href);
