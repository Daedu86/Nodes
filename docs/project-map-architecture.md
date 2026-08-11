# Project Map Architecture

## Product invariant

The **Project Map is the project index and orchestration graph**.

There is no required filename and no required `.md` extension. The persisted representation may be JSON, database rows, or another structured format. The product semantics are what matter:

- A **Project** is the complete objective/workspace.
- The **Map** is the project-level directed graph and the default project index.
- A **Map node** is a workload / thinking unit.
- A map node may own **one or many sessions**.
- A **Session** contains the detailed branching conversation, experiments, artifacts, and local reasoning for that workload.
- A map node exposes one **selected output** from one of its sessions.
- A **Map edge** means the target workload depends on the selected output of the source workload.
- Internal session messages never expand automatically into the project map.

## Two levels of branching

```text
PROJECT MAP
│
├─ Dataset inspection
├─ Shared preprocessing
├─ Logistic regression
├─ Random forest
└─ Final comparison

            open Random forest
                    │
                    ▼
WORKLOAD NODE
│
├─ Session: baseline
├─ Session: feature experiment
├─ Session: tuning run A
└─ Session: tuning run B
        │
        ▼
selected output → project map edge
```

The project map answers **what work exists and how it depends on other work**. A session answers **how that work was explored**.

## Persistence contract

`projects.map_json` is the canonical persisted project map.

The map document contains:

- `nodes[]`
  - stable node ID
  - title and workload description
  - status
  - `sessionIds[]`
  - optional primary session
  - optional selected output (`sessionId`, `messageId`, artifact IDs, summary)
- `edges[]`
  - source workload node
  - target workload node
  - optional dependency label

A session may belong to only one map workload. Map dependency edges must remain acyclic.

`project_sessions` remains a materialized membership/index table for compatibility and efficient hydration. When a non-empty map is saved, its node session references are authoritative and the repository synchronizes `project_sessions` from the map.

## Output flow

A source workload can select an output from any session it owns. Downstream nodes consume that selected result rather than inheriting an entire transcript automatically.

The domain helper `buildProjectMapInputSummary()` produces a deterministic text representation of direct upstream outputs. Runtime integrations should use structured output fields when possible and only fall back to the text summary when an LLM prompt requires it.

## Legacy projects

Projects created before the map model remain readable. When `map_json` is empty, the Canvas builds a temporary legacy map with one workload node per attached session. Saving an explicit map migrates that project into the new model.

Legacy session add/remove controls must route their changes through an existing map rather than creating a second source of project structure.

## UI rule

The project Canvas renders **map/workload nodes only**. Session message trees stay inside their sessions. This prevents large projects from collapsing into unreadable graphs and keeps the project view focused on orchestration.

Initial node layout is automatic and uniformly spaced. Manual node positioning may be added later as a user-controlled override without changing the map semantics.
