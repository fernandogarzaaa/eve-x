# HUMAN_VALIDATION

Automated scores decide nothing alone: every release candidate passes through
blinded human review, and live sessions can escalate to a human operator.

## Blinded review protocol

1. The worker samples steps/sessions from the candidate model's population
   study, stripping model ids and ordering randomly.
2. Reviewers score each step on five booleans (`protocol` `HumanJudgment`):
   `reasonable`, `targetCorrect`, `understandable`, `expected`, `recoveryOk`,
   plus optional free-text correction.
3. `blind: true` is the default; unblinding requires an operator note in the
   audit log.
4. Inter-reviewer agreement is tracked; persistent disagreement on a task
   family quarantines that family from promotion evidence until resolved.

## Takeover

- `POST /v1/sessions/{sessionId}/takeover` with `{stepId, reason}` (MCP tool
  `human.takeover`) pauses the agent and pages an operator.
- Approval-gated categories (`destructive`, `purchase`, `data-export` by
  default) escalate automatically instead of executing.
- Takeover sessions record `human_intervention: true` on subsequent steps so
  the dataset pipeline can treat them as supervised corrections rather than
  autonomous behavior.

## Reviewer guidance

- Judge what a competent first-time user would expect, not what the fastest
  expert would do.
- `recoveryOk` matters as much as success: an agent that notices a misclick
  and repairs it outranks one that succeeds by luck.
- Never copy secrets visible in screenshots into notes; reference step ids.

## From judgments to gates

Aggregated judgments feed the genesis panel alongside benchmark numbers:
integrity (was the behavior understandable and correctly targeted?) is scored
separately from performance (did it finish fast?). See `BENCHMARKS.md` and
`tests/genesis.test.ts`.
