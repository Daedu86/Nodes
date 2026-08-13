# M6 — Autonomous Curriculum Learning

M6 turns M1–M5 evidence into a bounded self-improvement curriculum. It does **not** fine-tune Luna, create unbounded background work, bypass Tycho, or grant generated tasks new execution authority.

## Architecture

```text
M1-M5 replay + skill registry
          ↓
Capability Model
          ↓
Curriculum Controller
          ↓
CurriculumTaskSpec
          ↓
M3 strategy / M4 team / M5 skills
          ↓
Luna/Codex hypothesis-only
          ↓
Tycho local or Kubernetes execution
          ↓
reward + evidence
          ↓
updated capability frontier
```

The implementation is deliberately conservative: M6 adds a task objective to candidate generation inside the existing durable episode. Existing generation count, wall-time, cancellation, concurrency and Kubernetes isolation remain authoritative.

## Capability model

`capability-model.mjs` derives profiles from the replay store using:

- domain;
- capability/state identity;
- observation count;
- success rate;
- mean/recent reward;
- improvement rate;
- uncertainty;
- promoted-skill coverage;
- a bounded `learningValue` score.

The controller prefers an uncertain or stagnant frontier instead of repeatedly practicing already-solved work or jumping directly to persistently impossible work.

## CurriculumTaskSpec

Every generated task is schema-versioned and contains:

```json
{
  "schemaVersion": 1,
  "taskId": "curr-...",
  "domain": "general-evolution",
  "capabilityKey": "...",
  "difficulty": 0.55,
  "objective": "...",
  "constraints": ["..."],
  "successCriteria": ["..."],
  "reason": {
    "observations": 4,
    "meanReward": 0.58,
    "improvementRate": 0.01,
    "uncertainty": 0.44,
    "skillGap": 1,
    "learningValue": 0.71
  },
  "budget": {
    "generation": 2,
    "maxTasksPerRun": 4,
    "maxDifficulty": 0.85
  }
}
```

`curriculum-validator.mjs` rejects tasks outside the domain allowlist, above the difficulty ceiling, beyond the per-run task budget, or without explicit constraints and measurable success criteria.

## Adaptation

M6 does not maintain a separate opaque model. The curriculum adapts from the same evidence-backed replay memory used by M3–M5. Candidate metadata records the exact task:

```text
candidateMetadata.curriculumContext.task
```

After Tycho evaluates the candidate, that provenance enters the trajectory store. Future capability profiles therefore reflect what happened under previous curriculum tasks.

Difficulty adapts around `TYCHO_CURRICULUM_TARGET_REWARD`: high-performing capabilities receive harder tasks, weak capabilities receive intermediate tasks, and stagnant capabilities receive targeted frontier tasks.

## Resource safety

M6 cannot create infinite autonomous loops. A task is generated only inside an existing durable episode and remains bounded by all existing M1/M2 limits plus:

```dotenv
TYCHO_CURRICULUM_MAX_TASKS_PER_RUN=4
TYCHO_CURRICULUM_MAX_DIFFICULTY=0.85
TYCHO_CURRICULUM_TARGET_REWARD=0.65
TYCHO_CURRICULUM_ALLOWED_DOMAINS=tabular-ml,debugging
```

Generated tasks cannot request external network access, credentials, privileged execution, wider filesystem access, Docker sockets, service-account tokens or higher Kubernetes permissions.

## Modes

```dotenv
TYCHO_CURRICULUM_MODE=off
```

Preserves M1–M5 without curriculum tasks.

```dotenv
TYCHO_CURRICULUM_MODE=observe
```

Produces bounded curriculum tasks for inspection and evidence collection.

```dotenv
TYCHO_CURRICULUM_MODE=online
```

Uses the live capability frontier during normal evolution. This is the intended adaptive self-improvement mode.

## Runner API

Both local and Kubernetes evolution runners expose:

```text
GET  /v1/evolution/curriculum/status?workspaceId=...
POST /v1/evolution/curriculum/plan
```

The plan endpoint is read-only with respect to execution: it returns the next bounded task but does not start an episode or a Kubernetes Job.

`GET /v1/evolution/learning/status` also includes the active curriculum configuration, and `npm run train:offline` reports the current capability frontier together with M3/M4/M5 learning state.
