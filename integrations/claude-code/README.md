# EVE-X · Claude Code

## Install

```bash
npm run build
eve-x doctor
```

## MCP discovery

Claude Code reads `.mcp.json` at the repo root or `~/.claude.json`. Point it
at the EVE-X MCP server over stdio:

```bash
claude mcp add eve-x -- node dist/apps/mcp/index.js
```

Or copy `integrations/claude-code/mcp.json` to `.mcp.json`.

## Invocation

- `/mcp eve-x eve_session_create` — start a session with a goal string.
- Observe with `eve_computer_observe`, act with `eve_computer_act`.
- Skill: `@skills/eve-computer/SKILL.md` for the observe→ground→act loop.

## Auth

Set `EVEX_AUTH_TOKEN` in the shell that launches both the API and Claude Code
so the MCP server passes the same bearer through.
