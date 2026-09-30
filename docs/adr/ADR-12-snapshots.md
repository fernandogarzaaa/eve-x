# ADR-12: Snapshot-Based Reproducibility (Clean-Room Starts)

- Status: accepted
- Date: 2026-05-23

## Context

Experience scores are meaningless if task N inherits cookies, files, or
crashed apps from task N−1.

## Decision

Every task boots (or restores) from a named clean snapshot; seeds fix the
persona, goal sampling, and model RNG (`prng`, `tests/determinism.test.ts`).
Overlays capture the delta per session and are retained until the session's
retention window closes.

## Alternatives considered

- **Fresh full-image clone per task**: purest, but minutes per start at
  fleet scale.
- **Shared long-lived desktops**: fastest, but cross-task contamination
  invalidates comparisons.

## Consequences

- Positive: same seed + same snapshot = same starting state, making studies
  reproducible and regressions attributable.
- Negative: snapshot storage grows with task diversity; retention policy in
  `OPERATIONS.md` bounds it.
