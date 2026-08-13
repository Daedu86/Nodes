# M7 — Predictive World Model

M7 adds a bounded empirical world model on top of M1–M6. It estimates likely reward, next policy state, uncertainty and historical wall-time **before** a proposed candidate is sent to Tycho. It does not replace Tycho, simulate arbitrary code, fine-tune Luna, or grant the model new execution authority.

## Architecture

```text
M3 replay + M4 team + M5 skills + M6 curriculum
                         ↓
                empirical world model
                         ↓
Luna/Codex proposal pool (logical candidates)
                         ↓
         predicted reward / state / cost
                         ↓
              bounded preselection
                         ↓
          requested Tycho population only
                         ↓
              local or Kubernetes Tycho
                         ↓
                 real reward/evidence
                         ↓
           replay + prediction calibration
```

The model is currently `empirical-knn-v1`: a deterministic nearest-neighbor/backoff model over previous trajectories. It deliberately avoids opaque model-generated rollouts.

## Prediction context

Historical similarity combines bounded evidence from:

- M3 policy state and strategy action;
- M4 topology and active agent profile;
- M5 skill references;
- M6 curriculum capability/domain;
- hypothesis and rationale tokens;
- observed reward, next state and wall-time.

For each candidate M7 records:

```json
{
  "worldModelPrediction": {
    "modelVersion": "empirical-knn-v1",
    "expectedReward": 0.78,
    "uncertainty": 0.24,
    "confidence": 0.76,
    "support": 11,
    "expectedWallSeconds": 18.2,
    "likelyNextState": {
      "stateKey": "decision=promote|passBand=high|blockedBand=low|speedBand=fast",
      "probability": 0.69
    },
    "utility": 0.80,
    "rank": 1,
    "requestedCount": 3,
    "predictedPoolSize": 6,
    "estimatedTychoJobsAvoided": 3
  }
}
```

The prediction is provenance, not proof. The final trajectory always stores the real Tycho outcome separately.

## Modes

```dotenv
TYCHO_WORLD_MODEL_MODE=off
```

Preserves M1–M6 generation exactly.

```dotenv
TYCHO_WORLD_MODEL_MODE=observe
```

Predicts and annotates the normal candidate population, but does not change which candidates execute. Use this to gather calibration evidence safely.

```dotenv
TYCHO_WORLD_MODEL_MODE=online
```

Expands the **logical** proposal pool, ranks proposals with the world model and returns exactly the original requested population to the durable orchestrator. Only that final population is sent to Tycho.

## Bounded planning

Default configuration:

```dotenv
TYCHO_WORLD_MODEL_EXPANSION_FACTOR=2
TYCHO_WORLD_MODEL_MAX_POOL=12
TYCHO_WORLD_MODEL_EXPLORATION_WEIGHT=0.12
TYCHO_WORLD_MODEL_COST_WEIGHT=0.05
TYCHO_WORLD_MODEL_MIN_SUPPORT=4
TYCHO_WORLD_MODEL_MIN_SIMILARITY=0.18
```

Candidate utility is based on:

```text
expectedReward
+ explorationWeight × uncertainty
- costWeight × normalizedExpectedWallTime
```

This preserves exploration instead of always exploiting the current highest predicted reward.

The hard pool ceiling is 12 proposals. Existing M1 generation count, cancellation and timeout budgets remain authoritative. M2 Kubernetes concurrency and sandbox controls remain unchanged.

## Cost tradeoff

M7 can reduce expensive Tycho/Kubernetes candidate executions by reasoning over more candidate proposals first. That is a tradeoff, not free compute: an expanded proposal pool may use more Luna/Codex inference. `TYCHO_WORLD_MODEL_EXPANSION_FACTOR` should therefore be tuned against the relative cost of proposal generation versus real experiment execution.

## Calibration

Executed predictions are stored in normal replay trajectories. The world model reports:

```text
observations
meanAbsoluteError
bias
```

`npm run train:offline` includes this report. A high error or persistent bias is a signal to switch M7 to `observe` or `off` until enough representative evidence exists.

Cold-start predictions are explicitly marked with `coldStart: true` and high uncertainty. M7 should normally be enabled only when M3 replay already contains useful trajectories.

## Safety boundary

M7 cannot:

- skip Tycho validation for selected candidates;
- create new credentials or network access;
- widen filesystem or Kubernetes permissions;
- start unbounded background episodes;
- mutate the replay evidence to make a prediction appear correct;
- treat a predicted reward as the actual M1/M3 reward.

The world model is advisory/preselective. Tycho evidence remains authoritative.
