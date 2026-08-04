# Nodes NOOA Runner

This service is the local compute bridge for a NOOA agent node. It runs outside
Next.js, creates an ephemeral [OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox for each run, uploads a controlled NOOA worker plus an optional
workspace snapshot, and streams normalized runtime events back to Nodes.

```text
Canvas -> /api/agents/nooa/* -> NOOA_RUNNER_URL -> local runner
       -> OpenShell policy + sandbox image -> NOOA worker
```

The browser can select only a `workspaceId` and `policyId`. The runner resolves
their host paths, the sandbox image, OpenShell providers, and all credentials
from its own environment. It never accepts a raw filesystem path, policy YAML,
container image, provider, or environment variable from HTTP.

## Prerequisites

1. Node.js 22 or newer.
2. A reachable local OpenShell gateway and `openshell status` working.
3. An OpenShell policy that permits only the model/network access you intend.
4. A sandbox image containing Python and `nooa`.
5. Any model credential configured as an OpenShell provider, not supplied by
   the browser or copied into a Canvas request.

`policies/nooa-openai.example.yaml` is a narrow starting template for the
included Python image. Copy it to a runner-owned location and review it before
use; its binary path and `api.openai.com` allowance are intentionally specific
to that image/model choice.

Build an image that uses your fork of NOOA:

```shell
cd services/nooa-runner
docker build \
  --build-arg NOOA_PACKAGE='git+https://github.com/Daedu86/labs-OO-Agents.git' \
  -t nodes-nooa:local .
```

## Start locally

```shell
cd services/nooa-runner
cp .env.example .env
# Edit .env with absolute policy/workspace paths and a strong token.
npm run start:env
```

Configure the Nodes app with the same private endpoint and token:

```shell
NOOA_RUNNER_URL=http://127.0.0.1:8788
NOOA_RUNNER_TOKEN=replace-with-a-long-random-secret
```

`GET /healthz` is a liveness probe. Authenticated `GET /readyz` verifies the
worker/policy configuration and asks `openshell status` to verify the gateway.

## Policy and workspace configuration

Use stable ids rather than client-controlled paths:

```shell
NOOA_WORKSPACES_JSON='{"canvas":"/srv/repos/my-project"}'
NOOA_OPENSHELL_POLICIES_JSON='{
  "code-safe": {
    "path": "/srv/policies/nooa-code-safe.yaml",
    "image": "nodes-nooa:local",
    "providers": ["openai"]
  }
}'
```

The workspace is uploaded into `/workspace` as a **snapshot**. NOOA may inspect
or modify that copy, but this first integration never automatically downloads
or applies sandbox edits to the host. A later review/apply flow should make
write-back an explicit human decision.

## HTTP contract

`POST /v1/runs` accepts a compiled provider-neutral run:

```json
{
  "ownerId": "server-authenticated-owner",
  "run": {
    "schemaVersion": 1,
    "runtime": "nooa",
    "nodeId": "canvas-node-1",
    "sessionId": "session-1",
    "prompt": "Inspect the project and propose a fix.",
    "label": "NOOA Agent",
    "role": "custom",
    "projectId": "canvas",
    "workspaceId": "canvas",
    "parentRunId": null,
    "sandbox": { "provider": "openshell", "policyId": "code-safe" }
  }
}
```

`GET /v1/runs/:runId/events` is an SSE stream using the common runtime event
envelope. `POST /v1/runs/:runId/cancel` terminates the local CLI process and
deletes the generated sandbox by its runner-generated name.

## Security notes

- The runner binds to loopback by default and should remain private.
- OpenShell is the OS-level containment boundary; NOOA's Python guardrails are
  defense in depth only.
- Do not enable a broad policy merely to make a run work. Grant model egress,
  filesystem paths, and providers intentionally.
- Runtime input files are stored under the runner's temporary directory and
  removed when the run reaches a terminal state.
