# EVE-X · Pi agent

## Install

```bash
npm run build
eve-x doctor
```

## MCP config

Register the stdio server from `integrations/pi/mcp.json` in the Pi tool
registry. Pi's tool-calling loop picks up all `eve_*` tools automatically.

## Invocation

`eve_session_create(goal)` then observe/act. Keep the skill file
`skills/eve-computer/SKILL.md` in context so grounding stays region-based.
