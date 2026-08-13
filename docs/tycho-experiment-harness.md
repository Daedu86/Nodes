# Tycho experiment harness in Nodes

This feature branch makes **Tycho experiment + Luna/Codex** the default execution policy for project workloads. `main` remains unchanged while the integration is validated.

## Responsibility split

| Layer | Responsibility |
| --- | --- |
| Nodes | project map, workload node, primary session, artifacts, upstream evidence, promotion history |
| Luna/Codex | actor: forms the hypothesis, writes experiment code/protocol, interprets the structured result |
| Tycho | isolated experiment execution, budgets, falsifier checks, structured promote/reject/blocked evidence |
| Codex Runner | local authentication, exact project-id → workspace mapping, Tycho isolation readiness, managed run lifecycle and approvals |

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

The Nodes runner executes only that fixed doctor command during authenticated `/readyz` checks. It never accepts a Tycho executable, command, runtime, image, or filesystem path from the browser. Configure a non-default CLI path only on the runner machine with:

```bash
TYCHO_EXPERIMENT_BIN=tycho-experiment
TYCHO_DOCTOR_TIMEOUT_MS=20000
```

The Canvas Runner remains disabled until readiness reports `tychoReady: true` with runtime `docker` or `finch`. A missing CLI, timeout, failed doctor, invalid output, or `host` runtime fails closed before Luna starts the workload.

## Workload protocol

When the existing Runner starts a selected workload on this branch, the execution prompt requires Luna/Codex to preserve:

- `.nodes/tycho-experiment.json` — predeclared hypothesis, expected observation, falsifiers, budget, scripts, checks, and promotion gate;
- `.nodes/tycho-result.json` — structured `promote`, `reject`, or `blocked` result;
- experiment scripts and metrics used by the verifier.

The Tycho harness executes only Python scripts inside the configured project workspace. Those scripts run through Tycho's Docker/Finch sandbox with network disabled and bounded resources.

A rejected protocol is evidence and must not be overwritten. A revision receives a new experiment id. The workload prompt allows at most one evidence-driven revision inside one workload; broader search should become another Nodes iteration so the project map preserves causal history.

## Evolution loop (M1)

`lib/tycho-evolution-loop.ts` adds the backend-neutral orchestration primitive for controlled multi-candidate search:

```text
parent candidate
  -> generate N variants
  -> execute variants in parallel
  -> evaluate successful executions
  -> select one deterministic winner
  -> use that winner as the next generation's parent
```

Candidate generation and experiment execution are intentionally separate responsibilities. The current integration can use Luna/Codex (or another strategy) to formulate candidate hypotheses while a Tycho-backed `EvolutionExecutionBackend` performs isolated experiment work. A future optimizer can replace the generator, and a future kagent/Kubernetes backend can replace execution, without changing the evolution or winner-selection semantics.

Each generation records candidate provenance (`generation`, `key`, `parentKey`), execution output, evaluation evidence, and isolated execution/evaluation failures. Candidates execute concurrently; one failed candidate does not cancel healthy siblings. A generation fails closed when no candidate can be successfully evaluated. Equal scores are resolved deterministically by generator order so repeated evaluation does not depend on completion timing.

M1 is deliberately an orchestration contract rather than browser or credential logic. Browser clients still do not choose executables, filesystem paths, sandbox credentials, or cluster credentials. Concrete Tycho-runner and kagent/Kubernetes execution adapters remain behind the `EvolutionExecutionBackend` boundary.

## Direct execution

`buildProjectExecutionPrompt` still supports `mode: "direct"` for callers that explicitly need the previous direct Luna/Codex policy. The existing Canvas Runner does not pass a mode today, so this feature branch defaults it to Tycho. Because the Canvas Runner is Tycho-default on this branch, its Run button requires Tycho isolated readiness.

## Competition integrity

For benchmark/Kaggle projects, external scores are downstream evidence. The Tycho policy forbids hidden or recovered test labels, answer lists, leaderboard subset probing, or changing promotion thresholds after observing a candidate result.
