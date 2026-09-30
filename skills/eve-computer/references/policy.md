# Policy & approvals

Default policy denies: destructive filesystem writes outside the task home,
external messaging, purchases, credential entry, data export.

`requireApprovalFor` defaults to `["destructive", "purchase", "data-export"]`.
When an action matches, call `eve_human_request(sessionId, reason)` and wait
for `takeover`/`release` before continuing. Never self-approve.

Capabilities gate tools: `computer:act` for acting, `human:takeover` for
takeover, `trace:export` for exporting traces. The API returns 403 when the
token lacks a capability — surface that to the user, do not retry silently.
