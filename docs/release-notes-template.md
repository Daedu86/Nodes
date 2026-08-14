# Release notes template

## Summary

One or two sentences describing the user-visible outcome of the release.

## What changed

- User-facing capability or workflow improvement.
- Reliability, security or performance improvement that materially affects use.
- Important developer or deployment change.

## Why it matters

Explain the problem addressed and the expected effect on the Nodes decision workflow.

## Validation

- Main CI: PASS / FAIL
- CodeQL: PASS / FAIL
- Production build: PASS / FAIL
- E2E: PASS / FAIL
- Accessibility: PASS / FAIL
- Dependency audit: PASS / FAIL
- Performance budget: PASS / FAIL
- Additional runtime or deployment acceptance: describe if applicable

## Migration / operations

State any required environment, persistence, runner, deployment or migration action. Write `None` when no action is required.

## Known limitations

List release-specific limitations or link to `docs/known-limitations.md`.
