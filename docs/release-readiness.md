# Release readiness

Use this checklist for milestone releases on the path to `1.0`.

## Product

- [ ] The release has a clear user-facing outcome.
- [ ] The README and evaluation guide still describe the product accurately.
- [ ] The seeded demo exercises the primary workflow successfully.
- [ ] Known limitations are documented.

## Quality

- [ ] Main CI is green.
- [ ] CodeQL is green.
- [ ] Production build and bundle budget pass.
- [ ] Unit and critical coverage gates pass.
- [ ] Playwright E2E passes.
- [ ] Accessibility checks pass.
- [ ] Canvas performance budget passes.
- [ ] Dependency audits pass.

## Security and boundaries

- [ ] No credentials, local auth files, host paths or temporary diagnostics are committed.
- [ ] Browser requests do not gain new filesystem or scheduling authority.
- [ ] New privileged actions are permission-checked server-side.
- [ ] Failure and recovery behavior is explicit for new long-running operations.

## Persistence and compatibility

- [ ] Persistence-contract changes have migration or compatibility notes.
- [ ] Existing seeded/demo data remains usable or has a reset path.
- [ ] Import/export or stored artifacts are versioned where required.

## Deployment

- [ ] The intended commit is deployed.
- [ ] Environment configuration is documented.
- [ ] Public demo restrictions remain intact when applicable.
- [ ] A clean-browser smoke test passes against the deployed URL.

## Release notes

Release notes should state:

1. what changed for users;
2. why it matters;
3. any migration or operational action required;
4. known limitations;
5. the validation performed.

Avoid treating infrastructure detail as the primary release story unless that infrastructure change produces a user-visible capability or reliability improvement.