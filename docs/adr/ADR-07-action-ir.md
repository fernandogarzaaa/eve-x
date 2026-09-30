# ADR-07: Action IR as the Executable Contract

- Status: accepted
- Date: 2026-04-18

## Context

Models emit free text; hypervisors need discrete input events. An
unvalidated middle layer invites injection and off-target clicks.

## Decision

All execution flows through `ActionIR` (`packages/protocol`): a closed
`ActionType` enum, optional visual-region target, bounded text/keys/ms, and
mandatory confidence. The verifier grounds it; the policy gate authorizes
it; the hypervisor executes exactly one IR per `act` call.

## Alternatives considered

- **Raw coordinate emission**: no vocabulary, no confidence, no audit trail.
- **OS-level macro scripts**: expressive but ungroundable and unreviewable.

## Consequences

- Positive: every executed action is typed, bounded, grounded, and logged
  with its verification reason; datasets and benchmarks share the vocabulary.
- Negative: novel interactions must extend the enum (a deliberate, reviewable
  choke point).
