# M4 — Hierarchical multi-agent controller

M4 extends the M1+M2+M3 baseline with a second learned decision layer above hypothesis generation.

- M1 learns through evolutionary selection.
- M2 executes candidates in isolated local or Kubernetes Tycho sandboxes.
- M3 learns which **strategy** to apply to the current state.
- M4 learns which **agent-team topology** should realize that strategy.

M4 does not move model-provider credentials into Kubernetes. Luna/Codex reasoning stays on the trusted runner. Kubernetes remains the isolated experimental execution plane.

## Hierarchy

```text
state
  |
  v
M3 strategy policy pi_strategy(s)
  |
  +-- exploit
  +-- repair
  +-- diversify
  +-- efficiency
  +-- robustness
  |
  v
M4 team policy pi_team(s, strategy)
  |
  +-- single
  +-- parallel-specialists
  +-- proposer-critic
  +-- debate
  |
  v
Luna/Codex hypothesis agents (read-only, hypothesis-only)
  |
  v
candidate population
  |
  v
Tycho execution backend
  +-- local Docker/Finch
  +-- Kubernetes Jobs
  |
  v
evidence -> M1 score + M3 reward
  |
  +--> M3 Q update
  +--> M4 contextual team-value update
```

## Security boundary

Every M4 reasoning agent is still started through the existing `hypothesis-only` Codex runner path:

- read-only sandbox,
- approval policy `never`,
- no shell/files/tools/network side effects,
- no child-agent spawning from inside the model,
- no Codex/OpenAI/model-provider credentials passed to candidate Pods.

The orchestration layer, not the model, decides which agents exist and what evidence is shared between waves.

## Topologies

### `single`

One generalist. This is the compatibility topology and is the only topology used when M4 is disabled.

### `parallel-specialists`

The requested population is split exactly across three independent specialist perspectives:

1. failure analyst,
2. mechanism explorer,
3. falsification specialist.

The specialists are logically parallel but intentionally serialized at the trusted Codex runner boundary. This preserves the M1 single-active-generator cancellation contract. Candidate execution remains concurrent according to the evolution execution backend.

### `proposer-critic`

Wave 1 generates a complete proposal population. Wave 2 receives a bounded summary of those proposals and must return corrected replacement variants. Only the critic wave becomes the candidate population.

### `debate`

Wave 1 contains two opposing agents:

- conservative: preserve known-good behavior and minimize unsupported change,
- radical: escape local optima with materially different mechanisms.

Wave 2 is a synthesizer that receives summaries from both sides and emits the final population.

## Learned team policy

The M4 policy context is:

```text
M3 state key + M3 strategy action
```

For example:

```text
decision=promote|pass=high|blocked=none|speed=slow|strategy=efficiency
```

The policy stores an estimated immediate reward for every topology in that context. Selection is deterministic epsilon-greedy. Online updates use an exponential step:

```text
V <- V + alpha * (reward - V)
```

This is deliberately a contextual bandit rather than a second Bellman chain: M3 already owns temporal strategy credit assignment, while M4 owns the immediate team-composition choice nested inside that strategy.

Updates are idempotent by team decision id, so polling/recovery cannot apply the same winner reward twice.

## Configuration

```dotenv
TYCHO_LEARNING_MODE=online
TYCHO_MULTI_AGENT_MODE=online
TYCHO_MULTI_AGENT_ALPHA=0.25
TYCHO_MULTI_AGENT_EPSILON=0.12
```

Modes:

- `off`: exact M3 single-agent generation path.
- `observe`: team selection/metadata is active but team values are not updated.
- `online`: team selection and winner-reward updates are active.

Both policy files share `TYCHO_LEARNING_STATE_DIR`:

```text
policy.json       # M3 strategy Q policy
team-policy.json  # M4 team topology policy
trajectories/     # replay memory, including multiAgentTeam metadata
```

## Replay and offline learning

M3 trajectory records already persist candidate metadata. M4 stores its topology decision inside that metadata, so no second replay format is required.

`npm run train:offline` trains both policies from the same canonical replay dataset. M3 consumes state/action/next-state transitions; M4 consumes state+strategy/topology immediate rewards.

## Operability

Existing learning endpoints now expose M4 automatically:

```text
GET  /v1/evolution/learning/status
GET  /v1/evolution/learning/replay
POST /v1/evolution/learning/train
```

`learning/status` contains:

```json
{
  "policy": { "policyVersion": "q..." },
  "replay": { "count": 0 },
  "team": { "teamPolicyVersion": "t...", "topologies": [] }
}
```

## M5 boundary

M4 does **not** introduce model-weight training, Kubernetes-hosted provider credentials, arbitrary autonomous agent spawning, or a learned world model.

The architecture at the M4 boundary is:

```text
learn strategy -> learn team -> generate hypotheses -> execute safely -> observe reward
```

Any future M5 work should start from this contract rather than bypassing the trusted-runner and Tycho evidence boundaries.
