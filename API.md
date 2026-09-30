# API (Control-Plane REST Reference)

Base: `http://localhost:8080`. Definition: `apps/api/openapi.json`
(OpenAPI 3.1). Auth: `Authorization: Bearer <EVEX_AUTH_TOKEN>` everywhere
except `GET /health` and `GET /ready`. Dev mode (no `EVEX_AUTH_TOKEN` set)
grants a scoped `operator` context; `human:takeover` requires an
evaluator/admin bearer token — possession of a session ID alone authorizes
nothing.

Probes live at root; product routes live under `/v1`.

## Routes

| Method & path | Capability | Notes |
|---|---|---|
| `GET /health` | — | Liveness `{ok, service, at}` |
| `GET /ready` | — | Readiness `{ready, sessions, vms, at}` |
| `GET /metrics` | — (cluster-local) | Prometheus text |
| `GET /v1/sessions` | `computer:observe` | List sessions |
| `POST /v1/sessions` | `task:execute` | Body: `{goal, persona?, taskId?, vm?}`; 200 `{id, taskId, vmId, status}` |
| `GET /v1/sessions/{id}` | `computer:observe` | Session inspection; 404 unknown |
| `POST /v1/sessions/{id}/pause` | `computer:act` | Observer mode (agent paused) |
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
| `POST /v1/computer/{sessionId}/act` | `computer:act` | Flat body `{type, x?, y?, text?, keys?, ms?, confidence?}`; 409 while a human holds takeover |
| `POST /v1/human/request` | `computer:act` | Body: `{sessionId, reason?}`; broadcasts help request |
| `POST /v1/human/takeover` | `human:takeover` | Body: `{sessionId, reason?}`; agent paused |
| `POST /v1/human/release` | `human:takeover` | Body: `{sessionId}`; agent must re-observe before continuing |
| `POST /v1/tasks/start` | `task:execute` | Start an evaluation task |
| `GET /v1/tasks/{id}/status` | `computer:observe` | Task status |
| `POST /v1/tasks/{id}/validate` | `task:execute` | Evidence-backed validation |
| `GET /v1/trace/{sessionId}` | `trace:read` | `{sessionId, steps[]}` |
| `POST /v1/replay/{sessionId}` | `trace:read` | Deterministic replay check; `{sessionId, replayed, verdict}` |
| `GET /v1/report/{sessionId}` | `trace:read` | Evidence-backed report `{sessionId, goal, status, steps, success, findings[]}` |
| `POST /v1/judgments` | `trace:export` | Submit blind human judgment |
| `POST /v1/benchmarks` | `task:execute` | Run a benchmark suite |
| `GET /v1/benchmarks/{id}` | `trace:read` | Benchmark status |
| `GET /v1/models/status` | `computer:observe` | Inference backend `{inferenceUrl, model, reachable}` |
| `WS /v1/stream/{sessionId}` | bearer | Live frames + overlays + timeline; `ping`/`pong` keepalive |

## Conventions

- Errors are `{error, message?}` with HTTP semantics: 400 schema, 401 auth,
  403 capability/policy, 404 unknown id, 409 illegal transition or active
  human takeover, 422 verification/gate failure.
- State-changing VM operations follow the audited lifecycle machine
  (`CREATING … DESTROYED`); illegal transitions return 409 and are logged.
- Trace steps are append-only with a per-step digest chain; `replay` verdict
  `deterministic-replay-ok` confirms the stored timeline replays cleanly.
- The TypeScript client in `packages/mcp-shared` wraps these routes with
  auth headers, timeouts, and idempotency keys.
