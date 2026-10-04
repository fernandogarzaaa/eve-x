# ADR-05: Postgres + Object Storage Split

- Status: accepted (concrete backend superseded by ADR-14: Garage v2, not MinIO)
- Date: 2026-04-02

## Context

Relational state (VMs, tasks, trace steps, judgments) and blobs
(screenshots, weights, exports) have opposite access patterns.

## Decision

Postgres owns structured, queryable state; S3-compatible object storage
(MinIO locally) owns immutable blobs referenced by URI + sha256. The model
registry mirrors this: JSON records on the filesystem index, weight blobs
beside them, optional bucket replication over plain fetch.

## Alternatives considered

- **Everything in Postgres**: bytea/toast bloat, painful retention, slow
  exports.
- **Everything in objects**: no joins across sessions/steps, weak
  transactional appends for the trace ledger.

## Consequences

- Positive: cheap retention policies per bucket, digest-verified blobs,
  SQL analytics over traces.
- Negative: two systems to back up; mitigated by nightly dumps + versioned
  buckets (see `OPERATIONS.md`).
