# ADR-10: MCP Tool Versioning (`mcp/1`, Additive Within a Major)

- Status: accepted
- Date: 2026-05-09

## Context

Agents pin tool contracts; breaking them silently orphans installed skills.

## Decision

Version the tool surface as `mcp/1` (`MCP_TOOL_VERSION`). Within a major,
changes are additive (new tools, new optional fields). Renames, removals,
and semantic changes require `mcp/2` with a migration note and compat
tracking per model (`ModelRecord.compat.mcpVersion` + `checkCompat`).

## Alternatives considered

- **Unversioned tools**: zero overhead until the first breaking change, then
  chaos across installed skills.
- **Per-tool versions**: fine-grained but combinatorial for clients.

## Consequences

- Positive: skills declare one `mcpVersion`; the smoke test and compat check
  catch drift before execution.
- Negative: major bumps require dual-serving during migration windows.
