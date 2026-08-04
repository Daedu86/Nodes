# Design QA

- Source visual truth: browser-comment screenshot supplied in the task; supporting normalized capture at `C:\Users\daedu\Documents\Codex\2026-08-04\browser-comments-user-comment-1-file\work\qa-evidence\source-before-normalized.png`.
- Implementation screenshots: `C:\Users\daedu\Documents\Codex\2026-08-04\browser-comments-user-comment-1-file\work\qa-evidence\clean-new-session.png` and `C:\Users\daedu\Documents\Codex\2026-08-04\browser-comments-user-comment-1-file\work\qa-evidence\optional-conversation-root.png`.
- Combined full-view comparison: `C:\Users\daedu\Documents\Codex\2026-08-04\browser-comments-user-comment-1-file\work\qa-evidence\conversation-root-comparison.png`.
- Viewport: source 1661 x 1290 CSS pixels; implementation 1329 x 1032 CSS pixels; desktop split workspace at 1x density.
- Pixels and normalization: source 1661 x 1290; each implementation capture 1329 x 1032. The combined comparison scales all three captures to a common 760-pixel content height. The layout remains proportionally equivalent; the source and implementation intentionally use different retained theme preferences.
- State: source shows the previous empty session with a default root and stage-level Add agent button. Implementation evidence shows (1) a clean new session and (2) the optional root after adding it from the block rail.

## Findings

- No actionable P0, P1, or P2 differences remain in the scoped changes. The clean canvas preserves the existing split-workspace composition, and the optional root uses the existing root card without visual drift.
- Fonts and typography: application font family, hierarchy, wrapping, and control weights are unchanged. Root labels retain the existing optical scale.
- Spacing and layout rhythm: removing the default node leaves the stage clean without changing rail width, canvas padding, minimap placement, or zoom controls. The added root follows existing node dimensions and spacing.
- Colors and visual tokens: both additions reuse existing semantic border, background, accent, and focus tokens. Theme differences in the comparison are retained user preference, not implementation drift.
- Image quality and assets: no raster or generated assets were introduced. Both new rail actions use the repository's existing icon library.
- Copy and content: `Conversation Root` is clearly presented as an optional starting point in its accessible rail description. The Codex-agent hover help remains brief and action-oriented.

## Focused Region Evidence

No separate crop was needed because the combined comparison keeps the rail and root card readable. Browser snapshots additionally confirmed the accessible names `Add Codex agent to canvas` and `Add Conversation Root block. Optional starting point for a conversation tree.`

## Interaction Checks

- Creating a new session produced zero `__ROOT__` canvas nodes.
- Clicking Add Conversation Root produced exactly one `__ROOT__` node.
- Creating another session again produced zero roots, confirming session-scoped behavior.
- The first rail control remains Add Codex agent; its tooltip copy is covered by the focused component test and the prior browser hover evidence.

## Comparison History

- First annotation: moving Add Codex agent to the rail and adding hover help introduced no P0/P1/P2 mismatch.
- Second annotation: the first comparison showed the intended state change—default root removed from empty sessions and restored only through the rail—with no visual regression requiring another fix iteration.

## Open Questions

- None.

## Implementation Checklist

- [x] Start every new session with a clean canvas.
- [x] Add Conversation Root to the block rail.
- [x] Keep real conversation trees rooted when messages exist.
- [x] Persist an optional manually added root per session.
- [x] Preserve the Codex-agent rail action and hover description.

## Follow-up Polish

- None required for these annotations.

final result: passed
