# Nodes Codex Runner

The Codex Runner is the local execution bridge between Nodes AI Canvas and `codex app-server`.

It intentionally runs outside the Next.js/Vercel process because Codex needs a long-lived process with access to a workspace, shell, files, Git, and the user's Codex authentication state.

By default, Canvas Codex runs select **GPT-5.6 Luna** as the model while retaining the Codex execution harness for shell, filesystem, tools, approvals, and agent lifecycle. Override `CODEX_RUNNER_MODEL` only when a project explicitly requires a different model.

## Architecture

```text
Nodes Canvas (browser)
  -> /api/agents/codex/*
  -> Nodes server
  -> CODEX_RUNNER_URL
  -> services/codex-runner/server.mjs
  -> codex app-server --listen stdio://
  -> Codex harness
       -> model: gpt-5.6-luna (default)
```

## Prerequisites

1. Install Codex CLI on the machine that will run the agent.
2. Run `codex login` (or open `codex` and sign in) with the ChatGPT account that should power Codex.
3. Make sure every repository/workspace you want Codex to access exists on that same machine.
4. Use Node.js 22 or newer.

## Start locally

```bash
cd services/codex-runner
cp .env.example .env
# Edit .env with an absolute workspace path and a strong shared token.
npm run start:env
```

The runner listens on `127.0.0.1:8787` by default.

Configure the Nodes app with matching values:

```bash
CODEX_RUNNER_URL=http://127.0.0.1:8787
CODEX_RUNNER_TOKEN=replace-with-a-long-random-secret
CODEX_RUNNER_MODEL=gpt-5.6-luna
```

For a remote Nodes deployment, keep the runner on a private network or authenticated tunnel and point `CODEX_RUNNER_URL` at that private endpoint. The runner is not intended to run as a normal Vercel Function.

## Windows background autostart

On Windows, the runner can be installed once as a per-user Scheduled Task so you do not have to run `npm run start:env` manually every time.

From PowerShell:

```powershell
cd services/codex-runner
npm run autostart:install:windows
```

This installs and immediately starts `Nodes AI Canvas Codex Runner`. After that it starts automatically when you sign in to Windows.

The scheduled task launches `windows-runner.ps1`, which:

- runs the runner in a hidden background process;
- reads `services/codex-runner/.env`;
- checks `/healthz` first to avoid a duplicate runner;
- restarts the runner automatically after an unexpected exit;
- writes local logs under `services/codex-runner/.logs/`.

Check the runner at:

```text
http://127.0.0.1:8787/healthz
```

The health and readiness responses include the selected model so a caller can verify that Luna is active before starting work.

Remove autostart with:

```powershell
npm run autostart:remove:windows
```

The installer uses the current Windows user and `RunLevel Limited`; it does not intentionally request administrator privileges. Windows policy may still require elevation on managed machines.

## Workspace configuration

The runner never accepts an arbitrary filesystem path from the browser or Nodes API. It resolves workspaces from runner-owned configuration.

Use one default workspace:

```bash
CODEX_DEFAULT_CWD=/absolute/path/to/repository
```

Or map multiple Nodes workspace/project ids:

```bash
CODEX_WORKSPACES_JSON='{"project-a":"/srv/repos/project-a","project-b":"/srv/repos/project-b"}'
```

When a child run is started manually with `parentRunId`, it inherits the parent's resolved workspace.

## Environment variables

- `CODEX_RUNNER_HOST`: bind host, default `127.0.0.1`.
- `CODEX_RUNNER_PORT`: bind port, default `8787`.
- `CODEX_RUNNER_TOKEN`: shared bearer secret expected from Nodes.
- `CODEX_BIN`: Codex executable, default `codex`.
- `CODEX_RUNNER_MODEL`: model passed to Codex `thread/start`; defaults to `gpt-5.6-luna`.
- `CODEX_DEFAULT_CWD`: one default runner-owned workspace.
- `CODEX_WORKSPACES_JSON`: optional JSON map from workspace ids to absolute runner-owned paths.
- `CODEX_RUNNER_AUTO_APPROVE=1`: automatically accepts Codex command/file approval requests. Disabled by default.
- `CODEX_RUNNER_REQUEST_TIMEOUT_MS`: JSON-RPC request timeout, default 30 seconds.
- `CODEX_RUNNER_APPROVAL_TIMEOUT_MS`: time before an unanswered approval is declined, default 5 minutes.

## Health checks

`GET /healthz` is an unauthenticated liveness probe and does not expose credentials. It reports the configured model along with runner status.

`GET /readyz` requires the runner token when configured. It starts `codex app-server` if needed, calls `account/read` to verify that the local Codex runtime is responsive and has account state available, and reports the configured model.

## Security

Keep the runner private. The default host is loopback-only. Do not expose it directly to the public internet.

Command and file approvals are not auto-accepted by default. Approval requests are streamed back to the Codex Agent node in the Canvas, where the user can approve or decline them.

Workspace paths are controlled exclusively by runner environment configuration. Requests cannot supply arbitrary `cwd` values.

## Multi-agent model

Each Canvas Agent node starts its own Codex thread/turn. A manually created child node sends its parent's `runId` as `parentRunId`, so Nodes can visualize parent/subagent relationships.

Codex-created child threads are also detected automatically. When `codex app-server` emits a child `thread/started` notification with a `parentThreadId`, the runner creates a child run, emits `agent/child/spawned` to the parent stream, and exposes a separate event stream for the child. Nodes then creates the corresponding child Agent node automatically.

## Persistence and reconnects

Nodes persists the Agent Canvas snapshot through its existing `agent_events` persistence backend, so this works with both file persistence and Supabase without an additional schema migration. Active streams resume from the last saved event id to avoid replaying already rendered output after a browser reload.
