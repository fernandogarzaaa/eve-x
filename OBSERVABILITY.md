# OBSERVABILITY

## Metrics

Prometheus scrapes (`infra/observability/prometheus.yml`, 10–15 s):

- `evex-api` (:8080 `/v1/metrics`) — requests, auth failures, policy
  denials, transition errors, task starts/completions.
- `evex-inference` (:8090 `/metrics`) — `evex_infer_requests_total`,
  `evex_infer_errors_total`, `evex_infer_queue_depth`,
  `evex_infer_latency_p50_ms` (stdlib exposition, no client library).
- `evex-worker` (:8082 `/metrics`), `evex-mcp` (:8081 `/metrics`),
  postgres/redis exporters, and Prometheus self-metrics.

Alert rules (`alert.rules.yml` next to `prometheus.yml`) fire on: inference
unready > 5 min, queue depth > 80% of bound, 5xx rate spike, VM `FAILED`
growth, and promotion-gate refusal bursts.

## Logs

Structured JSON lines (UTC timestamp, component, session/task/vm ids,
outcome). Trace steps are the primary audit record, not log exhaust: every
state transition, denial, escalation, and judgment carries `at` timestamps
and reasons queryable per session.

## Tracing sessions

From a session id: `trace read` replays the step journal; per-step digests
detect tampering; `trace export` produces the offline bundle reviewers and
the dataset pipeline consume. Replay cursors (`tests/replay.test.ts`) seek
and branch without mutating history.

## Dashboards

Console panels: fleet states, population-study progress (success/drop-off
histograms), inference latency/queue, reviewer agreement, and release-gate
status (integrity vs performance bars side by side).
