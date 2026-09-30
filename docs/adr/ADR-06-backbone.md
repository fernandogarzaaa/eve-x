# ADR-06: Backbone Strategy (Small Grounded Models + Verifier)

- Status: accepted
- Date: 2026-04-11

## Context

Frontier VLMs are strong but expensive, slow, and opaque about spatial
grounding — the exact skill computer use demands.

## Decision

Train a family of small task-specific backbones (`cua-small`/`base`/`large`
for action policy, `vit-ground` for region grounding, `verifier-xgb` for
verification, `world-lstm` for state prediction) behind a verifier gate,
with frontier models used only as data generators and judges.

## Alternatives considered

- **Frontier-only**: best zero-shot quality, but per-step cost and latency
  break population studies, and grounding is uncalibrated.
- **Single multitask giant**: simpler serving, but grounding regressions hide
  inside aggregate loss.

## Consequences

- Positive: cheap seeded studies, calibrated confidences, separable
  integrity/performance scoring.
- Negative: we own the training pipeline (`ml/training`, `ml/datasets`) and
  its data flywheel.
