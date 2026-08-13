import { createKubernetesEvolutionBackend } from "./kubernetes-evolution-backend.mjs";

const workspaceId = process.env.NODES_KUBERNETES_INTEGRATION_WORKSPACE_ID?.trim() || "m2-integration";
const ownerId = "m2-integration-owner";
const experimentId = `m2-k8s-${Date.now()}`;
const timeoutMs = Number(process.env.NODES_KUBERNETES_INTEGRATION_TIMEOUT_MS || 180_000);
const pollMs = Number(process.env.NODES_KUBERNETES_INTEGRATION_POLL_MS || 500);
const expectedSourceMarker = process.env.NODES_KUBERNETES_INTEGRATION_SOURCE_MARKER?.trim() || "";

const protocol = {
  schemaVersion: 1,
  experimentId,
  objective: "Verify one real Tycho candidate executes inside a hardened Kubernetes Job.",
  hypothesis: {
    statement: "The Kubernetes candidate sandbox can execute a deterministic verification step.",
    expectedObservation: "The step exits zero and writes the expected metric.",
    falsifiers: ["The Job cannot execute Tycho.", "The metric is missing or incorrect."],
  },
  budget: { maxSteps: 1, maxWallSeconds: 60, maxOutputChars: 12000 },
  steps: [{
    id: "verify-kubernetes",
    script: ".nodes/m2-kubernetes-verify.py",
    args: ["--output", ".nodes/m2-kubernetes-metrics.json", "--source-marker", expectedSourceMarker],
    timeoutSeconds: 30,
    checks: [
      { kind: "exit_code", equals: 0 },
      { kind: "json_metric", file: ".nodes/m2-kubernetes-metrics.json", path: "metrics.kubernetes", op: "==", value: 1 },
    ],
  }],
  promotion: { requireAllSteps: true, minPassedSteps: 1 },
  metadata: { source: "nodes-m2-kind-integration" },
};

const verifyScript = `import argparse, json, os, pathlib\nparser=argparse.ArgumentParser()\nparser.add_argument('--output', required=True)\nparser.add_argument('--source-marker', default='')\nargs=parser.parse_args()\nassert os.environ.get('CODEX_RUNNER_TOKEN') is None\nassert os.environ.get('OPENAI_API_KEY') is None\nif args.source_marker:\n    assert pathlib.Path('m2-source-marker.txt').read_text(encoding='utf-8').strip() == args.source_marker\npath=pathlib.Path(args.output)\npath.parent.mkdir(parents=True, exist_ok=True)\npath.write_text(json.dumps({'metrics': {'kubernetes': 1}}), encoding='utf-8')\nprint('kubernetes candidate verified')\n`;

const backend = createKubernetesEvolutionBackend();
const readiness = await backend.ready();
if (!readiness.ok) throw new Error(`Kubernetes backend is not ready: ${JSON.stringify(readiness)}`);
if (!readiness.workspaceIds.includes(workspaceId)) throw new Error(`Workspace ${workspaceId} is not allowlisted.`);

const started = await backend.start({
  ownerId,
  workspaceId,
  projectId: "m2-integration",
  sessionId: "m2-integration",
  candidateKey: `g1:${experimentId}`,
  experimentId,
  workspaceFiles: [
    { path: ".nodes/tycho-experiment.json", content: `${JSON.stringify(protocol, null, 2)}\n`, mimeType: "application/json" },
    { path: ".nodes/m2-kubernetes-verify.py", content: verifyScript, mimeType: "text/x-python" },
  ],
});

console.log(`[m2-kind] started ${started.runId} job=${started.jobName}`);
const deadline = Date.now() + timeoutMs;
let snapshot = started;
try {
  while (snapshot.status === "running") {
    if (Date.now() >= deadline) throw new Error(`Kubernetes candidate integration timed out after ${timeoutMs}ms.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    snapshot = await backend.get(ownerId, started.runId);
  }
  if (snapshot.status !== "completed") throw new Error(`Kubernetes candidate ended ${snapshot.status}: ${snapshot.error || "no reason"}`);
  const completed = await backend.getResult(ownerId, started.runId);
  if (completed.result.decision !== "promote") throw new Error(`Expected promote, got ${completed.result.decision}.`);
  if (completed.result.sandbox?.runtime !== "kubernetes") throw new Error(`Expected Kubernetes sandbox evidence, got ${completed.result.sandbox?.runtime || "missing"}.`);
  if (completed.result.summary?.passedSteps !== 1 || completed.result.summary?.failedSteps !== 0 || completed.result.summary?.blockedSteps !== 0) {
    throw new Error(`Unexpected Tycho summary: ${JSON.stringify(completed.result.summary)}`);
  }
  console.log(`[m2-kind] PASS run=${started.runId} decision=${completed.result.decision} runtime=${completed.result.sandbox.runtime}`);
} catch (error) {
  await backend.cancel(ownerId, started.runId).catch(() => null);
  throw error;
}
