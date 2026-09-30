# ADR-11: Bearer Capabilities (Token + Capability Authz)

- Status: accepted
- Date: 2026-05-16

## Context

Service-to-service calls need authentication without a full identity
platform, and coarse "logged in" checks are insufficient for destructive
operations.

## Decision

Opaque bearer tokens authenticate; a capability enum authorizes. Every route
declares its required capability (`API.md` table); `admin` implies all;
denials return 403 with audit entries. Tested in `tests/authz.test.ts`.

## Alternatives considered

- **mTLS everywhere**: stronger, but heavy for local compose and skill
  authors.
- **Role-based (RBAC) roles**: simpler UX, but roles blur exactly the
  destructive-vs-read distinctions we must keep sharp.

## Consequences

- Positive: least-privilege tokens per component (worker, reviewer, skill);
  token rotation is a single env change.
- Negative: token theft inside the trust boundary is powerful; mitigated by
  loopback-only defaults, short-lived review tokens, and rotation runbooks.
