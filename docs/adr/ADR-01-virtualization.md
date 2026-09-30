# ADR-01: Full Virtualization (QEMU/KVM) for Guest Isolation

- Status: accepted
- Date: 2026-03-14

## Context

Evaluated agents run untrusted policies that click, type, and execute code
inside a desktop. We needed isolation strong enough to treat the agent as
hostile without losing the fidelity of a real OS.

## Decision

Run every evaluation guest as a full QEMU/KVM virtual machine from qcow2
snapshots, one VM per session, managed through the audited state machine in
`packages/core` (`VM_TRANSITIONS`).

## Alternatives considered

- **Containers + virtual display**: lighter, but shares the host kernel and
  leaks host behavior (fonts, window chrome) into screenshots.
- **Remote-desktop farms**: real fidelity, but snapshots/forks are slow and
  the fleet is not reproducible from a build script.

## Consequences

- Positive: hardware-grade isolation, instant clean-room starts via snapshot
  restore, forkable branches for replay, reproducible images with recorded
  digests (`infra/vm-images/build.sh`).
- Negative: heavier per-session cost (GBs of disk, seconds to boot);
  mitigated by overlay chains and snapshot reuse.
