# Example: form fill

Goal: "fill the signup form with test data".

```bash
# 1. Observe, then ground each field (email, name, submit) to a regionId
node skills/eve-computer/scripts/observe.mjs sess-...

# 2. Click the field, type the value, re-observe to confirm caret/value
node skills/eve-computer/scripts/act.mjs sess-... click 640 400 --frame f-0
node skills/eve-computer/scripts/act.mjs sess-... type --text "test@example.com" --frame f-1
node skills/eve-computer/scripts/observe.mjs sess-...
```

Rules: never paste real credentials — test data only; submit last. If a
CAPTCHA or payment step appears → `eve_human_request` (or
`POST /v1/human/request {"sessionId": ...}`) and stop.
