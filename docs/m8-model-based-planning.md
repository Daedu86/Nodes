# M8 — Model-Based Planning / MPC

M8 is the final capability milestone in the M1–M8 architecture. It adds bounded long-horizon planning on top of the M7 predictive world model without replacing real Tycho evidence.

## Architecture

```text
M3 replay + M4 teams + M5 skills + M6 curriculum
                         ↓
                  M7 world model
          first-step reward / next-state / cost
                         ↓
                  M8 MPC planner
           empirical multi-step beam search
                         ↓
              rank candidate proposals
                         ↓
             execute first action only
                         ↓
                  Tycho / Kubernetes
                         ↓
                    REAL evidence
                         ↓
                      re-plan
```

M8 does not recursively generate imaginary code. After M7 predicts the first transition for a candidate, M8 rolls forward over empirical replay transitions `(state, action → reward, nextState)`.

## Receding-horizon invariant

M8 follows model-predictive control:

```text
plan up to N steps
→ execute one candidate for real
→ observe Tycho evidence
→ discard the remaining imagined path
→ plan again from the new state
```

A predicted path therefore never becomes execution authority.

## Planning objective

For each candidate, M8 estimates discounted long-horizon return with uncertainty penalty:

```text
R = r0 + gamma*r1 + gamma^2*r2 + ...
utility = normalized(R) - uncertaintyPenalty*(1-confidence)
```

Beam search is bounded by depth, branches and timeout. Planning stops early when model confidence falls below the configured threshold or no supported replay transition exists.

## Modes

```dotenv
TYCHO_PLANNER_MODE=off
```

Preserves M1–M7 behavior.

```dotenv
TYCHO_PLANNER_MODE=observe
```

Computes and records imagined plans while preserving M7 one-step candidate ranking.

```dotenv
TYCHO_PLANNER_MODE=online
```

Allows multi-step return to affect preselection. Tycho still evaluates every selected candidate before any next generation is planned.

## Safety and resource bounds

```dotenv
TYCHO_PLANNER_MAX_DEPTH=4
TYCHO_PLANNER_MAX_BRANCHES=12
TYCHO_PLANNER_GAMMA=0.85
TYCHO_PLANNER_MIN_CONFIDENCE=0.55
TYCHO_PLANNER_UNCERTAINTY_PENALTY=0.15
TYCHO_PLANNER_MIN_SUPPORT=3
TYCHO_PLANNER_TIMEOUT_MS=150
```

M8 cannot create Kubernetes Jobs, expand execution permissions, request credentials, bypass M2 isolation, or execute the second step of an imagined path. It only changes candidate ranking before the existing durable orchestrator executes the normal population budget.

## Metadata

Selected candidates retain both the M7 prediction and M8 plan:

```text
candidateMetadata.worldModelPrediction
candidateMetadata.modelBasedPlan
```

The plan records expected return, depth reached, confidence, uncertainty, stop reason and the empirical state/action path used for lookahead.

## Final milestone boundary

M1–M8 now cover:

1. durable evolution;
2. isolated distributed execution;
3. strategy learning;
4. team learning;
5. skill learning;
6. curriculum learning;
7. predictive world modeling;
8. model-based planning.

No M9 capability is implied by this document. Further architecture changes should be driven by measured limitations of the integrated M1–M8 system rather than extending the milestone sequence automatically.
