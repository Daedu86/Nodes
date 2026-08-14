# Public demo checklist

The public demo should prove the core product loop with minimal operational risk and without depending on a live model response.

## Required before publishing

- [ ] Stable public URL.
- [ ] Controlled demo account or read-only demo experience.
- [ ] Seeded deterministic project available after sign-in.
- [ ] No production secrets or deployment-level model keys exposed to demo users.
- [ ] Demo records isolated from non-demo user data.
- [ ] Reset path documented and tested.
- [ ] Branching, Canvas, Arena and project-context reuse all visible in the seeded project.
- [ ] Responsive layout checked on common laptop widths.
- [ ] Keyboard navigation checked for the demo path.
- [ ] Error states do not expose stack traces, internal paths or credentials.

## Preferred public flow

```text
landing / sign-in
  -> [Demo] Nodes product launch
  -> branch alternatives
  -> Canvas evidence
  -> Arena comparison
  -> selected winner
  -> project memory / reusable context
```

The public demo should prioritize this workflow over advanced execution controls.

## Demo account constraints

A controlled demo identity should:

- have access only to seeded demo content;
- not have administrative permissions;
- not expose private runner workspaces;
- not receive reusable provider credentials;
- not be able to mutate other users' projects;
- be resettable when the environment is refreshed.

If a fully read-only experience is practical, prefer it for anonymous public evaluation.

## Validation after deployment

1. Open the public URL in a clean browser profile.
2. Complete sign-in or enter the read-only demo.
3. Open `[Demo] Nodes product launch`.
4. Follow `docs/product-demo.md` from start to finish.
5. Confirm that no live model call is required for the scripted product story.
6. Confirm there are no console errors in the main demo path.
7. Confirm the deployed commit matches the intended `main` head.
8. Confirm CI and CodeQL are green for that head.

## What the demo should communicate

Within the first minute, a reviewer should understand:

- why branching matters;
- why evidence should become durable project state;
- how Arena makes comparison explicit;
- how a selected result survives into later work.

Kubernetes, evolution, learned policy and model-based planning are optional depth for a later technical discussion, not prerequisites for understanding the product.