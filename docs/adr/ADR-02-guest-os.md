# ADR-02: Ubuntu Desktop as the Guest OS

- Status: accepted
- Date: 2026-03-14

## Context

Benchmarks need a desktop that is familiar to models (training exposure),
scriptable for task setup, and buildable from pinned cloud images.

## Decision

Standardize on Ubuntu Desktop (minimal seed over the Jammy cloud base),
`en-US`/UTC, 1920×1080, with the `eveagent` account and `/opt/eve-agent`
provisioned by cloud-init (`infra/vm-images/build.sh`).

## Alternatives considered

- **Windows guests**: broader app coverage but licensing friction and
  non-reproducible base images.
- **Minimal Wayland compositors**: fast, but alien to both models and human
  reviewers, invalidating experience scores.

## Consequences

- Positive: pinned base URL + recorded sha256 makes images reproducible;
  desktop behavior matches reviewer expectations.
- Negative: Ubuntu-only coverage; new OS families require a new image line
  and a compat-tracked benchmark variant.
