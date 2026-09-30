# ADR-09: World Model for Prediction, Never for Scoring

- Status: accepted
- Date: 2026-05-02

## Context

Agents recover faster when they can predict the next screen; but scoring a
model against its own predictions is circular.

## Decision

Ship a `world-lstm` predictor that proposes expected post-action state
(recorded as `prediction` on each `TraceStep`) to aid recovery and reviewer
understanding — while success, grounding, and recovery metrics are computed
exclusively from observed before/after screens and human judgments.

## Alternatives considered

- **No world model**: simpler, but agents re-plan from scratch after every
  misclick.
- **Prediction-based scoring**: cheaper evals, but Goodhart-bait.

## Consequences

- Positive: better recovery behavior without compromising metric integrity;
  prediction error itself becomes a diagnostic signal.
- Negative: an extra training target; predictions must be labeled as such in
  every surface so reviewers never mistake them for observations.
