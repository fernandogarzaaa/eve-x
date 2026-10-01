# Example: browser search

Goal: "open Firefox and search for EVE-X".

```bash
# 1. Create the session (real CLI command)
eve-x session create --goal "open Firefox and search for EVE-X"
# → {"id": "sess-...", "taskId": "task-...", "vmId": "vm-...", "status": "RUNNING"}

# 2. Observe (taskbar region r-taskbar @ 0.99)
node skills/eve-computer/scripts/observe.mjs sess-...

# 3. Act: flat form per apps/api/openapi.json
node skills/eve-computer/scripts/act.mjs sess-... click 640 1040 --frame f-0
curl -X POST -H "Authorization: Bearer $EVEX_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"type":"type","text":"EVE-X","confidence":0.85}' \
  http://localhost:8080/v1/computer/sess-.../act

# 4. Re-observe to verify the results page before the next act
node skills/eve-computer/scripts/observe.mjs sess-...

# 5. Report + deterministic replay check
eve-x report sess-...
node skills/eve-computer/scripts/replay.mjs sess-...
```

MCP equivalents: `eve_session_create({goal})` → `eve_computer_observe` →
`eve_computer_act` → `eve_computer_observe` → `eve_report`.
