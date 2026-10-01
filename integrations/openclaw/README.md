# EVE-X · OpenClaw

## Install

```bash
npm run build
eve-x doctor
```

## MCP config

Add the stdio entry from `integrations/openclaw/mcp.json` to the OpenClaw
gateway config. For remote operation use StreamableHTTP:

```bash
node dist/apps/mcp/src/index.js http   # serves :8091/mcp
```

## Invocation

Drive sessions through `eve_session_create` → `eve_computer_observe` →
`eve_computer_act`. Human gates (`eve_human_takeover`/`release`) map to
OpenClaw approval cards.
