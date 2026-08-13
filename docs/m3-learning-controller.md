# M3 — Learned Policy and Replay Controller

M3 adds a learned decision layer on top of the M1+M2 integration branch. It does not replace Luna/Codex, Tycho, or Kubernetes. Instead it learns which **generation strategy** should condition Luna for the current experiment state.

## Architecture

```text
Canvas / durable episode
        |
        v
Policy state encoder
        |
        v
Persistent Q-policy
  | exploit / explore
  v
Strategy action
  |-- exploit
  |-- repair
  |-- diversify
  |-- efficiency
  `-- robustness
        |
        v
Luna/Codex hypothesis-only generator
        |
        v
candidate population
        |
        v
Tycho execution backend
  |-- local Docker/Finch
  `-- Kubernetes Job/Pod
        |
        v
Tycho evidence + M1 score
        |
        +--> decomposed M3 reward
        |       correctness
        |       pass ratio
        |       reliability
        |       efficiency
        |
        +--> canonical trajectory
        |       state
        |       action
        |       candidate
        |       reward
        |       evidence
        |       next state
        |       policy version
        |
        v
Replay store -> Q update -> next generation
```

M1's deterministic `score` remains the champion-selection mechanism. M3 introduces a separate normalized reward in `[0, 1]` for learning. This preserves compatibility and makes policy learning independently auditable.

## State representation

The first policy is deliberately small and inspectable. It discretizes the previous winner evaluation into:

- Tycho decision (`promote`, `reject`, `blocked`, none/unknown)
- pass band (`low`, `mid`, `high`)
- blocked band (`none`, `some`, `high`)
- speed band (`fast`, `mid`, `slow`)

The resulting state key is stable and suitable for a tabular policy. M3 does not claim that this is the final state representation.

## Actions

The controller chooses one generation-level action:

- `exploit`: conservative refinement around the current champion
- `repair`: directly target failed or blocked evidence
- `diversify`: explore structurally different mechanisms
- `efficiency`: reduce wall time/experiment complexity while preserving correctness
- `robustness`: strengthen falsifiers and edge-case coverage

The action is passed to Luna as untrusted learning context inside the parent evaluation evidence. Luna remains `hypothesis-only`: it receives no shell, file, network, or cluster authority.

## Policy

The first learned controller is a persistent tabular Q-policy with deterministic epsilon-greedy exploration.

Defaults:

```text
alpha   = 0.25
gamma   = 0.85
epsilon = 0.15
```

Exploration uses a stable hash of the session/workspace/generation/state, so identical policy state and seed input produce the same exploration choice. This keeps runs reproducible while still supporting exploration.

Q updates are idempotent by transition id. A runner restart or repeated Canvas reconciliation cannot apply the same online transition twice.

## Reward

M3 reward is separate from the M1 score:

```text
reward =
  0.45 * correctness +
  0.30 * passRatio +
  0.15 * reliability +
  0.10 * efficiency
```

`correctness` is derived from the Tycho promote/reject/blocked decision. `reliability` penalizes failed/blocked steps. `efficiency` decays with wall time.

The reward model is deterministic and evidence-derived. Candidate metadata cannot directly set reward.

## Replay store

Trajectories are stored under:

```text
~/.nodes-ai-canvas/learning/trajectories/
```

or `TYCHO_LEARNING_STATE_DIR`.

Each candidate creates an immutable logical trajectory containing:

```text
state
stateKey
actionId
actionMode
policyVersion
candidate identity
candidate spec hash
reward + reward components
M1 score
Tycho metrics/evidence
nextState
winner flag
```

The full candidate workspace is not copied into the replay store. A stable spec hash plus existing run/session evidence provides provenance without duplicating potentially large workspace files.

## Modes

```dotenv
TYCHO_LEARNING_MODE=off
```

Preserves M1/M2 generation behavior.

```dotenv
TYCHO_LEARNING_MODE=observe
```

Conditions generation and records trajectories but does not update Q-values.

```dotenv
TYCHO_LEARNING_MODE=online
```

Enables policy selection, replay recording, and online Q-learning.

## Runner API

Both local and Kubernetes evolution runners expose:

```text
GET  /v1/evolution/learning/status
GET  /v1/evolution/learning/replay?workspaceId=...
POST /v1/evolution/learning/train
```

Offline training accepts:

```json
{
  "workspaceId": "optional-logical-workspace-id",
  "reset": false
}
```

The runner token remains required when configured.

## Offline policy improvement

The runner also provides:

```bash
cd services/codex-runner
NODE_OPTIONS='--env-file=.env' npm run train:offline
```

Optional reset:

```bash
NODE_OPTIONS='--env-file=.env' npm run train:offline -- --reset
```

Optional workspace filter:

```bash
NODE_OPTIONS='--env-file=.env' npm run train:offline -- --workspace=<workspace-id>
```

Offline replay uses the same Q-update rule as online learning and records applied transition ids so repeated training is idempotent unless the policy is explicitly reset.

## Safety boundary

M3 does **not** train or modify Luna/Codex model weights. It learns an external policy over generation strategies.

Candidate Pods still receive no Codex/OpenAI/model-provider credentials. Kubernetes remains execution authority and kagent remains a read-only cluster observer.

## Boundary before M4

M3 ends when the system can:

1. encode evaluation state,
2. select a learned strategy,
3. condition Luna with that strategy,
4. execute candidates through M1/M2,
5. derive deterministic reward,
6. persist all candidate trajectories,
7. improve the policy online or offline,
8. recover without duplicate learning updates.

M4 is intentionally out of scope. In particular, M3 does not introduce model-weight fine-tuning, neural value/policy networks, distributed learner services, or autonomous mutation of the reward function.
