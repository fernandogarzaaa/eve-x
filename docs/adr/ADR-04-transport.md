# ADR-04: REST + MCP Dual Transport, Single Schema Authority

- Status: accepted
- Date: 2026-03-28

## Context

Operators need a stable HTTP API; agents and skills need a tool-call
surface. Two transports risk two divergent contracts.

## Decision

Expose REST `/v1` (defined in `apps/api/openapi.json`) and MCP `evex-tools/1`
tools side by side, both validated by the same zod schemas owned by
`packages/protocol` (wire types) and `packages/mcp-shared` (tool inputs +
`ControlPlaneClient`).

## Alternatives considered

- **REST only**: forces agents through HTTP plumbing instead of native tool
  calls.
- **MCP only**: operators lose curl-able, cache-able, gateway-friendly
  endpoints.

## Consequences

- Positive: one schema change propagates to both surfaces; the TS client and
  MCP server cannot drift.
- Negative: every new operation needs both a route and a tool entry; the
  `TOOL_SCHEMAS` table makes the checklist explicit.
