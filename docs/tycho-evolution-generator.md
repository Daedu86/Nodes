# Codex-driven Tycho evolution

`runCodexTychoEvolution` is the server-side entry point for the local adaptive evolution loop.

The loop keeps generation, execution, evaluation, and persistence as separate contracts:

1. Codex receives the current parent candidate plus the previous winning evaluation.
2. Codex returns exactly the requested number of structured Tycho variants.
3. The Tycho execution backend evaluates each variant in its isolated candidate run.
4. The evolution loop selects the highest-scoring successful candidate.
5. The winner and its evaluation become the parent input for the next generation.
6. Session persistence records terminal generation evidence for Canvas inspection.

## Safety boundaries

The Codex generator uses an interactive runner invocation with no injected workspace files. Its prompt requires JSON-only hypothesis output and treats the parent spec/evaluation as untrusted data.

Hypothesis generation is fail-closed and execution-free. The generator cancels the run if Codex requests an approval or if the event stream reports tool execution, shell execution, file mutation, or child-agent spawning. Both started and completed tool/shell events are rejected so reconnect or stream timing cannot hide execution activity.

Generated candidate workspace paths must remain relative, cannot traverse parents, and cannot replace `.nodes/tycho-experiment.json`, which Nodes injects authoritatively for Tycho execution.

## Provenance

Every generated variant receives authoritative metadata containing `generator: "codex"` and the `generatorRunId`. The Tycho evaluator carries candidate metadata into evaluation evidence, so the existing evolution Session artifact persists who proposed a candidate separately from the Tycho run that evaluated it.

## Model selection

The current Codex runner start contract does not expose a per-run model field. The generator therefore uses the model configured by the local runner rather than storing or sending an unsupported model override.
