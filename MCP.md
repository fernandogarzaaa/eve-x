# MCP (Model Context Protocol Surface)

Three versions, independent by design:

| Version | Meaning | Value / source |
|---|---|---|
| Tool contract | OUR tool surface: names + JSON shapes of the 21 `eve_*` tools | `evex-tools/1` (`MCP_TOOL_VERSION` in `packages/mcp-shared`) |
| Wire protocol | Negotiated per connection | `2026-07-28` modern (stateless) or 2025-era legacy (sessionful); observable via `x-evex-protocol-era` |
| SDK | Pinned implementation | `@modelcontextprotocol/server` + `/node` v2 lines (runtime), `/client` v2 (tests); zod v4 |

History: 1.1.0 shipped SDK 1.31 (2025-era only) because no v2 line
existed upstream at the time. The v2 line is real (verified against the
registry + official migration docs); 1.1.1 migrates deliberately (see
ADR-15). The old `mcp/1` tool-contract label was renamed to
`evex-tools/1` so it can never be mistaken for a protocol version.

## Tools

| Tool | Input | Effect |
|---|---|---|
| `eve_session_create` | goal (≤2000), persona, seed, maxSteps | `POST /v1/sessions` — create session + VM |
| `eve_session_status` | sessionId | `GET /v1/sessions/:id` |
| `eve_session_stop` | sessionId | `POST /v1/sessions/:id/stop` |
| `eve_vm_create` | image, cpu, memoryMb | `POST /v1/vms` — provision a guest |
| `eve_vm_status` | vmId | `GET /v1/vms/:id/status` |
| `eve_vm_snapshot` | vmId, label? | `POST /v1/vms/:id/snapshot` |
| `eve_vm_restore` | vmId, snapshot? | `POST /v1/vms/:id/restore` |
| `eve_vm_fork` | vmId | `POST /v1/vms/:id/fork` |
| `eve_computer_observe` | sessionId | `GET /v1/computer/:sessionId/observe` |
| `eve_computer_act` | sessionId, 17-action `type`, x/y/text/keys (≤8)/ms/confidence/frameId/idempotencyKey | `POST /v1/computer/:sessionId/act` (flat body) |
| `eve_human_request` | sessionId, reason? | `POST /v1/human/request` |
| `eve_human_takeover` | sessionId | `POST /v1/human/takeover` |
| `eve_human_release` | sessionId | `POST /v1/human/release` |
| `eve_task_start` | goal (≤2000), persona, seed | `POST /v1/tasks/start` |
| `eve_task_status` | taskId | `GET /v1/tasks/:id/status` |
| `eve_task_validate` | taskId, evidence bundle | `POST /v1/tasks/:id/validate` (evidence-required; verdicts PASS/FAILED/INCONCLUSIVE/INVALID_EVIDENCE) |
| `eve_trace_get` | sessionId | `GET /v1/trace/:sessionId` |
| `eve_replay` | sessionId, seed | `POST /v1/replay/:sessionId` |
| `eve_report` | sessionId | `GET /v1/report/:sessionId` |
| `eve_benchmark` | name, size, agent?, testOnly? | `POST /v1/benchmarks` (real execution; mock requires testOnly) |
| `eve_model_status` | (none) | `GET /v1/models/status` |

All inputs are strict zod schemas in `TOOL_SCHEMAS`; unknown fields, wrong
types, oversized strings (`goal` ≤ 2000, `text` ≤ 4096, `keys` ≤ 8), and
off-charset ids (`[A-Za-z0-9_-]{1,128}`) are rejected as `invalid-params`
before any fetch. `parseToolInput` throws on violation,
`safeParseToolInput` returns structured issues. Both the MCP server and
clients import these from `packages/mcp-shared`, so the wire contract has
exactly one definition.

## Transport & auth

- Default transport is `stdio` (`serveStdio` serves both eras).
- `http` argv serves dual-era StreamableHTTP at `/mcp` plus a public `GET
  /health` probe. POST routing: modern envelopes (2026-07-28 claims) go to a
  per-request stateless server (`createMcpHandler`, `legacy: 'reject'`);
  everything else keeps the explicit sessionful legacy path (stable session
  ids via `mcp-session-id`, `DELETE /mcp` closes, unknown sessions 400).
  GET carries legacy SSE streams. Every served response carries
  `x-evex-protocol-era: modern|legacy`.
- Argument validation is server-side-ours, always: the SDK advertises
  input schemas but does not validate tool calls, so every handler parses
  with the strict zod `TOOL_SCHEMAS` first (`invalid-params` results
  before any control-plane fetch).
- HTTP `/mcp` requires an `Authorization` bearer matching
  `EVEX_MCP_TOKEN ?? EVEX_AUTH_TOKEN` whenever either is set (401
  otherwise) — checked BEFORE era routing, and outside development mode
  even when no token is configured. When neither is set the endpoint stays
  open for single-user local use and stamps `x-evex-dev: 1` on responses.
- `/mcp` has a per-caller fixed-window rate limit (`EVEX_MCP_RATE_LIMIT`,
  default 600/min; 429 + Retry-After; `/health` never limited).
- The CALLER's bearer is forwarded to the control plane on every tool call;
  only when the caller sent none is `EVEX_AUTH_TOKEN` used as a fallback.
  Token values are never logged.
- There is no loopback stub: every tool requires a reachable control plane
  at `EVEX_API_URL` (default `http://localhost:8080`). API unreachable →
  a clear `{error: "unreachable"}` result; hung API → `{error: "timeout"}`
  after 30 s (`EVEX_API_TIMEOUT_MS` overrides).
- API statuses map to MCP error classes: 400 `invalid-params`, 401
  `unauthorized`, 403 `forbidden`, 404 `not-found`, 409 `conflict` (with a
  `stale_perception` re-observe hint when applicable), 429 `rate-limited`
  (retryable), 5xx `internal` as a one-line summary with no body internals
  and no stack traces.

## Client (`ControlPlaneClient`)

Fetch-based, no SDK:

- `Authorization: Bearer` on every request; construction without a token
  throws; `createClientFromEnv` reads `EVEX_CONTROL_PLANE_URL`,
  `EVEX_AUTH_TOKEN`, `EVEX_CONTROL_PLANE_TIMEOUT_MS`.
- Per-request `AbortController` timeout (default 15 s) mapped to a
  `ControlPlaneError(status 0)` timeout error; HTTP errors map to
  `ControlPlaneError` with status + body preserved.
- Typed helpers mirror the real routes exactly: root probes (`health`,
  `ready`, `metricsText`), sessions (`list/create/get/pause/step/stop`),
  VMs (`list/create/get/status/snapshot/restore/fork/delete`), computer
  (`observe`, `act` with a flat body), human
  (`request/takeover/release`), tasks (`start/status/validate`),
  `readTrace`/`replaySession`/`sessionReport`, `submitJudgment`,
  `runBenchmark`/`benchmarkStatus`, `modelStatus`, plus `streamPath` for
  `WS /v1/stream/:sessionId`. `act()` sends the `idempotency-key` header;
  ids are charset-validated before sending.

## Versioning (ADR-10, superseded in part by ADR-15)

Tool schemas are additive within `evex-tools/1`: new optional fields are
allowed, renames and semantic changes require `evex-tools/2` with a
compat-tested migration. `ModelRecord.compat.mcpVersion` records which
tool-contract version each model was validated against, and `checkCompat`
refuses mismatches with reasons. (ADR-10's `mcp/1` label is renamed, not
its additive-compatibility rule.)
