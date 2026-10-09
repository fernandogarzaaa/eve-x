# API (Control-Plane REST Reference)

Base: `http://localhost:8080`. Definition: `apps/api/openapi.json`
(OpenAPI 3.1). Auth: `Authorization: Bearer <EVEX_AUTH_TOKEN>` everywhere
except `GET /health` and `GET /ready`. Development mode with no
`EVEX_AUTH_TOKEN` grants a scoped `operator` context; test/production
modes fail closed (401). `human:takeover` requires an evaluator/admin
bearer token — possession of a session ID alone authorizes nothing.

Probes live at root; product routes live under `/v1`.

## Routes

| Method & path | Capability | Notes |
|---|---|---|
| `GET /health` | — | Liveness `{ok, service, at}` |
| `GET /ready` | — | Readiness `{ready, sessions, vms, at}` |
| `GET /metrics` | — (cluster-local) | Prometheus text: session/vm gauges, WS connections, and failure/behavior counters (stale rejections, actuation failures, takeovers, benchmark runs, validation verdicts, ...) |
| `GET /v1/sessions` | `computer:observe` | List sessions (owner-filtered) |
| `POST /v1/sessions` | `task:execute` | Body: `{goal, persona?, taskId?, vm?}`; 200 `{id, taskId, vmId, status}` |
| `GET /v1/sessions/{id}` | `computer:observe` | Session inspection; 404 unknown |
| `POST /v1/sessions/{id}/pause` | `computer:act` | Observer mode via state machine (409 on illegal transition) |
| `POST /v1/sessions/{id}/resume` | `computer:act` | Re-arm a PAUSED session (post-pause or post-restart-demotion); 409 unless PAUSED |
| `POST /v1/sessions/{id}/step` | `computer:act` | Single-step while paused |
| `POST /v1/sessions/{id}/stop` | `computer:act` | Stop session |
| `GET /v1/vms` | `computer:observe` | List VMs |
| `POST /v1/vms` | `vm:create` | Provision a VM |
| `GET /v1/vms/{id}` | `computer:observe` | VM record; 404 unknown |
| `GET /v1/vms/{id}/status` | `computer:observe` | Lifecycle state |
| `POST /v1/vms/{id}/snapshot` | `vm:control` | Body: `{label?}`; records snapshot |
| `POST /v1/vms/{id}/restore` | `vm:control` | Body: `{snapshot?}`; restore |
| `POST /v1/vms/{id}/fork` | `vm:create` | Branch a copy; returns `{id, ...}` |
| `GET /v1/computer/{sessionId}/observe` | `computer:observe` | `ComputerPercept` JSON (frame + regions + provenance) |
| `POST /v1/computer/{sessionId}/act` | `computer:act` | Flat body `{type, x?, y?, text?, keys?, ms?, confidence?, frameId?, idempotencyKey?}`; pointer/text acts require coordinates/text on every backend; 409 stale perception or human takeover; idempotent keys replay the original |
| `POST /v1/computer/{sessionId}/suggest` | `computer:observe` | Advisory inference `{suggestion, model_id, model_version, model_sha256, degraded, ...}`; never actuates; 502 when the plane is down |
| `POST /v1/human/request` | `computer:act` | Body: `{sessionId, reason?}`; broadcasts help request |
| `POST /v1/human/takeover` | `human:takeover` | Body: `{sessionId, reason?}`; agent paused |
| `POST /v1/human/release` | `human:takeover` | Body: `{sessionId}`; agent must re-observe before continuing |
| `POST /v1/tasks/start` | `task:execute` | Start an evaluation task |
| `GET /v1/tasks/{id}/status` | `computer:observe` | Task status |
| `POST /v1/tasks/{id}/validate` | `task:execute` | EvidenceValidator: body `{evidence: {sessionId, stepIds, assertions?, judgmentIds?}}` required (400 without); verdicts PASS/FAILED/INCONCLUSIVE/INVALID_EVIDENCE with causedBy evidence refs |
| `GET /v1/trace/{sessionId}` | `trace:read` | `{sessionId, steps[]}`; unknown sessions 404 even with file-backed steps (no legacy leak) |
| `POST /v1/replay/{sessionId}` | `trace:read` | Deterministic replay check; `{sessionId, replayed, verdict}` |
| `GET /v1/report/{sessionId}` | `trace:read` | Evidence-backed report `{sessionId, goal, status, steps, success, findings[]}` |
| `POST /v1/judgments` | `trace:export` | Submit blind human judgment (bound to an owned session/step; 404 on phantoms, 409 on double-submit) |
| `POST /v1/benchmarks` | `task:execute` | Real execution (`agent: real`) or gated mock (`agent: mock-test-only` + `testOnly: true`); records carry verdict counts, Wilson CI, identities, evidence digests |
| `GET /v1/benchmarks/{id}` | `trace:read` | Benchmark status |
| `GET /v1/models/status` | `computer:observe` | Live inference probe `{inferenceUrl, model, reachable, ready, degraded, modelIdentity}` (reachable = real /ready round-trip) |
| `WS /v1/stream/{sessionId}` | bearer (header or `?token=`) | Live frames + overlays + timeline; `ping`/`pong` keepalive; unknown 404, cross-tenant 403, floods 429 |

## Conventions

- Errors are `{error, message?}` with HTTP semantics: 400 schema, 401 auth,
  403 capability/policy, 404 unknown id, 409 illegal transition or active
  human takeover, 422 verification/gate failure.
- State-changing VM operations follow the audited lifecycle machine
  (`CREATING … DESTROYED`); illegal transitions return 409 and are logged.
- Trace steps are append-only with a per-step SHA-256 digest chain stamped
  by the control plane; `replay` verdict `deterministic-replay-ok` confirms
  sequence + chain; legacy 40-hex digests are flagged, never trusted.
- The TypeScript client in `packages/mcp-shared` wraps these routes with
  auth headers, timeouts, and idempotency keys.
