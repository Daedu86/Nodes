# Tycho evolution episodes

Evolution Sessions use an append-only episode model so a completed champion can seed later adaptive work without overwriting prior evidence.

## Continuation model

An initial episode starts from the Session's authoritative `.nodes/tycho-experiment.json` protocol. Later episodes start from the persisted global champion:

```text
Episode 1
  seed g0 -> g1 -> g2 -> champion g2
                         |
Episode 2               v
  seed g2 -> g3 -> g4 -> champion g4
                         |
Episode 3               v
  seed g4 -> g5 -> g6 -> champion g6
```

`runEvolutionLoop` accepts an optional `resumeFrom` value containing the exact persisted champion candidate plus its evaluation. A resume point must preserve the stable `gN:candidate-id` key. The next generation is always `parent.generation + 1`, and the previous champion score, metrics, and evidence are supplied to the variant generator before it proposes the first variants of the new episode.

## Persistence

`.nodes/evolution-session.json` now uses schema version 2. It stores:

- the original Session seed;
- an append-only `episodes[]` collection;
- a flat accumulated `generations[]` view for existing consumers;
- the current global champion;
- per-episode workspace ID, generation range, status, seed, champion, and failure reason;
- candidate generator metadata, Tycho run IDs, scores, metrics, evidence, and decisions.

Version 1 snapshots remain readable. They are normalized in memory as schema v2 with a single `episode-1`; fields that did not exist in v1, such as episode workspace ID and candidate metadata, are represented as `null`.

## Failure semantics

Episode persistence is fail-closed and append-only:

- a Session cannot start two episodes while its persisted status is `running`;
- a continuation requires an existing scored champion;
- a continuation cannot change the persisted project ID;
- Session optimistic-version checks prevent simultaneous episode starts from silently creating competing histories;
- if a new episode fails before producing a winner, the previous global champion remains authoritative;
- if the episode produces a newer winner and a later generation fails, the newest successfully evaluated winner remains the global champion while the episode is marked failed.

## Canvas control

The Evolution sheet switches automatically between `Start evolution` and `Continue from champion`. For continuation it shows the episode count, accumulated generation count, champion score, and next generation number. The latest persisted workspace ID is reused as the default runner target.

Interactive episodes remain capped at two generations so the request stays within the 300-second hosting envelope. Candidate executions themselves use the local Tycho runner, but the full episode orchestration is still tied to the initiating request. Moving episode orchestration to a durable resumable controller is a separate follow-up and should happen before relying on long-running or high-generation production evolution.
