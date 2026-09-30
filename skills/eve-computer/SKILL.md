# eve-computer

Drive an EVE-X isolated desktop over the computer-use loop: observe, ground,
act, verify. Use for any task that needs a real GUI (browser, IDE, OS dialogs).

## When to use

- The task requires seeing or clicking a graphical desktop.
- Playwright/DOM alone is insufficient (canvas, native apps, OS chrome).

## Loop (always)

1. `observe` → screenshot + regions (`eve_computer_observe`).
2. Ground the target to a `regionId` + bbox; never click raw coordinates you
   did not just observe.
3. `act` with one `ActionIR` (`eve_computer_act`); include `confidence`.
4. Re-observe; confirm the expected change before the next act.
5. Stop conditions: goal achieved, budget exhausted, destructive or credential
   action needing approval → `eve_human_request`.

See `references/action-ir.md` for the action schema, `references/policy.md`
for approval rules, `references/replay.md` for deterministic replay, and
`references/troubleshooting.md` when stuck.

## Quick start

```text
goal: "open Firefox and search for EVE-X"
session = eve_session_create(goal)
percept = eve_computer_observe(session)
eve_computer_act(session, { type: "open_application", text: "firefox", confidence: 0.9 })
eve_computer_observe(session)   # verify before continuing
```

Scripts: `scripts/observe.mjs`, `scripts/act.mjs`, `scripts/replay.mjs`.
Examples: `examples/browser-search.md`, `examples/form-fill.md`.
