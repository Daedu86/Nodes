# Evaluate Nodes in 5 minutes

Nodes is an AI decision workspace for exploring alternatives, preserving evidence, comparing outcomes, and carrying selected results into later work.

This guide gives reviewers, recruiters, contributors, and evaluators the shortest path to understand the product without first learning the full execution architecture.

## 1. Understand the product loop

The core workflow is:

```text
question
  -> branch alternatives
  -> preserve evidence on Canvas
  -> compare in Arena
  -> select a winner
  -> promote the result into project context
  -> reuse it in later work
```

If that loop is clear, the rest of the system is easier to understand.

## 2. Run the seeded demo

```bash
npm ci
cp .env.example .env.local
npm run demo:seed
npm run dev
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Set a local development password in `.env.local`, sign in, and open:

```text
[Demo] Nodes product launch
```

The seeded workspace does not require a live model response for the main product walkthrough.

## 3. Inspect four product surfaces

### Branching

Open the seeded positioning session and inspect the alternative conversation paths. The important behavior is that alternatives remain attached to the same decision context instead of becoming isolated chats.

### Canvas

Open Canvas and inspect the evidence and decision artifacts. These are durable project objects rather than transcript-only context.

### Arena

Compare the seeded alternatives and inspect the explicit winner. Arena makes promotion a deliberate workflow step instead of an informal judgment hidden in chat history.

### Project context

Inspect project memory or Context Builder. The selected result should be reusable by later sessions and downstream workloads.

## 4. Then inspect the engineering depth

After the product loop is clear, review the deeper execution architecture:

- `docs/system-architecture.md` — whole-system boundaries;
- `docs/project-map-architecture.md` — workload DAG and project model;
- `docs/agent-runtime-architecture.md` — trusted execution boundary;
- `docs/nodes-cli.md` — read-only project/session/runtime diagnostics;
- M1–M8 documents — optional evolution, Kubernetes, learned policy, multi-agent, skill learning, curriculum, world-model and planning capabilities.

The browser is the control plane. Trusted runtimes own execution, and empirical evidence remains the promotion gate.

## 5. Validate repository quality

The repository CI includes:

- formatting/lint;
- application and E2E TypeScript checks;
- unit and coverage gates;
- critical-module coverage;
- production build and JavaScript bundle budget;
- Playwright E2E tests;
- Chromium and Firefox accessibility checks;
- dependency vulnerability audits;
- Canvas performance budgets;
- CodeQL security analysis.

## What to evaluate

A useful evaluation should answer four questions:

1. **Product clarity:** does Nodes make branching, comparison and decision reuse more explicit than a linear AI chat?
2. **Provenance:** can a reviewer trace important outputs back to the sessions, inputs and evidence that produced them?
3. **Execution boundaries:** are credentials, workspace resolution and runtime placement kept outside the browser boundary?
4. **Operational quality:** do CI, recovery, security and persistence choices support reliable use rather than only a visual prototype?

For a scripted product walkthrough, continue with `docs/product-demo.md`.