# M5 — Autonomous Procedural Skill Learning

M5 turns successful M1–M4 trajectories into versioned, evidence-backed procedural memory. It does **not** fine-tune Luna and it does not grant a skill execution authority. Skills only condition hypothesis generation; Tycho remains the experiment authority and the M2 sandbox boundary remains unchanged.

## Architecture

```text
M3 strategy policy
        ↓
M4 team policy
        ↓
M5 skill retrieval
        ↓
Luna/Codex hypothesis-only
        ↓
Tycho local or Kubernetes execution
        ↓
reward + evidence
        ↓
trajectory provenance
        ↓
skill miner → validator → registry
```

## Skill lifecycle

```text
candidate → validating → promoted
                         ↘ deprecated
candidate/version N → superseded by version N+1
```

A skill contains:

- stable `skillId` and positive integer `version`;
- domain and mechanism identity;
- triggers and preconditions;
- a procedure expressed as falsifiable guidance;
- constraints, expected outputs and known failure modes;
- source trajectory IDs;
- validation evidence and reward lift;
- lifecycle links for supersession.

Registry files live under:

```text
$TYCHO_LEARNING_STATE_DIR/skills/
```

or, by default:

```text
~/.nodes-ai-canvas/learning/skills/
```

## Mining

`skill-miner.mjs` reads the replay store and groups high-reward winning trajectories by:

```text
domain + M3 strategy + M4 topology
```

A group must satisfy `TYCHO_SKILL_MIN_SUPPORT` and `TYCHO_SKILL_MIN_REWARD`. The miner derives triggers from observed policy-state bands and compiles a bounded procedure from the strongest hypotheses/rationales. Newly mined skills enter `validating` state.

Mining is deterministic and does not allow replay content to execute tools or mutate workspaces.

## Retrieval

`skill-retriever.mjs` ranks skills using current state and strategy. Promoted skills are normal retrieval candidates. In `online` mode a validating skill may be selected under deterministic exploration so the system can collect actual post-retrieval outcomes.

Candidate metadata records:

```json
{
  "skillContext": {
    "mode": "online",
    "skillRefs": ["repair-strategy-with-proposer-critic-team-...@1"],
    "skills": [
      {
        "ref": "...@1",
        "title": "Repair / proposer-critic learned procedure",
        "status": "promoted",
        "experimental": false
      }
    ]
  }
}
```

This provenance is persisted into M3 trajectories.

## Validation and promotion

`skill-validator.mjs` compares trajectories that used a given skill against a matched baseline with the same M3 strategy and M4 topology, excluding the trajectories originally used to mine the skill.

A validating skill is promoted only when both sides have enough observations and:

```text
mean_reward(with_skill) - mean_reward(matched_baseline)
    >= TYCHO_SKILL_MIN_REWARD_LIFT
```

A promoted skill can be deprecated when sufficient new evidence shows a negative lift beyond the same threshold.

This is a conservative online/offline evidence gate; it is not a claim of randomized causal inference. Experimental skill selection is therefore recorded explicitly and remains bounded by `TYCHO_SKILL_EXPLORATION`.

## Configuration

M5 depends on M3 replay trajectories, so enable M3 in `observe` or `online` mode when enabling skills.

```dotenv
TYCHO_LEARNING_MODE=online
TYCHO_MULTI_AGENT_MODE=online

TYCHO_SKILL_MODE=online
TYCHO_SKILL_TOP_K=2
TYCHO_SKILL_EXPLORATION=0.15
TYCHO_SKILL_MIN_SUPPORT=3
TYCHO_SKILL_MIN_REWARD=0.65
TYCHO_SKILL_MIN_VALIDATION_OBSERVATIONS=3
TYCHO_SKILL_MIN_BASELINE_OBSERVATIONS=3
TYCHO_SKILL_MIN_REWARD_LIFT=0.03
```

Modes:

- `off`: exact M1–M4 path; no skill retrieval/mining.
- `observe`: promoted skills may be retrieved; no validating-skill exploration.
- `online`: promoted skills are retrieved and validating skills may be explored to gather evidence.

## Offline learning

The existing offline command now trains M3 and M4 and also mines/validates M5:

```bash
cd services/codex-runner
npm run train:offline
```

Optional workspace scope:

```bash
npm run train:offline -- --workspace=<workspace-id>
```

## Safety invariants

M5 does not change M2 isolation:

- no Codex/OpenAI token enters candidate Pods;
- no Docker socket is exposed to a Kubernetes candidate;
- learned skills cannot execute tools, shell commands or files;
- skills cannot override `.nodes/tycho-experiment.json`;
- Tycho evidence determines reward;
- a skill cannot self-assign its validation reward or promotion status;
- every retrieved skill is versioned and stamped into candidate provenance.

## Acceptance criteria

M5 is accepted when:

1. skill schema and registry persistence tests pass;
2. replay mining produces stable skill candidates from sufficient evidence;
3. retrieval prefers relevant promoted skills and bounds experimental validating skills;
4. matched-baseline validation promotes only after positive reward lift;
5. an evolution episode records exact skill provenance in candidate metadata/replay;
6. all M1–M4 regressions and production build remain green;
7. the M2 Kind/Kubernetes Tycho integration still executes successfully.
