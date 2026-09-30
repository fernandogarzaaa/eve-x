# EVE-X · Hermes

## Install

```bash
npm run build
eve-x doctor
```

## MCP config

Hermes connects over StreamableHTTP for fleet use:

```bash
node dist/apps/mcp/index.js http
```

then register `http://localhost:8091/mcp` with the Hermes router
(see `integrations/hermes/mcp.json`). Per-session tokens from
`packages/security` scope each tenant.

## Invocation

Create sessions per tenant, stream frames via `/v1/stream/:sessionId`, and
collect judgments blind through `POST /v1/judgments`.
