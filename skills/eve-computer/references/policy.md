# Policy & approvals

Default policy denies: destructive filesystem writes outside the task home,
external messaging, purchases, credential entry, data export.

`requireApprovalFor` defaults to `["destructive", "purchase", "data-export"]`.
When an action matches, call `eve_human_request(sessionId, reason)` (or
`POST /v1/human/request`) and wait for `takeover`/`release` before
continuing. Never self-approve.

Capabilities gate tools (`403` when the token lacks one — surface that to
the user, do not retry silently): `computer:observe` for observing,
`computer:act` for acting, `human:takeover` for takeover/release,
`trace:read` for trace/replay/report reads and blind-review enqueue
(`POST /v1/reviews`), `trace:export` for submitting judgments
(`POST /v1/judgments`), `task:execute` for sessions/benchmarks,
`vm:create` / `vm:control` / `vm:destroy` for VM lifecycle.
