# Action IR

Canonical action unit. Two equivalent forms:

1. **ActionIR object** (traces, `candidate_actions`/`selected_action`): every
   act carries `type` plus `confidence` in `[0, 1]`, and either a grounded
   `target` or an explicit `kind: "none"` target.

```json
{
  "type": "click",
  "target": { "kind": "visual-region", "regionId": "r-3-1", "bbox": [640, 400, 88, 28], "label": "button", "confidence": 0.93 },
  "confidence": 0.9,
  "intent": "press Save"
}
```

2. **HTTP flat form** (`POST /v1/computer/{sessionId}/act`, what
   `scripts/act.mjs` and `eve_computer_act` send):

```json
{ "type": "click", "x": 640, "y": 400, "confidence": 0.9 }
```

Optional flat fields: `text` (for `type`, ≤4096 chars), `keys` (for
`key`/`hotkey`, ≤8 entries), `ms` (for `wait`, ≤60000), `frameId` (the frame
you grounded against — stale ids get `409 stale_perception`),
`idempotencyKey` (replays return the original response with no new step).

Bounding boxes are `[x, y, w, h]` in frame pixels. Types: `click`,
`double_click`, `move`, `drag`, `type`, `key`, `hotkey`, `scroll`, `wait`,
`observe`, `zoom`, `crop`, `open_application`, `terminal`, `tool`,
`ask_human`, `terminate`. Unknown types get `400`.

Rules:

- `type` requires `text`. `key`/`hotkey` require `keys`.
- `drag` uses `from` + `to` points; `scroll` carries no pointer delta over
  HTTP (just `{"type": "scroll"}`).
- `confidence` below 0.5 → re-observe instead of acting.
- `ask_human` and `terminate` use `{ kind: "none" }` targets.
