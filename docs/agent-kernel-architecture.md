# Agent kernel architecture

Nodes owns a project/decision control plane and delegates execution to trusted runtimes such as Codex and NOOA. The agent kernel adds a provider-neutral extension layer between those two concerns without moving execution into the browser or weakening the existing sandbox boundaries.

The design borrows the strongest general idea from modern agent harnesses: capabilities should be composable and replaceable instead of requiring edits to one privileged agent loop. Nodes keeps that idea deliberately smaller than the product-level Project Map, Arena, Tycho and M1–M8 learning stack.

## Position in the system

```text
Canvas / Project Map / Arena
            |
            v
      Nodes control plane
            |
            v
       Agent kernel
   +--------+---------+
   | plugins/capabilities
   | request assembly
   | runtime waterfalls
   | lifecycle handles
   | stream projector
   | tool registry
   | session event log
   | context compaction
   +--------+---------+
            |
      runtime adapters
       /           \
    Codex          NOOA
      |             |
 trusted runner   OpenShell
      \             /
            Tycho
              |
           evidence
```

The kernel is not an execution sandbox. Filesystem, network, subprocess and model-provider credentials remain owned by trusted runners and OpenShell/Tycho policies.

## 1. Reversible plugins and capabilities

`AgentKernel` is a small microkernel with four extension mechanisms:

- `provide(name, value)` registers one capability;
- `on(event, listener)` observes lifecycle events;
- `intercept(point, middleware)` installs an ordered waterfall interceptor;
- `effect(setup)` registers an effect with deterministic cleanup.

A plugin mount is transactional. If `apply()` throws, all registrations already made by that plugin are rolled back in reverse order. Unmounting a plugin reverses its registrations, and a provider cannot be unloaded while another mounted plugin declares a dependency on one of its capabilities.

## 2. Request assembly

`AgentRequestAssembler` owns provider-neutral request composition. Global prompt sections may be registered on the kernel and request-scoped sections may shadow them by name. Assembly records a canonical header containing runtime, session/project identity, role, model, reasoning effort, approval/sandbox metadata, context capacity, authorized workspace paths, visible tool names and the ordered section names.

The original human prompt stays separate from system/context material. `effectivePrompt` is the compatibility projection for runtimes that currently accept one prompt string.

Policy ownership remains explicit. For example, the Codex workload API contributes the server-authoritative workload section because that API owns the authorized artifact manifest; the generic Codex runner client does not silently impose that section on Evolution, M4 or other callers.

## 3. Runtime start and lifecycle

Both Codex and NOOA starts pass through the shared `runtime.start` waterfall. Lifecycle observations record the effective request that reaches the provider after interceptor rewrites.

Post-start lifecycle is exposed through `AgentHandle`:

- `cancel()`;
- `openEventStream()`;
- `resolveApproval()` when the provider supports approvals.

Capabilities are declared by runtime. Codex currently exposes cancel, event streaming and approvals; NOOA exposes cancel and event streaming. Requesting an unsupported capability fails loudly with `UNSUPPORTED_CAPABILITY` instead of silently degrading.

Provider-specific control-plane operations that are not common lifecycle semantics remain on their provider clients.

## 4. Tool runtime

`AgentToolRegistry` makes tool execution a first-class capability instead of provider-specific glue.

Each tool declares a stable name and description, input/output parsers, an execution function, optional cooperative timeout metadata and `parallel` or `exclusive` scheduling metadata.

After schema parsing, arguments and successful results cross a lossless-JSON boundary. Non-finite numbers, sparse arrays, circular values and non-plain objects such as `Date` are rejected. Accepted arguments are cloned and deeply frozen before guards or execution; accepted results are cloned before returning to consumers.

Guards are monotonic and fail closed. The registry returns typed errors for unknown tools, invalid arguments, denied calls, invalid output, cancellation and timeout.

## 5. Event-sourced session surface

`AgentSessionLog` is an append-only typed event log. Model-visible history is derived from that log rather than maintained as a second mutable transcript.

Surface events are `user.message`, `assistant.message` and `tool.result`. Durable non-surface facts include turn/step boundaries, canonical request snapshots, runtime-run bindings, raw provider/runtime observations, tool calls and compaction records.

Context replacement is append-only. A checkpoint names the exact visible range it shadows and records complete source-sequence provenance. `repairInterruptedTail()` closes an open persisted turn with an explicit `interrupted` outcome instead of truncating history.

## 6. Durable execution journals

Every Codex or NOOA start creates a per-execution `journalId`. Before provider dispatch, Nodes durably writes:

1. the canonical request snapshot;
2. the original human message; and
3. a `runtime.run` record with status `requested`.

If that initial checkpoint cannot be stored, the provider is not started. This preserves the invariant that work presented as reproducible has a reconstructable initial request.

`DurableAgentSessionJournal` persists kernel events through the existing `AgentWorkRepository`, so the same implementation works with the file and Supabase backends. Journal event ids are deterministic UUID-shaped hashes of `journalId + sequence`, making retries idempotent and compatible with the Supabase `agent_events.id` UUID column. Loading reconstructs `AgentSessionLog` from stored events and can repair an interrupted turn explicitly.

The provider response is bound back to the journal with `runtime.run: started`; start failures are also recorded. Those post-dispatch writes are best-effort so a transient persistence failure cannot hide a provider run that already exists.

### Runtime stream projection

The Codex and NOOA event endpoints now wrap the live SSE stream with a provider-neutral journal projector while forwarding the original bytes unchanged to the client. The projector resolves the journal from the durable `runtime.run` binding, then appends one `runtime.event` for each accepted upstream event. Raw runtime records preserve upstream event id, type, source, runtime, provider timestamp/sequence when available, lineage fields and the lossless-JSON payload.

Codex envelopes are normalized through the existing Codex event mapper before projection; NOOA already emits the canonical runtime vocabulary and is admitted directly. Upstream event ids are used as replay identities so reconnect/backlog delivery can be deduplicated without duplicating model-visible history.

Where the canonical event contains enough semantics, the projector also derives typed session facts:

- `agent.started` opens a turn;
- completed assistant messages become `assistant.message` surface entries;
- tool start/completion can become `tool.call` and `tool.result` entries;
- terminal runtime events append the final `runtime.run` state and close the turn as completed, failed or cancelled.

Journal persistence is observational and must not corrupt the live control path: once a provider run exists, a projection write failure is logged but does not intentionally replace or truncate the upstream SSE response.

The remaining durability boundary is ownership of stream ingestion. Projection currently occurs when the runtime stream is consumed through the Nodes event endpoint. A reconnect can replay the runner backlog and deduplicate already persisted event ids, but a run that is never observed through that endpoint is not guaranteed to have every runtime event mirrored. A future server-owned ingestion/callback path is required before claiming stream durability that is fully independent of browser or API-stream consumers.

## 7. Context compaction

`AgentContextCompactor` is provider-neutral. It receives an injected token estimator and summarizer, selects an old prefix while retaining a bounded recent tail, verifies that the proposed checkpoint reduces estimated context, then appends a provenance-preserving replacement plus a log-only compaction record.

It is not yet wired to provider-advertised context windows or production tokenizer/summarizer plugins.

## Core capabilities

The default runtime kernel currently provides:

```text
agent.tools                -> AgentToolRegistry
agent.session-log-factory  -> creates AgentSessionLog instances
agent.request-assembler    -> AgentRequestAssembler
```

Additional capabilities should be introduced when a real cross-provider consumer exists, rather than creating speculative seams.

## Security invariants

The kernel must preserve these existing Nodes boundaries:

- browser input never resolves arbitrary host filesystem paths;
- caller-owned policy sections cannot be silently broadened by a generic runtime client;
- plugins do not bypass OpenShell, trusted-runner or Tycho isolation;
- a tool policy denial is fail-closed;
- tool arguments and results admitted to the canonical boundary are lossless JSON;
- runtime credentials stay outside candidate sandboxes and Kubernetes workloads;
- model-visible checkpoints retain exact source-event provenance;
- a provider start that claims reproducibility has a durable pre-dispatch request checkpoint;
- reconnecting to a stream must not duplicate an already journaled upstream event;
- learned M1–M8 components may choose actions, but empirical execution/evidence remains the promotion authority.

## Next migration steps

1. Move stream ingestion to a server-owned callback/worker path if complete runtime durability must be independent of an active event-stream consumer.
2. Connect provider/model context-window metadata, token estimators and summarizers to automatic compaction.
3. Move reusable approval/sandbox/tool policy into scoped kernel capabilities while preserving runner enforcement boundaries.
4. Extend `AgentHandle` only when concrete cross-provider consumers need send/inject/status/wait-until-idle semantics.
5. Add durable fork/resume APIs over journals once server-owned stream ingestion is available.

The Project Map, Arena, Tycho and M1–M8 remain above this layer. The kernel exists to make the execution substrate reproducible and replaceable; it does not replace Nodes' decision and learning model.
