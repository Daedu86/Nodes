# Contribution scope

Nodes welcomes contributions that improve the decision workflow, reliability, security, usability or maintainability of the project.

## Strong contribution candidates

- Clear fixes for bugs in Branching, Canvas, Arena, Project Map or project-context reuse.
- Accessibility, responsiveness and performance improvements.
- Reliability and recovery improvements with regression coverage.
- Security hardening that preserves product behavior.
- Documentation that makes existing behavior easier to understand or evaluate.
- Starter projects that demonstrate a reusable decision workflow.
- Execution/runtime changes with explicit provenance and trust boundaries.

## Contributions that need a stronger product case

Large new agent, learning, infrastructure or orchestration capabilities should explain:

1. the user problem;
2. the current workaround;
3. which stage of Explore -> Preserve -> Compare -> Promote -> Reuse improves;
4. how success will be evaluated;
5. how provenance, permissions and recovery remain trustworthy.

Technical novelty by itself is not sufficient reason to expand the core product surface.

## Keep experiments distinguishable from product

Experimental work is useful, but it should not make the stable product contract harder to understand. Prefer clear boundaries between:

- core product behavior;
- optional advanced capabilities;
- one-off validation or benchmark artifacts;
- temporary diagnostics.

Generated test outputs, workflow traces and temporary security diagnostics should remain outside the committed repository tree unless they are intentionally curated evidence.
