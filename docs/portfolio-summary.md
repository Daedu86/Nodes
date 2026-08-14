# Nodes — portfolio summary

## One-line description

**Nodes is a visual AI decision workspace that keeps alternative reasoning paths, evidence, explicit comparisons and promoted outcomes connected across a project.**

## What the project demonstrates

Nodes is designed and implemented as more than a chat UI. The repository demonstrates work across product architecture, full-stack application development, AI orchestration, trusted execution boundaries, persistence, security, testing and deployment.

### Product and UX

- Branching conversations that preserve alternative paths.
- Persistent Canvas artifacts for evidence, decisions, plans, code, files, images and prompts.
- Arena comparison with explicit winner promotion.
- Project memory and Context Builder for reuse across sessions.
- Structured Project Map workload DAGs.
- Seeded deterministic product demo and onboarding flows.

### Application architecture

- Next.js and React application with TypeScript.
- Repository abstractions supporting local file persistence and Supabase Postgres/Storage.
- Server-side authorization and project collaboration roles.
- Browser/control-plane separation from trusted execution runtimes.
- Read-only CLI over project, session, runner and Tycho state.

### AI and execution systems

- Hosted model integration.
- Trusted Codex runner with server-authoritative workspace selection.
- Tycho isolated experiment/evidence harness.
- Durable adaptive evolution with lineage and deterministic promotion.
- Optional Kubernetes candidate execution and read-only kagent diagnostics.
- Learned policy, hierarchical multi-agent, skill-learning, curriculum, predictive world-model and planning capabilities.

### Reliability and security

- Unit and coverage gates.
- Critical-module coverage.
- Playwright end-to-end tests.
- Chromium and Firefox accessibility checks.
- Production bundle budgets and Canvas performance budgets.
- Dependency vulnerability audits.
- CodeQL analysis.
- Fail-closed runtime and recovery boundaries in security-sensitive paths.

## Architecture in one paragraph

The browser acts as the product control plane. Projects are organized through a canonical workload DAG whose nodes own sessions, authorized inputs, evidence and selected outputs. Hosted inference may run through the web tier, while trusted local or cluster execution remains outside the browser boundary. Empirical execution returns structured evidence, and promotion remains an explicit, deterministic project decision.

## Useful entry points

- `README.md` — product overview.
- `docs/evaluation-guide.md` — five-minute evaluation route.
- `docs/product-demo.md` — deterministic 60-second demo.
- `docs/product-thesis.md` — product thesis and boundaries.
- `docs/system-architecture.md` — whole-system architecture.
- `ROADMAP.md` — current product direction.

## Suggested portfolio framing

A concise way to present the project:

> I built Nodes to solve a limitation I kept seeing in AI workflows: good alternatives and evidence disappear into linear chat history. Nodes turns that work into persistent project state. It supports branching, structured evidence, explicit comparison and promotion, then carries the selected result into later sessions and workloads. Underneath, it separates the browser control plane from trusted execution and adds strong CI, security and experiment-provenance boundaries.

For a deeper technical discussion, the most distinctive areas are the workload DAG, evidence/promotion model, trusted runner boundary, durable evolution protocol and testing/security gates.