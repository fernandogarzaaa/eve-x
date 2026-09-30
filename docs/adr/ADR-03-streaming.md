# ADR-03: Screenshot-First Streaming (VNC + PNG Frames)

- Status: accepted
- Date: 2026-03-21

## Context

The agent loop needs timely, complete screen state plus a channel for input
injection, without coupling the control plane to hypervisor internals.

## Decision

Stream guest frames as PNG screenshots over the VNC/agent socket with region
metadata attached by the detector; input actions travel the reverse path as
validated `ActionIR`. `GET /v1/vms/{vmId}/screen` is the polling fallback;
the worker pushes frames on change.

## Alternatives considered

- **Video-codec streaming (H.264)**: lower bandwidth but lossy artifacts
  shift grounding coordinates and poison training data.
- **Accessibility-tree only**: precise but misses canvas-rendered and custom
  UI that real users face.

## Consequences

- Positive: lossless coordinates, simple contract (`ComputerPercept`),
  screenshots double as training/review artifacts.
- Negative: higher bandwidth; mitigated by `maxWidth` downscaling on observe
  and change-triggered pushes.
