import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";

import { normalizeWorkspaceFiles } from "./workspace-artifacts.mjs";
import { parseTychoEvolutionResult } from "./evolution-result.mjs";

const RESULT_MARKER = "__NODES_TYCHO_RESULT_V1__";
const MAX_KUBECTL_OUTPUT_CHARS = 2_000_000;
const MAX_PAYLOAD_BYTES = 650_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const labelValue = (value) => String(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 63) || "unknown";

function parseWorkspaceMap(raw = process.env.TYCHO_KUBERNETES_WORKSPACES_JSON) {
  const text = raw?.trim();
  if (!text) return new Map();
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("TYCHO_KUBERNETES_WORKSPACES_JSON must be an object.");
  const entries = [];
  for (const [workspaceId, value] of Object.entries(parsed)) {
    if (!workspaceId.trim()) continue;
    if (typeof value === "string" && value.trim()) {
      entries.push([workspaceId, { persistentVolumeClaim: value.trim(), subPath: null }]);
      continue;
    }
    if (!isRecord(value)) throw new Error(`Kubernetes workspace ${workspaceId} must be a PVC name or object.`);
    const persistentVolumeClaim = asString(value.persistentVolumeClaim || value.pvc);
    if (!persistentVolumeClaim) throw new Error(`Kubernetes workspace ${workspaceId} requires persistentVolumeClaim.`);
    entries.push([workspaceId, { persistentVolumeClaim, subPath: asString(value.subPath) }]);
  }
  return new Map(entries);
}

function runCommand(bin, args, { input = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      const next = current + String(chunk || "");
      return next.length <= MAX_KUBECTL_OUTPUT_CHARS ? next : next.slice(next.length - MAX_KUBECTL_OUTPUT_CHARS);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

const INIT_SCRIPT = String.raw`
import json, os, pathlib, shutil
src = pathlib.Path('/source')
dst = pathlib.Path('/workspace')
excludes = {'.git', '.next', 'node_modules', '.venv', '__pycache__', '.pytest_cache', 'dist', 'build'}
def ignore(_dir, names):
    return [name for name in names if name in excludes]
for child in src.iterdir():
    if child.name in excludes:
        continue
    target = dst / child.name
    if child.is_symlink():
        continue
    if child.is_dir():
        shutil.copytree(child, target, dirs_exist_ok=True, symlinks=False, ignore=ignore)
    elif child.is_file():
        shutil.copy2(child, target)
payload = json.loads(pathlib.Path('/inputs/payload.json').read_text(encoding='utf-8'))
root = dst.resolve()
for item in payload['workspaceFiles']:
    rel = pathlib.PurePosixPath(item['path'])
    if rel.is_absolute() or '..' in rel.parts:
        raise SystemExit('workspace file escaped destination')
    target = (root / pathlib.Path(*rel.parts)).resolve()
    target.relative_to(root)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(item['content'], encoding='utf-8')
`;

const RUN_SCRIPT = String.raw`
import base64, pathlib, subprocess, sys
cmd = ['tycho-experiment', '--workspace', '/workspace', '--protocol', '.nodes/tycho-experiment.json', '--result', '.nodes/tycho-result.json']
completed = subprocess.run(cmd, cwd='/workspace', check=False)
result_path = pathlib.Path('/workspace/.nodes/tycho-result.json')
if result_path.is_file():
    encoded = base64.b64encode(result_path.read_bytes()).decode('ascii')
    print('${RESULT_MARKER}' + encoded, flush=True)
if completed.returncode in (0, 3, 4):
    raise SystemExit(0)
raise SystemExit(completed.returncode or 2)
`;

export function createKubernetesEvolutionBackend(options = {}) {
  const kubectl = options.kubectl || process.env.KUBECTL_BIN?.trim() || "kubectl";
  const context = options.context ?? process.env.TYCHO_KUBERNETES_CONTEXT?.trim() ?? null;
  const namespace = options.namespace || process.env.TYCHO_KUBERNETES_NAMESPACE?.trim() || "nodes-evolution";
  const image = options.image || process.env.TYCHO_KUBERNETES_IMAGE?.trim() || null;
  const imagePullPolicy = options.imagePullPolicy || process.env.TYCHO_KUBERNETES_IMAGE_PULL_POLICY?.trim() || "IfNotPresent";
  const ttlSecondsAfterFinished = Number(options.ttlSecondsAfterFinished ?? process.env.TYCHO_KUBERNETES_TTL_SECONDS ?? 3600);
  const runnerId = labelValue(options.runnerId || process.env.TYCHO_KUBERNETES_RUNNER_ID || os.hostname());
  const workspaces = options.workspaces || parseWorkspaceMap();

  const baseArgs = () => context ? ["--context", context] : [];
  const namespaced = (...args) => [...baseArgs(), "-n", namespace, ...args];
  const kubectlJson = async (args, opts = {}) => {
    const completed = await runCommand(kubectl, args, opts);
    if (completed.code !== 0) {
      throw new Error(`kubectl ${args.join(" ")} failed: ${completed.stderr.trim() || completed.stdout.trim() || `exit ${completed.code}`}`);
    }
    return completed.stdout.trim() ? JSON.parse(completed.stdout) : {};
  };
  const kubectlText = async (args, opts = {}) => {
    const completed = await runCommand(kubectl, args, opts);
    if (completed.code !== 0) {
      throw new Error(`kubectl ${args.join(" ")} failed: ${completed.stderr.trim() || completed.stdout.trim() || `exit ${completed.code}`}`);
    }
    return completed.stdout;
  };

  const resourceNames = (runId) => {
    const suffix = runId.replaceAll("-", "").slice(0, 24);
    return { jobName: `tycho-${suffix}`, configMapName: `tycho-input-${suffix}` };
  };

  function validateStart(input) {
    if (!image) throw new Error("TYCHO_KUBERNETES_IMAGE is required for Kubernetes evolution execution.");
    const ownerId = asString(input.ownerId);
    const workspaceId = asString(input.workspaceId);
    const experimentId = asString(input.experimentId);
    const candidateKey = asString(input.candidateKey);
    if (!ownerId || !workspaceId || !experimentId || !candidateKey) {
      throw new Error("Kubernetes evolution requires ownerId, workspaceId, experimentId, and candidateKey.");
    }
    const workspace = workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown Kubernetes evolution workspace id: ${workspaceId}`);
    const workspaceFiles = normalizeWorkspaceFiles(input.workspaceFiles);
    const protocolFile = workspaceFiles.find((file) => file.path === ".nodes/tycho-experiment.json");
    if (!protocolFile) throw new Error("Kubernetes evolution requires .nodes/tycho-experiment.json.");
    const protocol = JSON.parse(protocolFile.content);
    if (!isRecord(protocol) || protocol.schemaVersion !== 1 || protocol.experimentId !== experimentId) {
      throw new Error("Kubernetes evolution protocol identity is invalid.");
    }
    const payload = JSON.stringify({ schemaVersion: 1, workspaceFiles });
    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error("Kubernetes evolution workspace-file payload exceeds the ConfigMap budget.");
    }
    return { ownerId, workspaceId, experimentId, candidateKey, workspace, workspaceFiles, payload };
  }

  function publicRun(job, runId, fallback = {}) {
    const status = job?.status || {};
    const failed = Number(status.failed || 0) > 0;
    const completed = Number(status.succeeded || 0) > 0;
    const state = completed ? "completed" : failed ? "failed" : "running";
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const failure = conditions.find((condition) => condition.type === "Failed" && condition.status === "True");
    const annotations = job?.metadata?.annotations || {};
    return {
      runId,
      workspaceId: annotations["nodes.ai/workspace-id"] || fallback.workspaceId || null,
      projectId: annotations["nodes.ai/project-id"] || fallback.projectId || null,
      sessionId: annotations["nodes.ai/session-id"] || fallback.sessionId || null,
      candidateKey: annotations["nodes.ai/candidate-key"] || fallback.candidateKey || null,
      experimentId: annotations["nodes.ai/experiment-id"] || fallback.experimentId || null,
      status: state,
      exitCode: completed ? 0 : null,
      error: failed ? (failure?.message || failure?.reason || "Kubernetes Job failed.") : null,
      createdAt: job?.metadata?.creationTimestamp || fallback.createdAt || new Date().toISOString(),
      finishedAt: completed || failed ? (status.completionTime || conditions.at(-1)?.lastTransitionTime || null) : null,
      backend: "kubernetes",
      namespace,
      jobName: job?.metadata?.name || resourceNames(runId).jobName,
    };
  }

  async function assertOwner(job, ownerId) {
    const expected = job?.metadata?.annotations?.["nodes.ai/owner-hash"];
    if (!expected || expected !== hash(ownerId)) {
      const error = new Error("Kubernetes evolution run not found.");
      error.statusCode = 404;
      throw error;
    }
  }

  async function start(input) {
    const validated = validateStart(input);
    const runId = randomUUID();
    const { jobName, configMapName } = resourceNames(runId);
    const labels = {
      "app.kubernetes.io/name": "nodes-tycho-evolution",
      "app.kubernetes.io/managed-by": "nodes-ai-canvas",
      "nodes.ai/runner-id": runnerId,
      "nodes.ai/network": "deny-all",
    };
    const annotations = {
      "nodes.ai/run-id": runId,
      "nodes.ai/owner-hash": hash(validated.ownerId),
      "nodes.ai/workspace-id": validated.workspaceId,
      "nodes.ai/experiment-id": validated.experimentId,
      "nodes.ai/candidate-key": validated.candidateKey,
      ...(asString(input.projectId) ? { "nodes.ai/project-id": asString(input.projectId) } : {}),
      ...(asString(input.sessionId) ? { "nodes.ai/session-id": asString(input.sessionId) } : {}),
    };
    const configMap = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: configMapName, namespace, labels, annotations },
      binaryData: { "payload.json": Buffer.from(validated.payload, "utf8").toString("base64") },
    };
    const sourceVolume = {
      name: "source",
      persistentVolumeClaim: { claimName: validated.workspace.persistentVolumeClaim, readOnly: true },
    };
    const sourceMount = {
      name: "source",
      mountPath: "/source",
      readOnly: true,
      ...(validated.workspace.subPath ? { subPath: validated.workspace.subPath } : {}),
    };
    const job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName, namespace, labels, annotations },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished,
        template: {
          metadata: { labels, annotations },
          spec: {
            restartPolicy: "Never",
            automountServiceAccountToken: false,
            securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
            initContainers: [{
              name: "prepare-workspace",
              image,
              imagePullPolicy,
              command: ["python", "-c", INIT_SCRIPT],
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              volumeMounts: [sourceMount, { name: "workspace", mountPath: "/workspace" }, { name: "inputs", mountPath: "/inputs", readOnly: true }, { name: "tmp", mountPath: "/tmp" }],
              resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } },
            }],
            containers: [{
              name: "tycho",
              image,
              imagePullPolicy,
              command: ["python", "-c", RUN_SCRIPT],
              workingDir: "/workspace",
              env: [
                { name: "TYCHO_SANDBOX_RUNTIME", value: "kubernetes" },
                { name: "TYCHO_KUBERNETES_ISOLATED", value: "1" },
                { name: "TYCHO_KUBERNETES_NETWORK_POLICY", value: "deny-all" },
                { name: "TYCHO_KUBERNETES_SERVICE_ACCOUNT_TOKEN", value: "disabled" },
                { name: "TYCHO_KUBERNETES_IMAGE", value: image },
              ],
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }, { name: "tmp", mountPath: "/tmp" }],
              resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } },
            }],
            volumes: [sourceVolume, { name: "workspace", emptyDir: { sizeLimit: "4Gi" } }, { name: "inputs", configMap: { name: configMapName } }, { name: "tmp", emptyDir: { sizeLimit: "256Mi" } }],
          },
        },
      },
    };

    await kubectlJson([...baseArgs(), "create", "-f", "-", "-o", "json"], { input: JSON.stringify(configMap) });
    try {
      const createdJob = await kubectlJson([...baseArgs(), "create", "-f", "-", "-o", "json"], { input: JSON.stringify(job) });
      return publicRun(createdJob, runId, input);
    } catch (error) {
      await kubectlText(namespaced("delete", "configmap", configMapName, "--ignore-not-found=true")).catch(() => null);
      throw error;
    }
  }

  async function get(ownerId, runId) {
    const { jobName } = resourceNames(runId);
    const job = await kubectlJson(namespaced("get", "job", jobName, "-o", "json"));
    await assertOwner(job, ownerId);
    return publicRun(job, runId);
  }

  async function getResult(ownerId, runId) {
    const run = await get(ownerId, runId);
    if (run.status === "running") throw new Error("Kubernetes evolution run is still running.");
    if (run.status !== "completed") throw new Error(run.error || "Kubernetes evolution result is unavailable.");
    const logs = await kubectlText(namespaced("logs", `job/${run.jobName}`, "-c", "tycho"), { timeoutMs: 60_000 });
    const markerIndex = logs.lastIndexOf(RESULT_MARKER);
    if (markerIndex < 0) throw new Error("Kubernetes Tycho Job did not emit a result marker.");
    const encoded = logs.slice(markerIndex + RESULT_MARKER.length).split(/\r?\n/, 1)[0]?.trim();
    if (!encoded) throw new Error("Kubernetes Tycho result marker is empty.");
    let parsed;
    try { parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
    catch (error) { throw new Error(`Unable to decode Kubernetes Tycho result: ${error instanceof Error ? error.message : String(error)}`); }
    const result = parseTychoEvolutionResult(parsed, run.experimentId);
    const { configMapName } = resourceNames(runId);
    await kubectlText(namespaced("delete", "configmap", configMapName, "--ignore-not-found=true")).catch(() => null);
    return { run, result };
  }

  async function cancel(ownerId, runId) {
    const run = await get(ownerId, runId);
    const { jobName, configMapName } = resourceNames(runId);
    await Promise.all([
      kubectlText(namespaced("delete", "job", jobName, "--ignore-not-found=true", "--wait=false")).catch(() => null),
      kubectlText(namespaced("delete", "configmap", configMapName, "--ignore-not-found=true")).catch(() => null),
    ]);
    return { ...run, status: "cancelled", error: "Evolution run cancelled.", finishedAt: new Date().toISOString() };
  }

  async function ready() {
    const readiness = {
      backend: "kubernetes",
      namespace,
      runnerId,
      image,
      workspaceIds: [...workspaces.keys()],
      kubernetesReady: false,
      kagentReady: false,
      errors: [],
    };
    if (!image) readiness.errors.push("TYCHO_KUBERNETES_IMAGE is not configured.");
    if (!workspaces.size) readiness.errors.push("TYCHO_KUBERNETES_WORKSPACES_JSON has no workspaces.");
    try {
      await kubectlJson(namespaced("get", "namespace", namespace, "-o", "json"));
      readiness.kubernetesReady = true;
    } catch (error) {
      // Namespace is cluster-scoped; retry without -n to avoid clients that reject it.
      try {
        await kubectlJson([...baseArgs(), "get", "namespace", namespace, "-o", "json"]);
        readiness.kubernetesReady = true;
      } catch (second) {
        readiness.errors.push(second instanceof Error ? second.message : String(second));
      }
    }
    for (const [workspaceId, workspace] of workspaces) {
      try { await kubectlJson(namespaced("get", "pvc", workspace.persistentVolumeClaim, "-o", "json")); }
      catch (error) { readiness.errors.push(`workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    try {
      await kubectlText([...baseArgs(), "get", "crd", "agents.kagent.dev", "-o", "name"]);
      readiness.kagentReady = true;
    } catch {
      readiness.kagentReady = false;
    }
    readiness.ok = readiness.kubernetesReady && Boolean(image) && workspaces.size > 0 && readiness.errors.length === 0;
    return readiness;
  }

  return { start, get, getResult, cancel, ready, workspaceIds: () => [...workspaces.keys()] };
}
