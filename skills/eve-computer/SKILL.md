# eve-computer

Drive an EVE-X isolated desktop over the computer-use loop: observe, ground,
act, verify. Use for any task that needs a real GUI (browser, IDE, OS dialogs).

## When to use

- The task requires seeing or clicking a graphical desktop.
- Playwright/DOM alone is insufficient (canvas, native apps, OS chrome).

## Loop (always)

1. `observe` → screenshot + regions (`eve_computer_observe`, or
   `GET /v1/computer/{sessionId}/observe`).
2. Ground the target to a `regionId` + bbox; never click raw coordinates you
   did not just observe.
3. `act` with one flat-form action (`eve_computer_act`, or
   `POST /v1/computer/{sessionId}/act` with `{type, x?, y?, text?, keys?,
   ms?, confidence?, frameId?, idempotencyKey?}`); include `confidence`.
4. Re-observe; confirm the expected change before the next act. Pass the
   `frameId` you grounded against as `frameId` — the plane rejects stale
   perception with `409 stale_perception`.
5. Stop conditions: goal achieved, budget exhausted, destructive or credential
   action needing approval → `eve_human_request`.

See `references/action-ir.md` for the action schema, `references/policy.md`
for approval rules, `references/replay.md` for deterministic replay, and
`references/troubleshooting.md` when stuck.

## Endpoints (all under `http://localhost:8080`, bearer `EVEX_AUTH_TOKEN`)

| Operation | Method + path |
|---|---|
| Create session | `POST /v1/sessions` `{goal, persona?, seed?, maxSteps?}` |
| Observe | `GET /v1/computer/{sessionId}/observe` |
| Act | `POST /v1/computer/{sessionId}/act` |
| Trace | `GET /v1/trace/{sessionId}` |
| Replay check | `POST /v1/replay/{sessionId}` |
| Report | `GET /v1/report/{sessionId}` |
| Blind review enqueue | `POST /v1/reviews` `{sessionId, stepId?}` |
| Submit judgment | `POST /v1/judgments` (with `reviewId` to unlock the full step) |
| Human takeover/release | `POST /v1/human/takeover`, `POST /v1/human/release` |
| Live frames | WebSocket `/v1/stream/{sessionId}` |

MCP tools mirror these routes: `eve_session_create/status/stop`,
`eve_vm_create/status/snapshot/restore/fork`,
`eve_computer_observe/act`, `eve_human_request/takeover/release`,
`eve_task_start/status/validate`, `eve_trace_get`, `eve_replay`,
`eve_report`, `eve_benchmark`, `eve_model_status`. Other planes:
console `:3000`, MCP StreamableHTTP `:8091/mcp`, inference `:8090`.

## Quick start

```bash
# CLI (binary: eve-x)
eve-x session create --goal "open Firefox and search for EVE-X"
eve-x dataset trace <sessionId>

# Raw HTTP (same calls the MCP tools make)
curl -H "Authorization: Bearer $EVEX_AUTH_TOKEN" \
  http://localhost:8080/v1/computer/<sessionId>/observe
curl -X POST -H "Authorization: Bearer $EVEX_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"click","x":640,"y":400,"confidence":0.9}' \
  http://localhost:8080/v1/computer/<sessionId>/act
```

Scripts: `scripts/observe.mjs`, `scripts/act.mjs`, `scripts/replay.mjs`
(each prints usage and exits `2` with `--help`, no network needed).
Examples: `examples/browser-search.md`, `examples/form-fill.md`.
