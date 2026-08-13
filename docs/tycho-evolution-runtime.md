# Tycho evolution runtime

This branch connects the M1 evolution loop to the real local Tycho experiment harness without routing every candidate through Codex again.

## Responsibility split

- **Nodes** owns generations, candidate provenance, evaluation, winner selection, and history.
- **Luna/Codex or another generator** proposes candidate hypotheses/specs.
- **Tycho evolution worker** executes each candidate protocol in an isolated Docker/Finch sandbox.
- **Codex Runner machine** owns workspace mappings, runner authentication, temporary candidate workspaces, and the Tycho CLI installation.

The candidate path is:

```text
EvolutionVariantGenerator
        -> candidate spec
        -> EvolutionExecutionBackend
        -> Tycho evolution runner
        -> ephemeral candidate workspace
        -> tycho-experiment
        -> Docker/Finch sandbox
        -> .nodes/tycho-result.json
        -> EvolutionEvaluator
        -> winner
```

## Local runner topology

`server-launcher.mjs` starts two listeners on the trusted runner machine:

- `CODEX_RUNNER_PORT` (default `8787`) — existing Codex managed runs.
- `TYCHO_EVOLUTION_RUNNER_PORT` (default `8788`) — direct Tycho candidate execution.

Both use `CODEX_RUNNER_TOKEN` and `x-nodes-owner-id`. Evolution requests require an exact `workspaceId` present in `CODEX_WORKSPACES_JSON`; candidate payloads never carry host filesystem paths.

The Nodes server connects to the second listener with:

```text
TYCHO_EVOLUTION_RUNNER_URL=<private/tunneled URL for port 8788>
```

## Candidate isolation

Every evolution candidate receives a runner-managed temporary copy of the configured project workspace. The copy:

- skips `.git`, `node_modules`, `.next`, virtual environments, coverage/build output, and symlinks;
- is bounded by runner file-count and byte budgets;
- excludes files supplied as authoritative `.nodes/*` candidate artifacts before materializing them;
- always requires `.nodes/tycho-experiment.json`;
- is removed after the Tycho process reaches a terminal state.

This prevents parallel candidates from racing on the champion workspace or overwriting each other's protocol/result files.

## Result boundary

The worker reads only the fixed `.nodes/tycho-result.json` path. It validates:

- `schemaVersion === 1`;
- exact `experimentId` match;
- `decision` is `promote`, `reject`, or `blocked`;
- coherent step counters;
- Docker/Finch sandbox provenance;
- bounded result size.

Tycho CLI exit codes `0`, `3`, and `4` are treated as valid experiment outcomes (`promote`, `reject`, `blocked`). Other exit codes are runtime failures.

## Promotion evaluator

`tychoPromotionEvaluator` is deliberately a gate evaluator, not a domain-specific reward model. It ranks:

```text
promote > reject > blocked
```

and uses passed-step ratio only inside the same decision class. Later reward/metric adapters can replace it without changing `runEvolutionLoop` or the execution backend.

## Next step

After this runtime is validated on the runner machine, persist each `generation -> candidate -> run -> evaluation -> winner` record into the Node/Session model and render it in Canvas. Kubernetes/kagent should remain a later execution backend, not a replacement for the evolution contract.
