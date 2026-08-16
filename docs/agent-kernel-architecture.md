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
   | runtime waterfalls
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

This is intentionally stricter than an ad-hoc global registry: extension state has an owner and a lifecycle.

## 2. Runtime start waterfall

`lib/agents/runtime/kernel.ts` defines the shared `runtime.start` waterfall plus `runtime.starting`, `runtime.started` and `runtime.start.failed` observations.

The NOOA runner client is the first production consumer. With no plugin interceptors mounted, the waterfall is behaviorally transparent and calls the existing runner client exactly as before. A future policy, telemetry or routing plugin can wrap the same start operation without importing NOOA-specific code.

Codex and future runtimes should converge on the same seam as their integration is touched; the kernel must not force a flag-day migration of provider clients.

## 3. Tool runtime

`AgentToolRegistry` makes tool execution a first-class capability instead of provider-specific glue.

Each tool declares:

- a stable name and description;
- an input parser and output parser;
- an execution function;
- optional cooperative timeout metadata;
- `parallel` or `exclusive` scheduling metadata.

The parser contract is only `parse(unknown)`, so Zod, Valibot or a custom validator can be used without coupling the kernel to one schema library.

Guards run before execution and are monotonic: they may allow or deny a call, but a later tool implementation cannot override a denial. The registry validates output after execution and returns typed error classes for unknown tools, invalid arguments, denied calls, invalid output, cancellation and timeout.

A timeout aborts the signal handed to the tool. Same-process code cannot be hard-killed, so tools that opt into a timeout must cooperate with `AbortSignal` and settle after cancellation.

## 4. Event-sourced session surface

`AgentSessionLog` is an append-only typed event log. Model-visible history is derived from that log rather than maintained as a second mutable transcript.

Surface events are:

- `user.message`;
- `assistant.message`;
- `tool.result`.

Other durable facts include turn/step boundaries, request snapshots, tool calls and compaction records.

Context replacement is also append-only. A checkpoint appends a new surface event with a `replace` operation naming a contiguous visible range. The event records the exact sequences it shadows, and replay rejects incomplete provenance. Old events remain available for audit, reconstruction and evidence.

`repairInterruptedTail()` closes a persisted open turn with an explicit `interrupted` reason instead of deleting the partial history.

## 5. Context compaction

`AgentContextCompactor` is deliberately provider-neutral. It receives two injected functions:

- a token estimator;
- a summarizer.

When the current derived surface exceeds a configured threshold, it selects an old prefix while retaining a bounded recent tail, asks the summarizer for a checkpoint, and estimates the hypothetical post-compaction surface before committing anything. A checkpoint is rejected if it does not reduce estimated context.

A successful compaction appends:

1. one model-visible checkpoint that replaces the selected surface range; and
2. one log-only `context.compaction` record containing source sequences and before/after token estimates.

This creates the provenance needed for later persistence, replay and evaluation without assuming a specific model tokenizer today.

## Core capabilities

The default runtime kernel currently provides:

```text
agent.tools                -> AgentToolRegistry
agent.session-log-factory  -> creates AgentSessionLog instances
```

Additional capabilities should be introduced only when a real consumer exists. Examples that fit this seam are model adapters, persistence backends, approval policy, sandbox policy, subagent providers and context estimators.

## Security invariants

The kernel must preserve these existing Nodes boundaries:

- browser input never resolves arbitrary host filesystem paths;
- plugins do not bypass OpenShell, trusted-runner or Tycho isolation;
- a tool policy denial is fail-closed;
- runtime credentials stay outside candidate sandboxes and Kubernetes workloads;
- model-visible checkpoints retain exact source-event provenance;
- learned M1–M8 components may choose actions, but empirical execution/evidence remains the promotion authority.

## Migration strategy

This change is a foundation, not a rewrite of the existing runtimes.

1. Keep Codex/NOOA adapters and canonical Canvas events stable.
2. Route provider lifecycle operations through kernel waterfalls when those clients are touched.
3. Persist the kernel session log behind a repository interface before treating it as crash-recoverable production state.
4. Move reusable tool policy and capability registration out of provider-specific code incrementally.
5. Add tokenizer/provider-specific context estimators and summarizers as plugins rather than hard-coding them into the log.

The Project Map, Arena, Tycho and M1–M8 remain above this layer. The kernel exists to make the execution substrate more replaceable; it does not replace Nodes' decision and learning model.
