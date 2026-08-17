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
   experiments / Tycho gates
            |
            v
       Agent kernel
   +--------+---------+
   | plugins/capabilities
   | request assembly
   | scoped policy
   | runtime waterfalls
   | lifecycle handles
   | durable metrics
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
- `metrics()` from durable journal facts such as tokens, compaction, tools, approvals and continuation count;
- `waitUntilIdle()` with timeout and cancellation;
- `resume()` / `fork()` create typed durable-continuation descriptors for the next explicit start;
- `cancel()`;
- `openEventStream()`;
- `resolveApproval()` when the provider supports approvals.

Capabilities are declared by runtime. Codex currently exposes cancel, event streaming and approvals; NOOA exposes cancel and event streaming. Durable status, metrics, wait, resume and fork are Nodes-owned cross-provider capabilities. Requesting an unsupported runtime capability fails loudly with `UNSUPPORTED_CAPABILITY` instead of silently degrading.

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

Callback-owned runners place each event in a disk outbox before forwarding it to live SSE subscribers. The stable outbox filename is derived from runtime, journal id and upstream event id, so retrying the same event reuses one pending record. Writes use a temporary file plus atomic rename; newly created outbox directories use mode `0700` and event files use mode `0600`. Runner credentials are never stored in an outbox record.

The callback entry is deleted only after Nodes acknowledges it with a successful HTTP response. Network failures, HTTP 429 and server errors are retried in-process; if delivery is still unsuccessful, the file remains pending. On runner startup, `recover()` scans the durable outbox, validates stored entries, orders them by original queue time/ordinal and resubmits them through the same per-journal serialization queue. Because the Nodes projection boundary deduplicates by upstream event id, a crash after server ACK but before local deletion safely produces an idempotent replay rather than duplicate model-visible history.

Codex defaults its outbox beside `CODEX_RUNNER_MANAGED_WORKSPACES_FILE` under `.state/runtime-event-outbox`. NOOA defaults under `NOOA_RUNNER_HOME/runtime-event-outbox`. `CODEX_RUNNER_EVENT_OUTBOX_DIR` and `NOOA_RUNNER_EVENT_OUTBOX_DIR` can override those locations. If a runner may be recreated on another host, the configured outbox directory must be backed by persistent storage for host-level recovery.

### Remaining durability boundary

The current outbox is process-restart durable when its underlying filesystem survives the restart. It does not make an ephemeral host filesystem durable across host replacement, and the atomic write/rename protocol is not a database transaction with the provider's own event source. Environments that require power-loss-grade or cross-host exactly-once transport should place the outbox on durable storage and can later add fsync/ACK checkpointing or a transactional message broker. Nodes already treats replay as at-least-once and idempotent at the journal projection boundary.

## 7. Context compaction

`AgentContextCompactor` is provider-neutral. It receives an injected token estimator and summarizer, selects an old prefix while retaining a bounded recent tail, verifies that the proposed checkpoint reduces estimated context, then appends a provenance-preserving replacement plus a log-only compaction record.

Runtime journal projection checks compaction automatically after model-visible assistant messages and tool results. If the canonical request advertises a `contextWindow`, Nodes compacts at 80% pressure; otherwise it uses a 12k-token maintenance fallback. The default estimator reuses Nodes' deterministic character heuristic (`nodes.chars-per-4-v1`) and the default summarizer is a bounded local structural/extractive checkpoint (`nodes.structural-extractive-v1`). Automatic maintenance therefore makes no hidden provider call, consumes no user model credits, and does not bypass chat quota/audit. Both remain replaceable behind the compactor seam.

This compacts Nodes' durable model-visible replay surface. It does not mutate an opaque provider-owned live thread. Durable resume/fork consumes this compacted surface through an explicit replay seam described below.

## 8. Durable resume and fork

`AgentHandle.resume()` and `AgentHandle.fork()` are side-effect-free descriptor builders. The descriptor names the source runtime/run and is consumed by the next explicit Codex or NOOA start request through its `continuation` field. This keeps workload files, sandbox policy, role and other target-run configuration under the normal server-owned start path instead of hiding a provider start behind the lifecycle handle.

Before dispatch, Nodes resolves the source run back to its owner-bound durable journal and snapshots the current model-visible surface at an exact journal sequence. `resume` requires a terminal source and the same runtime/session/project. `fork` requires an idle source boundary and may target another runtime or session, which is the primitive needed for independent Challenger branches. A running source cannot be forked because its selected single writer may still be appending events.

The new execution receives a fresh journal. Its first event is `continuation.source`, which records the source journal/run, boundary sequence, visible source sequences, latest checkpoint sequence when present, source timestamp and the `nodes-durable-replay-v1` strategy. The current visible surface is then copied into the child journal before the new request snapshot and human continuation prompt are persisted. The parent journal is never mutated.

Because current Codex and NOOA runner starts accept a flattened prompt rather than a provider-neutral message-history API, Nodes also renders the copied surface as the authoritative `nodes:durable-continuation-replay` request section. The section explicitly states that this is a Nodes-owned replay and **not** proof of provider-native thread resumption. Provider-private state outside the durable transcript is intentionally not assumed. A future adapter may map this seam to a true provider resume token only when that provider exposes semantics Nodes can verify.

## 9. Scoped policy capability

Reusable policy is resolved as a declarative kernel capability across four ordered scopes:

```text
global -> project -> agent -> execution
```

Each scope may constrain approval modes, sandbox policy ids, visible tool names and authorized workspace paths. Resolution is monotonic: a child scope intersects its allow-list with the effective parent set. `undefined` means inherit; an explicit empty list means deny all. A narrower scope therefore cannot silently re-add a permission already removed by a broader scope.

`agent.policy-resolver` exposes both resolution and a fail-closed assertion helper. This does **not** move enforcement into the kernel: the trusted runner/OpenShell remains the authority that enforces filesystem, network, subprocess, sandbox and credential boundaries. The kernel capability makes intended policy composable and auditable before dispatch.

## 10. Durable runtime observability

`agent.metrics-collector` and `AgentHandle.metrics()` project operational facts from the durable journal without provider-specific parsing. The current projection includes:

- first/last journal event and elapsed duration;
- model input/output token counts when reported;
- context compaction count and estimated tokens saved;
- tool calls and tool errors;
- approval requests;
- interrupted turns;
- continuation count.

These metrics deliberately do not invent runner-local state. Callback retry counts, current durable-outbox depth and similar infrastructure gauges must come from a runner telemetry adapter until those facts are journaled. This separation keeps Arena/Tycho evidence reproducible while allowing infrastructure telemetry to evolve independently.

## 11. Arena experimental runtime

Arena experiments use the durable continuation seam instead of maintaining a second branching system. `buildArenaExperimentPlan()` receives a champion `AgentHandle` and creates one `fork()` descriptor per challenger. Challengers can target Codex or NOOA and may use independent sessions while retaining champion runtime/run lineage, model metadata and a stable experiment/candidate identity.

`experimentPlanToTychoVariants()` projects those start requests into the existing Tycho variant contract. Tycho remains the empirical quality authority: `applyTychoEvaluation()` always derives `qualityScore` from Tycho's verified `evaluation.score`. Operational cost, latency and token evidence can be attached from Tycho metrics or `AgentHandle.metrics()`.

Each `ExperimentRunRecord` is a first-class durable snapshot containing candidate/runtime/model/prompt identity, parent/source run lineage, journal/run ids, lifecycle state, quality/cost/latency/token metrics, Tycho evaluation and promotion outcome. `persistExperimentRun()` stores append-only snapshots through the existing `AgentWorkRepository`, so both file and Supabase backends use the same persistence path. Loading selects the latest snapshot for each candidate without deleting the earlier evidence.

Project Arena can project these records through `buildProjectArenaExperimentEntries()` and display quality, cost, latency, tokens and explicit utility together. The default utility weights are 0.70 quality, 0.15 cost and 0.15 latency; callers can configure them. Candidates missing a metric that currently has non-zero weight are not eligible for utility promotion, preventing an unmetered run from winning by omission. Ranking is advisory: `recordExperimentPromotion()` is a separate operation so Tycho, safety and business gates can still block a numerically leading challenger.

This closes the substrate loop:

```text
Champion durable run
        |
        +--> fork A --> Codex/NOOA --> evidence --+
        +--> fork B --> Codex/NOOA --> evidence --+--> Tycho evaluation
        +--> fork C --> Codex/NOOA --> evidence --+        |
                                                         v
                                                 Arena comparison
                                                         |
                                                   promotion gate
                                                         |
                                                durable lineage
```

The current module/API layer supplies the reproducible experiment contract and Arena projection. Product UI can consume that adapter without learning provider-specific lifecycle semantics.

## 12. Reusable project starters

The project layer includes reusable starter maps for product discovery, research synthesis, technical design and writing. Project creation accepts a stable `templateId`, produces a normal `ProjectMap`, and continues to apply existing user/session ownership filtering. Templates are therefore seeds for the same Project Map/Arena workflow rather than a parallel project format.

## Core capabilities

The default runtime kernel currently provides:

```text
agent.tools                -> AgentToolRegistry
agent.session-log-factory  -> creates AgentSessionLog instances
agent.request-assembler    -> AgentRequestAssembler
agent.policy-resolver      -> monotonic scoped policy resolution/assertion
agent.metrics-collector    -> durable journal metrics projection
```

Additional capabilities should be introduced when a real cross-provider consumer exists, rather than creating speculative seams.

## Security invariants

The kernel must preserve these existing Nodes boundaries:

- browser input never resolves arbitrary host filesystem paths;
- caller-owned policy sections cannot be silently broadened by a generic runtime client;
- scoped child policy can restrict but cannot re-add denied parent permissions;
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
- experiment ranking cannot substitute for Tycho evidence or the explicit promotion gate;
- learned M1–M8 components may choose actions, but empirical execution/evidence remains the promotion authority.

## Next migration steps

1. Bind the Arena experiment projection into the interactive Project Map/Arena UI and expose explicit launch/promotion controls over the existing experiment contract.
2. Add runner-side telemetry for callback retry counts and outbox depth when operators need those gauges beside durable journal metrics.
3. Add an optional semantic compaction summarizer only behind explicit credential, quota and audit policy; keep the local structural summarizer as the fail-safe default.
4. Add provider-native resume tokens only for runtimes whose continuation semantics can be verified against the durable replay boundary.
5. If deployment requirements demand power-loss-grade or cross-host delivery guarantees, add fsync/ACK checkpointing or a durable broker behind the outbox seam.

The Project Map, Arena, Tycho and M1–M8 remain above the agent kernel. The kernel exists to make the execution substrate reproducible, measurable and replaceable; it does not replace Nodes' decision and learning model.
