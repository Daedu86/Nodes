# Codex agent runtime integration

Nodes keeps normal LLM chat and Canvas prompt execution on the existing Vercel AI SDK/OpenRouter path. Codex is a separate agent runtime for autonomous repository work.

## Architecture

```text
Browser / Nodes UI
       |
       | authenticated HTTP + SSE
       v
Next.js Codex agent API
       |
       | service-token authenticated HTTP
       v
Nodes Codex Runner
       |
       | JSON-RPC over stdio
       v
codex app-server
       |
       v
Codex core / tools / shell / filesystem / MCP
```

The runner intentionally lives outside the Vercel deployment. `codex app-server` is a long-lived process-oriented runtime whose primary supported transport is stdio. Local Nodes development can run the bridge on the same machine. A hosted Vercel deployment needs a separately reachable runner through a private network or authenticated tunnel; `127.0.0.1` inside Vercel is not the user's computer.

## Implemented Canvas behavior

The Canvas exposes **Add agent**. Each Codex Agent node can:

- choose a role (`coder`, `reviewer`, `researcher`, `tester`, or `custom`);
- start an independent Codex run;
- stream agent output and operational activity;
- cancel an active run;
- surface command/file approval requests with approve/decline controls;
- create a manual child Agent node linked to its parent;
- restore its state and position after a browser reload.

Multiple Agent nodes can run independently. Manual children use `parentRunId` and inherit the parent's runner workspace.

Codex-created child threads are also detected automatically. When app-server emits a child `thread/started` with `parentThreadId`, the runner creates a child run, emits `agent/child/spawned`, and the Canvas creates and streams a first-class child Agent node.

Recent operational events are also rendered as compact activity nodes connected to the Agent run. Supported visual activities include shell commands, tools, file changes, approvals, spawned subagents, and terminal run states.

## Persistence

Agent Canvas state is persisted through the existing `agent_events` repository abstraction, so both file persistence and Supabase work without an additional schema migration.

The API stores one stable `codex.canvas.snapshot` record per owner/session and updates it in place. A snapshot contains:

- run and thread ids;
- parent/child relationships;
- role, prompt, output, and status;
- node positions;
- pending approval id;
- a bounded recent event history.

Active runs reconnect automatically after a browser reload. SSE streams resume after the latest saved event id so already-rendered output is not replayed by the normal reload path.

The Codex runtime also appears as a synthetic **Codex Runtime** entry in Agent Work, allowing its session/project activity to be audited alongside token-based external agents.

## Nodes endpoints

### Start a run

`POST /api/agents/codex/runs`

```json
{
  "sessionId": "session-id",
  "prompt": "Implement the authentication flow and run the tests",
  "workspaceId": "project-a",
  "role": "coder",
  "label": "Auth implementation",
  "parentRunId": null
}
```

The browser cannot choose an arbitrary filesystem path. `workspaceId` is resolved by runner-owned `CODEX_WORKSPACES_JSON`, or the runner falls back to `CODEX_DEFAULT_CWD`. Manual child runs inherit their parent's resolved workspace.

### Persist/restore Canvas state

`GET /api/agents/codex/state?sessionId=:sessionId`

`POST /api/agents/codex/state`

### Stream run events

`GET /api/agents/codex/runs/:runId/events`

The endpoint proxies SSE from the runner. The optional `after` cursor resumes after a known event id. `lib/agents/codex/event-mapper.ts` converts app-server notifications into the stable `CodexCanvasEvent` vocabulary.

### Resolve an approval

`POST /api/agents/codex/runs/:runId/approvals/:approvalId`

```json
{
  "decision": "accept"
}
```

Supported decisions are `accept`, `acceptForSession`, `decline`, and `cancel`.

### Cancel a run

`POST /api/agents/codex/runs/:runId/cancel`

## Runner configuration

The Next.js server expects:

```text
CODEX_RUNNER_URL=http://127.0.0.1:8787
CODEX_RUNNER_TOKEN=<shared-service-secret>
```

The runner is implemented in `services/codex-runner/server.mjs` and launches:

```text
codex app-server --listen stdio://
```

The runner inherits the host machine's Codex authentication state. Run `codex login` on that machine before starting agent work.

Configure one default workspace:

```text
CODEX_DEFAULT_CWD=/absolute/path/to/repository
```

or a runner-owned workspace map:

```text
CODEX_WORKSPACES_JSON={"project-a":"/srv/repos/project-a"}
```

Requests cannot supply arbitrary `cwd` values.

Every Nodes-to-runner request includes `x-nodes-owner-id`. Run lookup, event streaming, cancellation, approvals, and parent-run lookup are owner-scoped.

## Runner HTTP contract

The runner exposes:

```text
GET  /healthz
GET  /readyz
GET  /v1/control/status
POST /v1/control
POST /v1/runs
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/cancel
POST /v1/runs/:runId/approvals/:approvalId
```

`/healthz` is a liveness probe. Authenticated `/readyz` starts app-server if needed and calls `account/read` to verify that the Codex runtime is responsive.

Agent Work uses `/v1/control/status` for a non-starting status read and `/v1/control` for explicit runtime, device-login, trusted-default-workspace, and Tycho-verification actions. The installed Windows launcher handles the otherwise impossible first hop when both the runner and ngrok tunnel are offline. Browser requests never contain local filesystem paths or authentication files.

A successful run start response:

```json
{
  "runId": "run-123",
  "threadId": "codex-thread-123",
  "agentId": "agent-123",
  "parentRunId": null,
  "status": "running"
}
```

The runner owns:

1. starting and supervising `codex app-server`;
2. performing the `initialize` / `initialized` handshake;
3. resolving safe runner-owned workspaces;
4. starting Codex threads and turns;
5. routing notifications to the matching Nodes run;
6. maintaining a bounded event backlog and SSE fan-out;
7. relaying command/file approvals;
8. tracking manual and Codex-generated parent/child runs;
9. scoping runs by Nodes owner id;
10. interrupting active turns when requested.

## Event model

```text
agent.started
agent.message.delta
agent.message.completed
agent.child.spawned
tool.started
tool.completed
shell.started
shell.completed
file.changed
approval.requested
approval.resolved
run.completed
run.failed
run.cancelled
```

The compatibility mapper keeps the Canvas isolated from most app-server protocol details.

## Remaining operational requirement

The application-side implementation is present in this branch, but a real end-to-end Codex run still requires an actual runner machine/process:

1. install Codex CLI;
2. authenticate it with `codex login`;
3. place or clone the target repository on that machine;
4. configure `services/codex-runner/.env`;
5. start the runner;
6. make its private endpoint reachable from the Nodes deployment and configure matching `CODEX_RUNNER_URL` / `CODEX_RUNNER_TOKEN`.

The runner currently keeps live process/run routing state in memory. Browser reloads are supported, but restarting the runner process itself interrupts active runs; those runs should be considered failed and restarted from the Canvas. Durable recovery of an in-flight Codex turn across a runner process restart is not implemented.

OpenRouter chat remains unchanged while Codex acts as a separate visual agent engine.
