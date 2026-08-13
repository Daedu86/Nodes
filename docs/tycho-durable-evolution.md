# Durable Tycho evolution

M1 keeps Canvas as the control plane and the user-local runner as the execution plane. Long evolution episodes are not tied to a browser tab or Vercel Function lifetime.

## Lifecycle

Canvas starts an episode through `POST /api/evolution/runs`. Nodes persists two Session artifacts:

- `.nodes/evolution-session.json` — append-only evolution evidence and episode history (schema v2).
- `.nodes/evolution-run.json` — the durable runner link and current lifecycle state (schema v1).

The local Tycho runner persists its authoritative run state under `TYCHO_EVOLUTION_STATE_DIR` (default `~/.nodes-ai-canvas/evolution-runs`) using atomic file replacement. Every terminal generation is checkpointed before the next generation begins.

Canvas can reconnect with `GET /api/evolution/runs/:runId?sessionId=...`; Nodes reads the durable runner state and reconciles completed generations back into the Session evidence. `POST /api/evolution/runs/:runId/cancel?sessionId=...` persists cancellation intent and propagates cancellation to active Codex and Tycho child runs.

A runner restart recovers non-terminal episodes from the last persisted generation. An already-persisted user cancellation becomes terminal `cancelled` during recovery and is never silently resumed.

## Execution boundaries

- Codex/Luna runs in `hypothesis-only` mode: approval policy `never`, read-only sandbox, and the generator also fails closed on observable tool, shell, file-change, approval, or child-agent activity.
- Tycho candidates execute in isolated ephemeral workspaces using the existing `tycho-experiment` protocol/result contract.
- Candidate starts are concurrency-limited by `TYCHO_EVOLUTION_MAX_CONCURRENCY`; populations larger than that limit are queued inside the generation rather than rejected as budget overflow.
- `.nodes/tycho-experiment.json` is injected authoritatively and generated variants cannot overwrite it or escape the workspace with absolute/parent-traversal paths.

## Live M1 smoke test

Run this on the same machine as the authenticated Nodes/Codex/Tycho runner after setting the normal runner environment:

```bash
cd services/codex-runner
TYCHO_EVOLUTION_RUNNER_URL=http://127.0.0.1:8788 \
NODES_EVOLUTION_SMOKE_WORKSPACE_ID=<allowlisted-workspace-id> \
NODES_EVOLUTION_SMOKE_PROTOCOL_FILE=/path/to/workspace/.nodes/tycho-experiment.json \
npm run smoke:durable
```

Optional variables:

- `CODEX_RUNNER_TOKEN`
- `NODES_EVOLUTION_SMOKE_OWNER_ID`
- `NODES_EVOLUTION_SMOKE_PROJECT_ID`
- `NODES_EVOLUTION_SMOKE_SESSION_ID`
- `NODES_EVOLUTION_SMOKE_GENERATIONS` (default `1`)
- `NODES_EVOLUTION_SMOKE_POPULATION` (default `2`)
- `NODES_EVOLUTION_SMOKE_TIMEOUT_MS` (default `600000`)
- `NODES_EVOLUTION_SMOKE_POLL_MS` (default `1000`)

The smoke test requires `/readyz` to report both `tychoReady: true` and `durableEvolution: true`, starts a real durable episode, waits through Codex hypothesis generation and Tycho candidate execution, then fails unless every requested generation has a winner and the final champion has a finite score.
