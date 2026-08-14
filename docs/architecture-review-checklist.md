# Architecture review checklist

Use this checklist for changes that affect runtime, persistence, orchestration or trust boundaries.

## Boundaries

- [ ] Browser responsibilities remain distinct from trusted execution responsibilities.
- [ ] Workspace resolution stays server/runner authoritative.
- [ ] Credentials do not move into project/session/browser persistence unnecessarily.
- [ ] Kubernetes or other schedulers remain the authority for workloads they execute.

## Provenance

- [ ] Inputs are identifiable.
- [ ] Outputs are attributable to a session/run/workload.
- [ ] Evidence survives promotion or recovery where required.
- [ ] Learned or generated decisions do not silently bypass the evidence gate.

## Recovery

- [ ] Durable state is committed before terminal success is considered authoritative when required.
- [ ] Interrupted long-running operations have a documented recovery policy.
- [ ] Conflicting or ambiguous recovery inputs fail closed when security or provenance depends on uniqueness.

## Compatibility

- [ ] Persistence schema changes include compatibility or migration behavior.
- [ ] Existing demos/tests/CLI contracts are updated when public behavior changes.
- [ ] Versioned output remains versioned when consumed outside the immediate implementation.

## Verification

- [ ] Unit/contract tests cover the new boundary.
- [ ] E2E coverage exists when behavior crosses major system layers.
- [ ] Security analysis is appropriate to the changed attack surface.
- [ ] Performance budgets are considered for Canvas or high-volume paths.
- [ ] Live runtime acceptance is performed when mocks cannot prove the behavior.
