# ADR-15: MCP v2 Dual-Era Migration + Tool-Contract Rename

Date: 2026-10-08. Status: accepted (implemented in 1.1.1).

## Context

1.1.0 shipped `@modelcontextprotocol/sdk` 1.31 (2025-era only) with a
report constraint claiming "no v2 line exists upstream". Re-verification
against the npm registry proved that constraint FALSE: the v2 line is
real and stable (`@modelcontextprotocol/server` + `/client` 2.3.1,
`/node` 2.1.1, `/express` 2.0.2, `/core` 2.3.1), implementing spec
2026-07-28 behind explicit opt-ins, with official migration docs
(ts.sdk.modelcontextprotocol.io/v2). The 1.1.0 claim is retracted;
registry evidence (version queries + doc fetches) is recorded in the
1.1.1 engineering report.

## Decision

1. **Migrate deliberately, not mechanically.** New packages
   `@modelcontextprotocol/server` + `/node` (runtime),
   `/client` (dev/test). No codemod run: our surface is two files plus
   tests, and hand migration keeps every auth/session/validation behavior
   explicit. Repo upgrades zod v3→v4 (measured: typecheck + 345/345 suite
   green after 5 surgical fixes), so `registerTool` takes our zod schemas
   natively — no conversion layer, no drift.
2. **Dual-era serving.** POST /mcp routes by envelope claim:
   `createMcpHandler(factory, { legacy: 'reject' })` + `toNodeHandler`
   for modern (stateless, per-request servers); the existing sessionful
   path (ported to `NodeStreamableHTTPServerTransport`) for legacy.
   Served era observable via `x-evex-protocol-era`. Auth + rate limiting
   run before era routing (auth status never selects an era, per the SDK
   docs' own rule). stdio serves both eras via `serveStdio`.
3. **Validation stays ours.** Probes proved the v2 SDK does not validate
   tool arguments server-side (neither `fromJsonSchema` nor zod schemas).
   Every handler parses with strict `TOOL_SCHEMAS` first; `invalid-params`
   results precede any fetch. The SDK advertises shapes; we enforce them.
4. **Rename the tool contract** `mcp/1` → `evex-tools/1` (constant value,
   skill manifests/defaults, model compat defaults, docs). It never named
   the wire protocol; now it cannot be read that way. Wire protocol is
   negotiated per connection; SDK versions are pinned in package.json and
   recorded in the release manifest.
5. **No silent behavior changes.** Legacy session semantics (stable ids,
   DELETE closes, unknown-session 400), bearer forwarding, error mapping,
   timeouts, and rate limits are preserved and re-tested; modern-era
   statelessness is additive.

## Consequences

- `verify-release` checks the three v2 package versions; honesty gates ban
  v1 SDK imports.
- InMemoryTransport linked pairs must come from one v2 package (tests use
  the server's export for both halves); modern-era tests drive HTTP or
  `handler.fetch` (InMemoryTransport is 2025-era only, per the SDK docs).
- Zod v4 semantic deltas accepted: explicit `.default()` values,
  two-argument `z.record`, string-keyed (partial) `perCategory`.
