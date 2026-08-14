# Decision workflow

This document defines the canonical product workflow that new features should support rather than obscure.

```text
Explore -> Preserve -> Compare -> Promote -> Reuse
```

## Explore

Create alternative reasoning or workload paths without destroying the current direction.

Expected product behaviors:

- branch from existing context;
- keep alternatives attached to the same project decision;
- preserve upstream inputs and provenance;
- avoid forcing users to duplicate context into disconnected chats.

## Preserve

Turn important intermediate work into durable project state.

Examples:

- evidence;
- decisions;
- plans;
- code;
- files;
- images;
- prompts;
- experiment results.

Preserved state should remain understandable outside the immediate transcript where practical.

## Compare

Make competing outcomes inspectable side by side.

Comparison should help users understand:

- what differs;
- what evidence supports each direction;
- what trade-offs matter;
- whether one result should be promoted.

## Promote

Record the selected outcome explicitly.

Promotion is a product boundary: a candidate, branch or experiment result is not equivalent to an accepted project decision merely because it was generated successfully.

## Reuse

Carry selected context into later sessions and downstream workloads while retaining enough provenance to understand where it came from.

Reuse should reduce manual transcript reconstruction and context copying.

## Feature test

A new feature belongs in the core Nodes product when it materially improves at least one stage of this workflow without weakening provenance, permissions, reliability or clarity.

Advanced runtime, agent, learning and planning capabilities are supporting systems. They are valuable when they generate or evaluate better alternatives for this workflow; they are not a replacement for the workflow itself.
