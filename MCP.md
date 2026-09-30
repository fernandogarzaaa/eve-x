# MCP (Model Context Protocol Surface)

Version: `mcp/1` (`MCP_TOOL_VERSION` in `packages/mcp-shared`).

## Tools

| Tool | Input | Effect |
|---|---|---|
| `vm.create` | image/snapshot/size/locale/network | Provision an isolated guest |
| `vm.control` | vmId, op (boot/shutdown/reboot/pause/resume/snapshot/restore/fork/destroy) | Lifecycle transition |
| `computer.observe` | vmId, includeScreenshot, maxWidth | Capture frame + regions |
| `computer.act` | vmId, taskId, ActionIR, idempotencyKey | Execute one validated action |
| `task.execute` | full `TaskSpec` | Launch a seeded evaluation task |
| `trace.read` | sessionId, fromSeq, limit | Paginated trace read |
| `trace.export` | sessionId, format | Full trace export |
| `human.takeover` | sessionId, stepId, reason | Escalate to an operator |
| `model.invoke` | modelId, frame, goal, regions, timeout | Route a percept to inference |

All inputs are zod schemas in `TOOL_SCHEMAS`; `parseToolInput` throws on
violation, `safeParseToolInput` returns structured issues. Both the MCP
server and clients import these from `packages/mcp-shared`, so the wire
contract has exactly one definition.

## Client (`ControlPlaneClient`)

Fetch-based, no SDK:

- `Authorization: Bearer` on every request; construction without a token
  throws; `createClientFromEnv` reads `EVEX_CONTROL_PLANE_URL`,
  `EVEX_AUTH_TOKEN`, `EVEX_CONTROL_PLANE_TIMEOUT_MS`.
- Per-request `AbortController` timeout (default 15 s) mapped to a
  `ControlPlaneError(status 0)` timeout error; HTTP errors map to
  `ControlPlaneError` with status + body preserved.
- `act()` sends the `idempotency-key` header; `readTrace()` encodes
  pagination; `observe()`/`act()` validate inputs before sending.

## Versioning (ADR-10)

Tool schemas are additive within `mcp/1`: new optional fields are allowed,
renames and semantic changes require `mcp/2` with a compat-tested migration.
`ModelRecord.compat.mcpVersion` records which version each model was
validated against, and `checkCompat` refuses mismatches with reasons.
