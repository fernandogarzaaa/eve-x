# ADR-08: Explicit Grounding Layer with Confidence Gates

- Status: accepted
- Date: 2026-04-25

## Context

The dominant failure mode in computer use is confident clicks on the wrong
(or nonexistent) control. End-to-end training hides this inside one loss.

## Decision

Separate grounding into its own head and gate: region proposals carry
`{regionId, bbox, label, confidence}`; the verifier requires region
existence, in-frame bbox, and confidence ≥ 0.5 before execution. Training
(`train.py` grounding phase + verifier gate) and eval (`eval.py` IoU-based
grounding accuracy) both measure it independently of task success.

## Alternatives considered

- **Implicit grounding**: fewer moving parts, but failures are undebuggable
  and unfilterable in datasets.
- **Human-in-the-loop per click**: safe, but destroys study throughput.

## Consequences

- Positive: grounding regressions are caught before they become task
  failures; unverified steps are excluded from training data.
- Negative: a second model surface to calibrate; low-confidence steps need
  reviewer attention by design.
