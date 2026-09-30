# Action IR

Canonical action unit. Every act carries `type`, `confidence`, and either a
grounded `target` or an explicit `kind: "none"` target.

```json
{
  "type": "click",
  "target": { "kind": "visual-region", "regionId": "r-3-1", "bbox": [640, 400, 88, 28], "label": "button", "confidence": 0.93 },
  "confidence": 0.9,
  "intent": "press Save"
}
```

Bounding boxes are `[x, y, w, h]` in 1920×1080 frame pixels. Types: `click`,
`double_click`, `move`, `drag`, `type`, `key`, `hotkey`, `scroll`, `wait`,
`observe`, `zoom`, `crop`, `open_application`, `terminal`, `tool`,
`ask_human`, `terminate`.

Rules:

- `type` requires `text` (≤4096 chars). `key`/`hotkey` require `keys` (≤8).
- `drag` requires `from` + `to`. `scroll` uses `delta: {dx, dy}`.
- `confidence` below 0.5 → re-observe instead of acting.
- `ask_human` and `terminate` use `{ kind: "none" }` targets.
