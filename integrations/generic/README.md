# EVE-X · Generic MCP client

Any MCP-compatible client can use EVE-X over stdio or StreamableHTTP.

## Stdio

```bash
node dist/apps/mcp/index.js
# env: EVEX_API_URL=http://localhost:8080 EVEX_AUTH_TOKEN=...
```

## StreamableHTTP

```bash
node dist/apps/mcp/index.js http   # :8091/mcp
```

## Config

`integrations/generic/mcp.json` holds both variants. Tool names are stable:
`eve_session_create/status/stop`, `eve_vm_create/status/snapshot/restore/fork`,
`eve_computer_observe/act`, `eve_human_request/takeover/release`,
`eve_task_start/status/validate`, `eve_trace_get`, `eve_replay`, `eve_report`,
`eve_benchmark`, `eve_model_status`.

## Discovery

Tools self-describe via `tools/list`; zod schemas enforce arguments. Auth is a
bearer passthrough (`EVEX_AUTH_TOKEN` or per-session token).
