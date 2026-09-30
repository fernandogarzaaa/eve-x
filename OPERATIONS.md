# OPERATIONS

## Daily rhythm

- Check `/v1/health` on api + inference `/health`; confirm `/ready` is 200
  (unready means degraded heuristic mode — serving, but investigate).
- Review worker backlog (Redis queue depth) and VM fleet states; any VM in
  `FAILED` longer than 15 min gets destroyed and reprovisioned.
- Scan the governance audit log for 403/409 spikes — a burst of policy
  denials usually means a misconfigured task policy, not an attack.

## Runbooks

**Inference degraded (`/ready` 503, `/health` 200).**
Reload weights or restart the inference container; the plane keeps serving
with low-confidence heuristic actions meanwhile. No traffic shift needed.

**Queue full (429s on `/infer`).**
Scale inference replicas or lower population-study concurrency; the bounded
queue protects latency, so 429s are the signal working as designed.

**DB pressure.**
Trace reads are seq-paginated — cap `--limit`, add retention on screenshots
older than the configured window, and confirm `pgdata` volume growth.

**Stuck VM.**
`vm control <id> --op shutdown --reason …`; on 409, follow the legal edge
(e.g. `STOPPING` → `STOPPED`, then destroy). Never delete overlays by hand.

## Backups

- Postgres: nightly `pg_dump` to the object bucket, 30-day retention.
- Object bucket: versioned; registry `records/*.json` also committed to the
  release branch per promotion.
- Guest snapshots needed for forensics are exported before VM destroy.

## Access

Operators hold individual console accounts; the shared `EVEX_AUTH_TOKEN` is
for service-to-service calls and rotates on every personnel change and after
any incident. Skill installs are per-user and never grant capabilities.
