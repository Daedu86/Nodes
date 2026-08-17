# Nodes product roadmap

Nodes is evolving toward a stable AI decision workspace for teams that need to explore alternatives, preserve evidence, compare outcomes, and carry decisions into future work.

This roadmap communicates direction, not delivery guarantees. Priorities may change based on product evidence, security requirements, operating cost, and contributor capacity.

## Product principles

1. **Exploration should remain reversible.** Branching must preserve alternatives instead of overwriting them.
2. **Context should be visible and reusable.** Important evidence, plans, drafts, and decisions belong on Canvas rather than in scrollback.
3. **Comparison should be explicit.** Arena should make trade-offs and winner selection understandable.
4. **Decisions should survive the conversation.** Project memory and Context Builder should carry outcomes into later sessions.
5. **Cloud features must fail safely.** Authentication, ownership, credentials, quotas, and persistence are enforced server-side.

## Available today

- [x] Branching conversations from user and assistant messages.
- [x] Persistent Canvas with text, code, image, file, and prompt artifacts.
- [x] Context and output links between messages and artifacts.
- [x] Branch and session comparison in Arena.
- [x] Projects, project memory, and Context Builder.
- [x] Secure project invitations with owner, editor, and viewer roles.
- [x] Per-user OpenRouter credentials with production encryption support.
- [x] Local file persistence and Supabase cloud persistence.
- [x] Unit, coverage, E2E, accessibility, security, bundle, and Canvas performance gates in CI.
- [x] Per-user first-run workspace guide for the primary Chat and Canvas workflow.
- [x] Reproducible seeded product demo for presentations and evaluations.
- [x] Provider-neutral durable agent status, metrics, compaction, resume, and fork across Codex and NOOA.
- [x] Append-only experiment records with Champion/Challenger lineage and Tycho evaluation provenance.
- [x] Arena experiment projection with explicit quality, cost, latency, token, and promotion evidence.
- [x] Arena A/B launch controls that fork a terminal durable parent, preserve a control candidate, and start challengers through the existing Codex/NOOA runtime authorities.
- [x] Durable Arena candidate lifecycle reconciliation for queued, running, approval, completed, failed, and cancelled states, including journal IDs, latency, and token evidence.
- [x] Evidence-gated Arena promotion controls that require complete terminal Tycho, cost, and latency evidence.
- [x] Arena cancellation controls that propagate to Codex/NOOA and append the cancelled experiment state.
- [x] Serialized project attachment reconciliation that prevents stale additive `memoryIds` patches from dropping already-confirmed typed nodes.
- [x] Monotonic scoped agent policy resolution across global, project, agent, and execution scopes.

## Now — product readiness

The current focus is making the product understandable, reliable, and evaluable by people who did not build it.

- [x] Public product narrative, screenshots, architecture overview, and 60-second demo guide.
- [x] One-command local demo workspace.
- [x] Public contribution, security, issue, and pull-request templates.
- [x] Add per-user first-run onboarding for question → Canvas → structured context.
- [x] Add automated axe, focus-trap, focus-restoration, and inert-panel checks in Chromium and Firefox.
- [x] Add reusable starter projects for product discovery, research synthesis, technical design, and writing.
- [ ] Verify and publish a stable public demo URL with a controlled demo account or read-only experience.
- [ ] Extend onboarding through Arena winner selection and project memory reuse.
- [x] Bind durable experiment evidence into interactive Arena launch, cancellation, lifecycle, and promotion controls.
- [ ] Add persisted retry configuration so a planned or failed Arena candidate can be relaunched after a browser/server restart without reconstructing its start form.
- [ ] Complete manual keyboard and screen-reader review for Arena and project flows.
- [ ] Improve responsive behavior for smaller laptop and tablet layouts.

## Next — team workflow

- [ ] Activity history for important project changes and promoted memory.
- [ ] Comments or review notes attached to branches, artifacts, and Arena comparisons.
- [ ] Import and export for portable sessions and projects.
- [ ] Project templates and organization-level defaults beyond the built-in starter maps.
- [ ] Better model-cost and quota visibility before and after a run in the product UI.
- [ ] Administrative controls for plans, usage, providers, and support workflows.
- [ ] More detailed recovery flows for conflicting edits and interrupted model runs.

## Later — platform capabilities

- [ ] Real-time multi-user collaboration where the operating cost and conflict model are justified.
- [ ] Public API and scoped automation tokens for project and session workflows.
- [ ] Extensible artifact types and workflow integrations.
- [ ] Evaluation datasets for comparing models and prompt strategies inside Arena.
- [ ] Optional organization knowledge sources with explicit permissions and provenance.
- [ ] Deployment profiles beyond the current Vercel and Supabase reference architecture.
- [ ] Provider-native continuation tokens where runtime semantics can be verified against Nodes' durable replay boundary.

## What is intentionally not promised

Nodes does not currently claim:

- fully synchronous real-time editing;
- guaranteed compatibility with every model provider;
- unlimited hosted inference funded by the deployment owner;
- a stable `1.0` data format;
- autonomous agents operating without explicit permissions and quotas;
- provider-native thread resumption when only Nodes-owned durable replay is available.

## How priorities are chosen

A roadmap item moves forward when it improves at least one of these outcomes without materially weakening another:

- time to understand the product;
- quality and traceability of decisions;
- reuse of context across sessions;
- collaboration safety;
- reliability and recoverability;
- deployment and operating simplicity;
- measurable user demand.

Feature requests should explain the user problem, current workaround, expected outcome, and why the capability belongs in Nodes. Use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml) to propose an item.
