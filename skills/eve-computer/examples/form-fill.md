# Example: form fill

Goal: "fill the signup form with test data".

1. Observe → ground each field (`email`, `name`, `submit`) to regionIds.
2. Click field → `type` value → re-observe to confirm caret/value.
3. Never paste credentials; test data only. Submit last.
4. If a CAPTCHA or payment step appears → `eve_human_request` and stop.
