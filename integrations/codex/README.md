# EVE-X · Codex CLI

## Install

```bash
npm run build
eve-x doctor
```

## MCP config

Codex loads MCP servers from `~/.codex/config.toml`. Append
`integrations/codex/mcp.toml`, or add:

```toml
[mcp_servers.eve-x]
command = "node"
args = ["dist/apps/mcp/index.js"]
```

Set `EVEX_API_URL` / `EVEX_AUTH_TOKEN` in the environment before `codex`.

## Invocation

Ask Codex to use the `eve_session_create` tool with a goal, then iterate
observe/act. Reference `skills/eve-computer/SKILL.md` for grounding rules.
