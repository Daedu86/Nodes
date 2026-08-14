# Product thesis

## The problem

AI conversations are good at generating options but weak at preserving the structure of a decision over time.

As work becomes more complex, teams often spread alternatives across chats, copy important outputs into external documents, lose the evidence behind a choice, and manually rebuild context for the next task. The final answer may survive, but the path, competing alternatives, evidence and promotion decision usually do not.

## The thesis

**AI work should preserve decisions as structured project state, not only as chat history.**

Nodes treats exploration, evidence, comparison and promotion as explicit parts of the workflow:

```text
explore
  -> preserve
  -> compare
  -> promote
  -> reuse
```

A conversation is one source of project state, not the project itself.

## What makes Nodes different

### Branching preserves alternatives

A branch remains attached to the question and context it explores. Users do not need to restart the problem in a disconnected conversation simply to test another direction.

### Canvas preserves evidence

Plans, decisions, code, prompts, files, images and evidence can become durable artifacts instead of remaining buried inside message history.

### Arena makes promotion explicit

Competing branches or sessions can be compared and a winner selected deliberately. The selected result becomes an explicit project decision rather than an implicit preference remembered by one participant.

### Project context survives the conversation

Promoted outcomes can feed later sessions and downstream workloads. The system carries forward selected context instead of requiring users to reconstruct it from scrollback.

### Execution remains evidence-driven

Advanced execution capabilities can generate, test and learn from alternatives, but execution does not replace the promotion boundary. Empirical results and selected evidence remain authoritative.

## Product boundary

Nodes is not primarily:

- a generic whiteboard;
- a node-based prompt editor;
- a replacement shell for model-provider chat UIs;
- an autonomous agent that operates without explicit permissions and constraints;
- a Kubernetes dashboard;
- an RL research framework presented as an end-user workflow.

Those technologies can support Nodes, but the product remains the decision workspace and its reusable project state.

## Ideal use cases

Nodes is most useful when work has at least one of these properties:

- several plausible directions need to be explored;
- evidence must be preserved and traced;
- outcomes need explicit comparison;
- a selected result will influence later work;
- execution or experiments produce evidence that should feed a decision;
- multiple sessions or specialist agents contribute to one project outcome.

Examples include product discovery, research synthesis, technical design, implementation planning, model/prompt evaluation, experiment-driven optimization and complex writing or analysis.

## Design principles

1. **Exploration stays reversible.** Trying another direction should not destroy the current one.
2. **Important context becomes visible state.** Evidence and decisions should not depend on transcript archaeology.
3. **Promotion is explicit.** The system should distinguish an alternative from the selected outcome.
4. **Provenance survives reuse.** Downstream work should retain enough information to understand where selected context came from.
5. **Execution boundaries remain trustworthy.** Browser requests should not become arbitrary filesystem, credential or scheduling authority.
6. **Advanced automation serves the decision loop.** Agent, learning and planning capabilities extend the workflow rather than replacing its evidence gate.

## Success criterion

Nodes succeeds when a person can return to a project later and answer:

- What alternatives did we explore?
- What evidence mattered?
- What did we choose?
- Why did we choose it?
- What should downstream work inherit?

without reconstructing the answer from a collection of disconnected chat transcripts.