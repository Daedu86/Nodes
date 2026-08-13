import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createKubernetesEvolutionBackend } from "./kubernetes-evolution-backend.mjs";

const fakeKubectlSource = `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const statePath = process.env.FAKE_KUBECTL_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const readStdin = () => fs.readFileSync(0, 'utf8');
const idx = (name) => args.indexOf(name);
const commandIndex = args.findIndex((value) => ['create','get','logs','delete'].includes(value));
const command = args[commandIndex];
const tail = args.slice(commandIndex + 1);
if (command === 'create') {
  const manifest = JSON.parse(readStdin());
  if (manifest.kind === 'ConfigMap') state.configMap = manifest;
  if (manifest.kind === 'Job') {
    manifest.metadata.creationTimestamp = '2026-08-13T10:00:00Z';
    manifest.status = { active: 1 };
    state.job = manifest;
  }
  save();
  process.stdout.write(JSON.stringify(manifest));
  process.exit(0);
}
if (command === 'get' && tail[0] === 'namespace') {
  process.stdout.write(JSON.stringify({ apiVersion:'v1', kind:'Namespace', metadata:{ name:tail[1] } }));
  process.exit(0);
}
if (command === 'get' && tail[0] === 'pvc') {
  process.stdout.write(JSON.stringify({ apiVersion:'v1', kind:'PersistentVolumeClaim', metadata:{ name:tail[1] }, status:{ phase:'Bound' } }));
  process.exit(0);
}
if (command === 'get' && tail[0] === 'crd') {
  process.stdout.write('customresourcedefinition.apiextensions.k8s.io/agents.kagent.dev\\n');
  process.exit(0);
}
if (command === 'get' && tail[0] === 'job') {
  if (!state.job) process.exit(1);
  process.stdout.write(JSON.stringify(state.job));
  process.exit(0);
}
if (command === 'logs') {
  process.stdout.write(state.logs || '');
  process.exit(0);
}
if (command === 'delete') {
  process.stdout.write('deleted\\n');
  process.exit(0);
}
process.stderr.write('unsupported fake kubectl args: ' + args.join(' '));
process.exit(2);
`;

const result = (runtime = "kubernetes") => ({
  schemaVersion: 1,
  experimentId: "candidate-1",
  objective: "verify",
  hypothesis: { statement: "x", expectedObservation: "y", falsifiers: [] },
  decision: "promote",
  sandbox: { runtime, image: "tycho:k8s" },
  budget: { maxSteps: 1, stepsUsed: 1, maxWallSeconds: 10, wallSeconds: 1, stopReason: null },
  summary: { stepCount: 1, executedSteps: 1, passedSteps: 1, failedSteps: 0, blockedSteps: 0 },
  steps: [{ id: "verify" }],
  metadata: {},
});

test("Kubernetes backend creates hardened isolated Jobs and returns Tycho evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodes-k8s-backend-"));
  const kubectl = path.join(root, "kubectl-fake.mjs");
  const statePath = path.join(root, "state.json");
  await writeFile(kubectl, fakeKubectlSource, "utf8");
  await chmod(kubectl, 0o755);
  await writeFile(statePath, "{}", "utf8");
  const oldState = process.env.FAKE_KUBECTL_STATE;
  process.env.FAKE_KUBECTL_STATE = statePath;

  try {
    const backend = createKubernetesEvolutionBackend({
      kubectl,
      namespace: "nodes-evolution",
      image: "tycho:k8s",
      runnerId: "runner-test",
      workspaces: new Map([["workspace-1", { persistentVolumeClaim: "workspace-pvc", subPath: null }]]),
    });

    const readiness = await backend.ready();
    assert.equal(readiness.ok, true);
    assert.equal(readiness.kagentReady, true);

    const started = await backend.start({
      ownerId: "owner-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
      sessionId: "session-1",
      candidateKey: "g1:candidate-1",
      experimentId: "candidate-1",
      workspaceFiles: [{
        path: ".nodes/tycho-experiment.json",
        content: JSON.stringify({ schemaVersion: 1, experimentId: "candidate-1" }),
        mimeType: "application/json",
      }],
    });
    assert.equal(started.status, "running");
    assert.equal(started.backend, "kubernetes");

    const state = JSON.parse(await readFile(statePath, "utf8"));
    const podSpec = state.job.spec.template.spec;
    assert.equal(podSpec.automountServiceAccountToken, false);
    assert.equal(podSpec.securityContext.runAsNonRoot, true);
    assert.equal(podSpec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(podSpec.containers[0].securityContext.capabilities.drop, ["ALL"]);
    assert.equal(podSpec.volumes[0].persistentVolumeClaim.readOnly, true);
    assert.equal(podSpec.initContainers[0].volumeMounts[0].readOnly, true);
    assert.equal(podSpec.containers[0].env.find((item) => item.name === "TYCHO_SANDBOX_RUNTIME")?.value, "kubernetes");
    assert.equal(podSpec.containers[0].env.some((item) => item.name.includes("CODEX")), false);

    state.job.status = { succeeded: 1, completionTime: "2026-08-13T10:00:01Z" };
    state.logs = `__NODES_TYCHO_RESULT_V1__${Buffer.from(JSON.stringify(result()), "utf8").toString("base64")}\n`;
    await writeFile(statePath, JSON.stringify(state), "utf8");

    const completed = await backend.getResult("owner-1", started.runId);
    assert.equal(completed.result.decision, "promote");
    assert.equal(completed.result.sandbox.runtime, "kubernetes");
  } finally {
    if (oldState === undefined) delete process.env.FAKE_KUBECTL_STATE;
    else process.env.FAKE_KUBECTL_STATE = oldState;
    await rm(root, { recursive: true, force: true });
  }
});
