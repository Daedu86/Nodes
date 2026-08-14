# Known limitations

Nodes is under active development toward a stable `1.0`. The following limitations are intentional or currently unresolved and should be considered when evaluating or deploying the project.

## Product experience

- The stable public demo URL is not yet treated as a completed release surface.
- First-run onboarding does not yet cover the full Arena winner-selection and project-memory reuse loop.
- Smaller laptop and tablet layouts still need broader manual review.
- Manual keyboard and screen-reader review remains useful beyond automated accessibility gates.

## Collaboration

- Fully synchronous real-time collaborative editing is not guaranteed.
- Conflict and recovery flows can be improved for concurrent edits and interrupted model runs.
- Organization-level defaults and broader administrative controls are not yet a stable product surface.

## Models and providers

- Compatibility with every model provider is not guaranteed.
- Hosted inference may require user-provided provider credentials depending on deployment configuration.
- Model cost and quota visibility can be improved before and after runs.

## Execution

- Trusted local or cluster execution is intentionally separate from the browser deployment.
- Runner-dependent workflows require the runner environment to be configured and reachable.
- Kubernetes execution is an optional capability and is not required for the core product workflow.
- Advanced M1–M8 capabilities should not be interpreted as mandatory stages for every project.

## Persistence and compatibility

- The project has not declared a stable `1.0` persistence/data-format guarantee.
- Persistence-contract changes may still require compatibility or migration work before `1.0`.

## Product scope

Nodes does not claim autonomous agents can operate without explicit permissions, quotas or trusted execution boundaries. Learned or planning components may influence what to try, but empirical evidence and explicit promotion remain the authoritative decision boundary.
