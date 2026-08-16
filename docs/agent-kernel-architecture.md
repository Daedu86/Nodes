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
   | runtime event ingestion
   | durable runner outbox
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

- `status()` from the durable journal;
- `waitUntilIdle()` with timeout and cancellation;
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

### Server-owned runtime event ingestion

Codex and NOOA can push runtime events directly to Nodes through `/api/agents/runtime-events`, independently of whether a browser or another API consumer opens the live SSE stream. The callback is authenticated with the same per-runtime shared secret used to authenticate Nodes to the trusted runner. Nodes validates runtime, owner, session, project, journal and run identity before admitting the event.

The callback URL and `journalId` are placed in `metadata.nodesKernel` before provider dispatch. This avoids a start-response race: the runner already knows the durable journal identity when its first runtime event is emitted, rather than waiting for Nodes to receive the provider `runId` and discover the journal afterward.

Each accepted event is normalized into the provider-neutral runtime vocabulary and appended as `runtime.event`. Raw runtime records preserve upstream event id, type, source, runtime, provider timestamp/sequence when available, lineage fields and the lossless-JSON payload. Codex envelopes reuse the existing Codex event mapper; NOOA already emits the canonical runtime vocabulary. Upstream event ids are replay identities, so callback retries and SSE backlog/reconnect delivery can be deduplicated.

Where the canonical event contains enough semantics, the projector also derives typed session facts:

- `agent.started` opens a turn;
- completed assistant messages become `assistant.message` surface entries;
- tool start/completion can become `tool.call` and `tool.result` entries;
- terminal runtime events append the final `runtime.run` state and close the turn as completed, failed or cancelled.

### Single-writer ownership

A journal must not have two concurrent sequence allocators. Before dispatch, the initial `runtime.run` event therefore records `eventIngestion` as either `callback` or `stream`.

Callback ownership is selected only when Nodes can resolve an HTTP(S) callback URL **and** the relevant runner shared secret is configured. For callback-owned runs, the SSE endpoint remains available as a live read transport but does not project the stream into the journal. For stream-owned or legacy runs, the SSE projector remains the compatibility fallback. This prevents callback and SSE from assigning competing journal sequences.

The runner delivery queue is serialized by `journalId`, not by provider `runId`. That matters for Codex child runs, which inherit their parent's journal: parent and child events are delivered through one ordered writer instead of racing as independent run queues.

### Durable runner outbox

Callback-owned runners now place each event in a disk outbox before forwarding it to live SSE subscribers. The stable outbox filename is derived from runtime, journal id and upstream event id, so retrying the same event reuses one pending record. Writes use a temporary file plus atomic rename; newly created outbox directories use mode `0700` and event files use mode `0600`. Runner credentials are never stored in an outbox record.

The callback entry is deleted only after Nodes acknowledges it with a successful HTTP response. Network failures, HTTP 429 and server errors are retried in-process; if delivery is still unsuccessful, the file remains pending. On runner startup, `recover()` scans the durable outbox, validates stored entries, orders them by original queue time/ordinal and resubmits them through the same per-journal serialization queue. Because the Nodes projection boundary deduplicates by upstream event id, a crash after server ACK but before local deletion safely produces an idempotent replay rather than duplicate model-visible history.

Codex defaults its outbox beside `CODEX_RUNNER_MANAGED_WORKSPACES_FILE` under `.state/runtime-event-outbox`. NOOA defaults under `NOOA_RUNNER_HOME/runtime-event-outbox`. `CODEX_RUNNER_EVENT_OUTBOX_DIR` and `NOOA_RUNNER_EVENT_OUTBOX_DIR` can override those locations. If a runner may be recreated on another host, the configured outbox directory must be backed by persistent storage for host-level recovery.

### Remaining durability boundary

The current outbox is process-restart durable when its underlying filesystem survives the restart. It does not make an ephemeral host filesystem durable across host replacement, and the atomic write/rename protocol is not a database transaction with the provider's own event source. Environments that require power-loss-grade or cross-host exactly-once transport should place the outbox on durable storage and can later add fsync/ACK checkpointing or a transactional message broker. Nodes already treats replay as at-least-once and idempotent at the journal projection boundary.

## 7. Context compaction

`AgentContextCompactor` is provider-neutral. It receives an injected token estimator and summarizer, selects an old prefix while retaining a bounded recent tail, verifies that the proposed checkpoint reduces estimated context, then appends a provenance-preserving replacement plus a log-only compaction record.

Runtime journal projection now checks compaction automatically after model-visible assistant messages and tool results. If the canonical request advertises a `contextWindow`, Nodes compacts at 80% pressure; otherwise it uses a 12k-token maintenance fallback. The default estimator reuses Nodes' deterministic character heuristic (`nodes.chars-per-4-v1`) and the default summarizer is a bounded local structural/extractive checkpoint (`nodes.structural-extractive-v1`). Automatic maintenance therefore makes no hidden provider call, consumes no user model credits, and does not bypass chat quota/audit. Both remain replaceable behind the compactor seam.

This compacts Nodes' durable model-visible replay surface. It does not mutate an opaque provider-owned live thread; applying checkpoints to a continued provider thread belongs to the future durable resume/fork seam.

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
- runtime callbacks are authenticated and bound to the declared owner/session/project/journal identity;
- each journal has one selected ingestion writer (`callback` or `stream`) for a run;
- callback delivery for parent/child runs sharing a journal is serialized by journal identity;
- pending callback events are persisted without runner credentials before live SSE delivery when callback ingestion is active;
- upstream event ids make retries and reconnects idempotent at the projection boundary;
- learned M1–M8 components may choose actions, but empirical execution/evidence remains the promotion authority.

## Next migration steps

1. Add durable fork/resume APIs over journals once continuation semantics are defined for provider threads and child-run lineage.
2. Move reusable approval/sandbox/tool policy into scoped kernel capabilities while preserving runner enforcement boundaries.
3. Add an optional semantic compaction summarizer only behind explicit credential, quota and audit policy; keep the local structural summarizer as the fail-safe default.
4. Extend `AgentHandle` further only when concrete cross-provider consumers need send/inject semantics.
5. If deployment requirements demand power-loss-grade or cross-host delivery guarantees, add fsync/ACK checkpointing or a durable broker behind the outbox seam.

The Project Map, Arena, Tycho and M1–M8 remain above this layer. The kernel exists to make the execution substrate reproducible and replaceable; it does not replace Nodes' decision and learning model.
