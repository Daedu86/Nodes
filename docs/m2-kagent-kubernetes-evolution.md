# M2 — kagent + Kubernetes Evolution Backend

M2 moves Tycho candidate execution from the user-local Docker/Finch worker to Kubernetes without changing the Evolution Loop, Codex/Luna hypothesis generator, evaluator, episode persistence, or Canvas lifecycle API built in M1.

## Architecture

```text
Canvas
  -> durable evolution episode
  -> Codex/Luna hypothesis-only generator
  -> candidate population
  -> TYCHO_EVOLUTION_EXECUTION_BACKEND
       |-- local       -> M1 Tycho Docker/Finch worker
       `-- kubernetes  -> Kubernetes Job per candidate
                              -> Tycho runtime=kubernetes
                              -> result evidence in Job logs
  -> deterministic evaluator
  -> champion
  -> next generation / episode

kagent
  -> read-only cluster observer
  -> Jobs / Pods / events / logs
  -> diagnostics only; never execution authority
```

kagent is deliberately not placed in the deterministic candidate submission path. Kubernetes schedules Jobs; kagent provides agentic cluster operations and diagnostics. `deploy/kagent/nodes-evolution-observer.yaml` exposes only read-only Kubernetes tools.

## Tycho Kubernetes runtime

The companion Tycho branch is `feature/tycho-kubernetes-sandbox` in `Daedu86/Tycho-Llm-Luna`.

Inside Kubernetes, Tycho sets `TYCHO_SANDBOX_RUNTIME=kubernetes`. The Pod itself is the sandbox boundary, so experiments do **not** run Docker-in-Docker and never receive a Docker/Finch socket. The Job asserts:

- non-root UID/GID 65532
- `allowPrivilegeEscalation: false`
- read-only root filesystem
- all Linux capabilities dropped
- `seccompProfile: RuntimeDefault`
- service-account token automount disabled
- deny-all ingress and egress NetworkPolicy
- source workspace PVC mounted read-only
- per-candidate `emptyDir` working copy
- no Codex/ChatGPT/model-provider credentials injected into the candidate

Tycho's Kubernetes adapter also strips runner credentials from each experiment subprocess environment.

## Cluster resources

Apply the base namespace policy and create a source PVC:

```bash
kubectl apply -f deploy/kubernetes/nodes-evolution-base.yaml
kubectl apply -f deploy/kubernetes/workspace-pvc.example.yaml
```

The PVC example relies on the cluster's default StorageClass. Set `storageClassName` when required by the target cluster.

Install kagent according to the upstream installation guide, then apply the read-only observer:

```bash
kubectl apply -f deploy/kagent/nodes-evolution-observer.yaml
```

The manifest targets the current `kagent.dev/v1alpha2` Agent API and the built-in `kagent-tool-server` read-only tools (`k8s_get_resources`, `k8s_describe_resource`, `k8s_get_pod_logs`, `k8s_get_events`).

## Build the Tycho Kubernetes image

From the companion Tycho branch:

```bash
docker build -f deploy/kubernetes/Containerfile -t tycho-kubernetes:0.1 .
```

For Kind, load the image into the cluster or push it to the registry used by the Kind nodes. For a remote cluster, push the image to a registry available to the cluster and set `TYCHO_KUBERNETES_IMAGE` accordingly.

## Runner configuration

The local backend remains the default. Enable Kubernetes explicitly:

```dotenv
TYCHO_EVOLUTION_EXECUTION_BACKEND=kubernetes
TYCHO_KUBERNETES_NAMESPACE=nodes-evolution
TYCHO_KUBERNETES_IMAGE=tycho-kubernetes:0.1
TYCHO_KUBERNETES_IMAGE_PULL_POLICY=IfNotPresent
TYCHO_KUBERNETES_CONTEXT=kind-nodes
TYCHO_KUBERNETES_RUNNER_ID=nodes-local
TYCHO_KUBERNETES_WORKSPACES_JSON={"120f5105-3f10-40f1-8a8d-44f6e9901788":{"persistentVolumeClaim":"nodes-workspace"}}
```

`CODEX_WORKSPACES_JSON` remains necessary because Codex/Luna hypothesis generation runs on the trusted local runner. The Kubernetes mapping is a separate allowlist and accepts only logical workspace IDs; browser requests never provide a host path or PVC name.

## Sync the authoritative workspace

Before an experiment, synchronize the allowlisted local workspace into its configured PVC:

```bash
cd services/codex-runner
node --env-file=.env kubernetes-workspace-sync.mjs 120f5105-3f10-40f1-8a8d-44f6e9901788
```

or:

```bash
NODE_OPTIONS='--env-file=.env' npm run sync:kubernetes -- 120f5105-3f10-40f1-8a8d-44f6e9901788
```

The sync helper uses a temporary non-root Pod with no service-account token. Candidate Jobs subsequently mount the PVC read-only and copy the source into their own isolated `emptyDir`.

## Readiness

Start the runner normally. When Kubernetes execution is selected, port 8788 reports backend-specific readiness:

```bash
curl -sS -H "Authorization: Bearer $CODEX_RUNNER_TOKEN" \
  http://127.0.0.1:8788/readyz | jq .
```

Expected fields include:

```json
{
  "executionBackend": "kubernetes",
  "kubernetesReady": true,
  "kagentReady": true,
  "durableEvolution": true,
  "workspaceIds": ["..."]
}
```

`kagentReady` indicates that the kagent Agent CRD is installed. Candidate execution remains deterministic and does not depend on an LLM decision from kagent.

## Live M2 acceptance

After syncing the workspace and providing a schema-v1 `.nodes/tycho-experiment.json`:

```bash
cd services/codex-runner
NODES_EVOLUTION_SMOKE_WORKSPACE_ID='120f5105-3f10-40f1-8a8d-44f6e9901788' \
NODES_EVOLUTION_SMOKE_PROTOCOL_FILE='../../.nodes/tycho-experiment.json' \
node --env-file=.env kubernetes-evolution-smoke.mjs
```

The smoke fails closed unless:

1. Kubernetes readiness passes.
2. kagent CRDs are present.
3. The requested workspace ID is allowlisted.
4. Codex/Luna generates the requested population.
5. Tycho candidate Jobs finish and return `sandbox.runtime=kubernetes` evidence.
6. Every generation has a deterministic winner.
7. The final champion has a finite score.

## Recovery and cancellation

M1's durable episode semantics remain authoritative. A runner restart resumes from the last committed generation. Active candidate Jobs from an interrupted generation are not treated as committed evidence; the generation can be replayed. Kubernetes Jobs use a TTL after completion, and cancellation deletes the selected candidate Job and its input ConfigMap.

## Boundary before M3

M2 changes **where actions execute**, not **how actions are learned**. The persisted trajectory is still:

```text
state -> Codex hypothesis -> Kubernetes/Tycho execution -> evaluation -> champion -> next state
```

M3 may introduce an explicit learned controller/policy over these trajectories. No policy optimization, RL algorithm, replay buffer, learned value function, or model-weight update belongs in M2.
