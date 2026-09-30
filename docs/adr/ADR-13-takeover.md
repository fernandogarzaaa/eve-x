# ADR-13: Human Takeover as a First-Class Primitive

- Status: accepted
- Date: 2026-05-30

## Context

Agents encounter destructive confirmations, purchases, logins, and
ambiguous states where autonomous action is unsafe or invalid for scoring.

## Decision

Takeover is a protocol-level primitive, not an afterthought: the
`human.takeover` MCP tool, `POST /v1/sessions/{id}/takeover`, the
`ask_human` action type, and `human_intervention` flags on trace steps.
Approval-listed policy categories escalate automatically; reviewers see
takeover context with model identity blinded.

## Alternatives considered

- **Auto-deny and abort**: safe but discards the session's evidence and
  teaches nothing about recovery.
- **Unrestricted autonomy with post-hoc review**: maximizes throughput while
  risking irreversible real-world effects.

## Consequences

- Positive: safety and evidence preserved together — supervised corrections
  become the highest-value training rows.
- Negative: reviewer staffing bounds study throughput; queueing and sampling
  policy must match.
