# Nodes CLI

`nodes` is a read-only operational interface over the same project, session, workload, artifact, agent-work, and runner state used by the Nodes application. It is intended for humans, Codex, and other local agents that need authoritative context without copying internal ids from the UI.

It does not execute Codex runs, run Tycho experiments, replace the runner, or accept arbitrary workspace paths.

## Architecture

```text
nodes CLI
    |
    +-- project/session repository interfaces
    |       +-- file backend
    |       `-- Supabase backend
    |
    +-- normalized project map
    |       +-- workload sessions and primary session
    |       +-- direct upstream selected outputs
    |       `-- selected upstream session artifacts
    |
    +-- agent-work repository
    |       `-- allowlisted Codex run metadata
    |
    `-- shared Codex runner readiness service
            `-- optional runner-reported Tycho capability state
```

The CLI imports repository interfaces through `lib/persistence/repositories.ts`. It does not query Supabase separately and does not call localhost Next.js routes. Runner readiness is shared with `GET /api/agents/codex/status`, so the UI and CLI use the same workspace-map and Codex-authentication rules.

## Installation and invocation

From the repository:

```bash
npm ci
npm run nodes -- project list
npm run nodes -- project diagnose <project-id>
```

To expose the `nodes` executable while developing this repository:

```bash
npm link
nodes --help
```

`npm link` links the `bin.nodes` entry in `package.json`; it does not install a second persistence client or service. The executable loads `.env.local` from the invocation directory when that file exists. It can also be invoked directly as `./bin/nodes.mjs`.

## Authentication and configuration

The CLI never reuses a browser cookie or reads Codex authentication files. It requires an explicit actor context using one of these mechanisms:

1. `NODES_AGENT_TOKEN`: an existing Nodes agent token. The CLI validates its signature, authoritative token record, revocation state, and expiry through the existing agent-token implementation.
2. `NODES_CLI_USER_ID`: a trusted local user id. `NODES_CLI_USER_EMAIL` may also be set so accepted email-based project memberships can be resolved.

`NODES_CLI_OWNER_ID` is accepted as a compatibility alias for `NODES_CLI_USER_ID`. User ids are not credentials, so the direct-id mode is intended only for a trusted local machine/process that already has access to the configured persistence credentials. Prefer an agent token for automation or shared environments.

Examples:

```bash
NODES_CLI_USER_ID='dev:demo@nodes.local' npm run nodes -- project list

NODES_AGENT_TOKEN='<existing-agent-token>' nodes session inspect <session-id>
```

The normal persistence variables still select and configure the backend:

```text
NODES_PERSISTENCE_BACKEND=file|supabase
PROJECT_STORE_DIR=...              # optional file backend override
SESSION_STORE_DIR=...              # optional file backend override
SUPABASE_URL=...                   # Supabase backend
SUPABASE_SERVICE_ROLE_KEY=...      # Supabase backend; never printed
```

Legacy ownerless file records are read without claiming or rewriting them. Normal application behavior is unchanged; only CLI inspection opts out of legacy ownership mutation.

## Commands

```text
nodes project list
nodes project inspect <project-id>
nodes project map <project-id>
nodes project diagnose <project-id>

nodes workload list <project-id>
nodes workload inspect <project-id> <workload-id-or-exact-title>

nodes session inspect <session-id>
nodes session artifacts <session-id>

nodes runner status <project-id>
nodes tycho status <project-id>
```

Every inspection command supports `--json`. `--debug` adds a sanitized error class on failure; it does not print stacks, environment values, credentials, or workspace paths.

Group help is available through:

```text
nodes --help
nodes project --help
nodes workload --help
nodes session --help
nodes runner --help
nodes tycho --help
```

### Project diagnosis

`project diagnose` correlates:

1. the accessible project and normalized project map;
2. the derived current workload;
3. all workload sessions and the authoritative primary session;
4. direct upstream dependencies, their selected outputs, and only their selected artifact ids;
5. authoritative primary-session execution artifacts;
6. runner reachability, Codex state, and exact project-id workspace mapping;
7. optional runner-reported Tycho readiness;
8. stable execution blockers.

Project-map selection in the UI is currently ephemeral client state. The CLI therefore derives the current workload deterministically from normalized map order using the first matching status in this order:

```text
active -> blocked -> ready -> planned -> complete
```

Human and JSON output both disclose that the selection was derived and include the rule used. `workload inspect` should be used when a caller needs a specific node regardless of current status.

The managed-run readiness gate remains aligned with the Runner UI: project owner, reachable runner, running and authenticated Codex, exact project workspace mapping, and a resolvable primary session. A Tycho-related workload additionally requires authoritative Tycho artifacts and runner-reported Tycho readiness.

### Workload lookup

`workload inspect` accepts a workload id first, then an exact case-sensitive title. Duplicate exact titles fail as ambiguous and instruct the caller to use an id.

Upstream means a direct incoming project-map edge, matching `getProjectMapUpstreamNodes`. An artifact is selected upstream only when its id appears in that upstream node's normalized `selectedOutput.artifactIds` and its source session can be resolved within the project owner boundary.

### Session inspection

Session output contains allowlisted metadata only:

- id, title, archive state, version, timestamps, and message count;
- accessible project/workload associations and primary status;
- artifact names, ids, semantic/type metadata, MIME type, size, and timestamps;
- project-map selected-output references;
- bounded Codex snapshot/run identifiers, labels, roles, and statuses.

Artifact content, revisions, data URLs, blob references, run prompts, run output, event payloads, authentication data, and arbitrary paths are not serialized.

### Runner status

Runner inspection reuses the existing authenticated `/healthz` and `/readyz` client logic. It reports only:

- configured and online state;
- Codex process and authentication state;
- exact project workspace mapping using the project id as `workspaceKey`;
- model and a safe readiness reason.

It never reports `CODEX_RUNNER_URL`, `CODEX_RUNNER_TOKEN`, `CODEX_WORKSPACES_JSON` values, or resolved filesystem paths.

### Tycho status and provenance

Tycho status is inspection-only. It never invokes a Tycho executable or experiment.

The existing runner contract may optionally report a safe nested `tycho` object from `/readyz` or `/healthz`:

```json
{
  "tycho": {
    "ready": true,
    "runtime": "docker",
    "image": "tycho-python-sandbox:0.2",
    "reason": null,
    "filesystemProtocolPresent": true,
    "filesystemExperimentPresent": true,
    "filesystemResultPresent": false,
    "decision": null
  }
}
```

Nodes allowlists these fields. Older runners remain compatible and appear as `reportedByRunner: false` with unknown Tycho readiness.

Filesystem presence and authoritative session presence are intentionally separate:

```text
filesystemProtocolPresent       <- runner-reported workspace fact
authoritativeProtocolPresent    <- exact artifact in the primary Nodes session
```

`.nodes/tycho-experiment.json` is authoritative only when the primary session contains an artifact whose exact logical file name or title is `.nodes/tycho-experiment.json`. A true filesystem flag never changes that result. The same distinction applies to `.nodes/experiment.py` and result state.

Tycho-related workloads are derived conservatively from the word `Tycho` in workload title/description or existing `.nodes/tycho-*` primary-session artifacts. This avoids project-id special cases. A future typed runtime field in the project-map schema can replace this derivation without changing the CLI JSON field meanings.

## JSON schema

JSON output uses explicit allowlisted view models and includes `schemaVersion: 1`. It never dumps repository documents, runner response bodies, or environment objects.

The project diagnosis shape is:

```json
{
  "schemaVersion": 1,
  "project": {},
  "workload": {},
  "workloadSelection": {
    "source": "derived-project-map-state",
    "reason": "first active workload in normalized project-map order"
  },
  "primarySession": {},
  "sessions": [],
  "upstream": [],
  "artifacts": [],
  "authoritativeArtifacts": [],
  "runner": {},
  "tycho": {},
  "execution": {
    "runnable": false,
    "blockers": [
      {
        "code": "authoritative_tycho_protocol_missing",
        "message": "Authoritative Tycho protocol missing from the primary session."
      }
    ]
  }
}
```

Field order is stable for readability, but consumers should depend on field names and `schemaVersion`, not JSON object order. Blocker `code` values are the machine contract; messages are explanatory text.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Inspection completed and, for readiness commands, the inspected state is ready/runnable. |
| `1` | Invalid arguments, unsafe id, unknown command, or ambiguous workload title. |
| `2` | Project, session, or workload not found within the actor's access boundary. |
| `3` | Authentication or persistence configuration unavailable. |
| `4` | Runner status unavailable. |
| `5` | Diagnosis completed, printed useful output, and execution is blocked/not runnable. |

`project diagnose` always prints the diagnosis before returning `5`. `runner status` returns `4` when the runner is offline or unconfigured. Inspection-only project/workload/session commands return `0` when the requested state was successfully read, even when that state describes a blocked workload.

## Security boundaries

- Every project read uses actor-aware repository access. Session reads use the resolved project owner id, including for accepted collaborators.
- Invalid project/session ids are rejected before repository or filesystem access.
- The CLI cannot accept `cwd`, a workspace path, a shell command, or experiment arguments.
- Workspace mapping remains runner-owned and keyed by project id.
- Session artifacts are authoritative; local files cannot promote themselves into Nodes provenance.
- Output uses allowlists and redacts secret-looking bearer/token/password/key text.
- Credential files, raw environment values, Supabase secrets, runner secrets, artifact bodies, blob references, arbitrary local paths, and raw Codex snapshots are never output.
- All commands are read-only with respect to Nodes persistence and project work. The shared runner readiness probe may initialize `codex app-server`, matching the existing Runner UI behavior, but it never starts a Nodes/Codex workload or a Tycho experiment.

## Relationship to Codex and Tycho

```text
nodes                  inspect and diagnose Nodes state
Codex Runner / Codex   execute managed agent work explicitly
tycho-*                execute isolated empirical work explicitly
```

`nodes` reports why execution is blocked. It does not make the blocked action happen.

## Current limitations

- The project map does not persist UI selection, so current workload selection is derived as documented above.
- The stock Codex runner does not currently implement Tycho. Tycho runtime, image, filesystem, and decision fields remain unknown unless a compatible runner reports the optional allowlisted capability object.
- The CLI does not inspect arbitrary workspace files locally. Filesystem facts must come from the runner's safe project-id mapping contract.
- Live Supabase validation requires the same service configuration used by the application and a valid actor context.
