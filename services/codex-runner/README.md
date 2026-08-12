# Nodes Codex Runner

The Codex Runner is the local execution bridge between Nodes AI Canvas and `codex app-server`.

It intentionally runs outside the Next.js/Vercel process because Codex needs a long-lived process with access to a workspace, shell, files, Git, and the user's Codex authentication state.

By default, Canvas Codex runs select **GPT-5.6 Luna** as the model while retaining the Codex execution harness for shell, filesystem, tools, approvals, and agent lifecycle. Override `CODEX_RUNNER_MODEL` only when a project explicitly requires a different model.

On the `feature/tycho-experiment-harness` branch, selected project workloads also require the local Tycho experiment harness to pass `tycho-experiment --doctor` with Docker or Finch isolation before the Canvas enables Run.

## Tycho isolated readiness

Install Tycho on the runner machine from the matching feature branch and prepare its sandbox:

```bash
python -m pip install -e /path/to/Tycho-Llm-Luna
cd /path/to/Tycho-Llm-Luna
make sandbox-image
tycho-experiment --doctor
```

The doctor must return an isolated runtime of `docker` or `finch`. `host` is deliberately rejected. The runner invokes only the fixed `--doctor` command with `shell: false`; the browser cannot choose an executable, arguments, runtime, image, or host path.

Optional runner-local configuration:

```bash
TYCHO_EXPERIMENT_BIN=tycho-experiment
TYCHO_DOCTOR_TIMEOUT_MS=20000
```

Authenticated `GET /readyz` reports `tychoReady`, `tychoRuntime`, `tychoImage`, and `tychoStatus`. The Canvas Tycho Runner remains disabled until `tychoReady` is true.

For normal runner setup, workspace mapping, Windows autostart, approvals, SSE/reconnect behavior, and security boundaries, keep using the existing runner configuration. This feature adds Tycho isolation readiness without changing Codex authentication ownership or accepting browser-supplied filesystem paths.
