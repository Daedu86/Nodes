# Next priorities

This document keeps near-term product work focused on making Nodes easier to understand, evaluate and adopt before expanding the capability surface further.

## Priority 1 — Publish the public demo

**Outcome:** a first-time reviewer can understand the core Nodes workflow from a stable URL without local setup.

Use `docs/public-demo-checklist.md` as the release gate.

Success means a reviewer can complete:

```text
branch -> Canvas evidence -> Arena -> winner -> reusable project context
```

without requiring a live model response.

## Priority 2 — Finish first-run onboarding through promotion

Current onboarding should extend beyond the initial Chat/Canvas flow and demonstrate the complete product loop:

- create or inspect alternatives;
- preserve useful context;
- compare alternatives;
- select a winner;
- promote the decision;
- reuse the promoted context in later work.

The user should encounter the same mental model in onboarding, the seeded demo and the README.

## Priority 3 — Add reusable starter projects

Start with a small set of workflows that demonstrate why persistent decision state matters:

- product discovery;
- research synthesis;
- technical design;
- implementation planning;
- model/prompt evaluation.

Templates should emphasize decision structure rather than advanced runtime configuration.

## Priority 4 — Improve smaller-screen behavior

Validate the primary workflow on common laptop and tablet widths, especially:

- Project Map navigation;
- Canvas inspector/editor panels;
- Arena comparison;
- project header actions;
- long artifact content.

Performance and accessibility gates should remain intact.

## Priority 5 — Reduce operational noise

Keep generated diagnostics, workflow traces, temporary security verification files and local test outputs out of the repository tree.

Use GitHub Actions artifacts, logs or intentionally named evidence locations when operational evidence needs to be retained.

## Priority 6 — Improve release discipline

Before `1.0`, establish a lightweight release process:

- versioning rule;
- changelog or release-note convention;
- release readiness checklist;
- known limitations;
- migration notes when persistence contracts change.

## Defer unless evidence requires it

Do not expand the core product surface only because an additional agent, learning or infrastructure capability is technically possible.

M1–M8 already provide substantial technical depth. New capabilities should have a clear user problem, evaluation criterion and place in the decision workflow before becoming a product priority.
