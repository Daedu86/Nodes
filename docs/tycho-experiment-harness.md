# Tycho experiment harness in Nodes

This feature branch makes **Tycho experiment + Luna/Codex** the default execution policy for project workloads. `main` remains unchanged while the integration is validated.

## Responsibility split

| Layer | Responsibility |
| --- | --- |
| Nodes | project map, workload node, primary session, artifacts, upstream evidence, promotion history |
| Luna/Codex | actor: forms the hypothesis, writes experiment code/protocol, interprets the structured result |
| Tycho | isolated experiment execution, budgets, falsifier checks, structured promote/reject/blocked evidence |
| Codex Runner | local authentication, exact project-id → workspace mapping, managed run lifecycle and approvals |

Tycho never receives Codex/ChatGPT credentials. Nodes never receives arbitrary local filesystem paths. The existing Codex approval, SSE, cancellation, reconnect, and workspace-mapping boundaries remain unchanged.

## Runner installation

Install the matching `feature/tycho-experiment-harness` branch of `Daedu86/Tycho-Llm-Luna` on the same machine that runs the Nodes Codex Runner:

```bash
python -m pip install -e /path/to/Tycho-Llm-Luna
cd /path/to/Tycho-Llm-Luna
make sandbox-image
tycho-experiment --doctor
```

`tycho-experiment --doctor` must pass with Docker or Finch isolation. The generic experiment harness rejects host execution.

## Workload protocol

When the existing Runner starts a selected workload on this branch, the execution prompt requires Luna/Codex to preserve:

- `.nodes/tycho-experiment.json` — predeclared hypothesis, expected observation, falsifiers, budget, scripts, checks, and promotion gate;
- `.nodes/tycho-result.json` — structured `promote`, `reject`, or `blocked` result;
- experiment scripts and metrics used by the verifier.

The Tycho harness executes only Python scripts inside the configured project workspace. Those scripts run through Tycho's Docker/Finch sandbox with network disabled and bounded resources.

A rejected protocol is evidence and must not be overwritten. A revision receives a new experiment id. The workload prompt allows at most one evidence-driven revision inside one workload; broader search should become another Nodes iteration so the project map preserves causal history.

## Direct execution

`buildProjectExecutionPrompt` still supports `mode: "direct"` for callers that explicitly need the previous direct Luna/Codex policy. The existing Canvas Runner does not pass a mode today, so this feature branch defaults it to Tycho. That keeps the experiment isolated to the branch without changing `main`.

## Competition integrity

For benchmark/Kaggle projects, external scores are downstream evidence. The Tycho policy forbids hidden or recovered test labels, answer lists, leaderboard subset probing, or changing promotion thresholds after observing a candidate result.
