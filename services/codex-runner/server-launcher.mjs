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

const patched = source.includes(before) ? source.replace(before, after) : source;
if (patched === source && !source.includes(after)) {
  throw new Error("Unable to apply Codex approval compatibility patch: expected approval publish statement was not found.");
}

const runtimePath = path.join(os.tmpdir(), `nodes-codex-runner-${process.pid}.mjs`);
await writeFile(runtimePath, patched, "utf8");
await import(pathToFileURL(runtimePath).href);
