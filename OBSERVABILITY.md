# OBSERVABILITY

## Endpoints (verified against the release build)

- `evex-api` (:8080): `/health` (public, carries full release identity),
  `/ready`, `/metrics`, `/version` (exact build revision). Every response
  carries `x-request-id`; every log line carries `requestId`.
- `evex-inference` (:8090): `/health`, `/metrics` (stdlib exposition:
  requests, errors, queue depth, latency).
- `evex-mcp` (:8091): `/health` (always public; no `/metrics` in 1.0.0).
- `evex-console` (:3000): `/health`.
- `evex-worker`: serves no HTTP by design (Dockerfile healthcheck polls the
  control plane); progress is file-based under `DATA_DIR`.

Prometheus scrapes (`infra/observability/prometheus.yml`) the HTTP
endpoints above. Trace steps are the primary audit record: every state
transition, denial, escalation, and judgment carries `at` timestamps,
`session_id`/`step_id`, actor, model version, and reasons queryable per
session.

## Incident attribution

`/health` and `/version` report `product/version/commit/tree/buildTime/
sourceDigest`, so operators can always answer which release produced an
incident. No secrets are ever logged or served: error paths return typed
codes + requestId, never stacks or bodies.
