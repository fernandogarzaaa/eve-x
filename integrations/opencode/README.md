# EVE-X · OpenCode

## Install

```bash
npm run build
eve-x doctor
```

## MCP config

OpenCode reads `opencode.json`. Merge `integrations/opencode/mcp.json`:

```json
{
  "mcp": {
    "eve-x": { "type": "local", "command": ["node", "dist/apps/mcp/index.js"],
      "environment": { "EVEX_API_URL": "http://localhost:8080" } }
  }
}
```

## Invocation

Tools appear as `eve_session_create`, `eve_computer_observe`,
`eve_computer_act`, etc. Load `skills/eve-computer/SKILL.md` via the skill
tool for the canonical loop and approval policy.
