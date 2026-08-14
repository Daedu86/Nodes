# Product review checklist

Use this checklist before adding a major product capability.

## Problem

- [ ] The user problem is concrete and observable.
- [ ] The current workaround is understood.
- [ ] The feature improves Explore, Preserve, Compare, Promote or Reuse.

## Scope

- [ ] The simplest useful version is defined.
- [ ] Advanced runtime/infrastructure concerns are separated from the user-facing workflow where possible.
- [ ] The feature does not require users to understand M1–M8 unless that capability is itself the task.

## Evidence

- [ ] Success can be evaluated with a test, demo, metric or reproducible workflow.
- [ ] Generated outputs retain sufficient provenance.
- [ ] Promotion or acceptance is explicit when the feature produces alternatives.

## Safety and reliability

- [ ] Authorization is enforced server-side.
- [ ] Browser input does not become arbitrary credential, filesystem or scheduling authority.
- [ ] Failure and recovery states are understandable.
- [ ] CI coverage is appropriate for the risk introduced.

## Product clarity

- [ ] The README product thesis remains accurate after the change.
- [ ] The seeded demo remains focused on the canonical decision workflow.
- [ ] The new capability does not make the first-run experience materially harder to understand.

If several boxes cannot be checked, keep the capability experimental until its role in the product is clearer.
