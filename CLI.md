# CLI

Binary: `eve-x` (`dist/apps/cli/index.js`). All commands honor `--json` for
scripting and exit non-zero with `{code, message}` on failure.

## Commands

```
eve-x doctor                        # environment + dependency sanity report
eve-x vm create --image ubuntu-desktop-v1 --cpu 4 --mem 8192
eve-x vm control <vmId> --op pause --reason "operator hold"
eve-x vm destroy <vmId>
eve-x task run --goal "open settings" --seed 42 --persona first-time-user
eve-x trace read <sessionId> --from 0 --limit 100
eve-x trace export <sessionId> --format jsonl --out session.jsonl
eve-x benchmark run --benchmark eve-ground-v1 --split test
eve-x model list | register | promote --approval-token <token>
eve-x skill install ./my-skill --platform opencode
eve-x skill verify pdf-triage --platform opencode
eve-x server | worker | mcp          # run plane components in foreground
```

## Environment

`EVEX_CONTROL_PLANE_URL` (default `http://localhost:8080`),
`EVEX_AUTH_TOKEN` (required for every command except `doctor`),
`EVEX_CONTROL_PLANE_TIMEOUT_MS` (default 15000).

## Exit codes

0 success · 1 usage/validation · 2 missing dependency or unreachable plane ·
3 policy/capability denial · 4 verification or promotion-gate failure.
`doctor` reports per-check pass/fail lines so operators can fix one item at a
time; automation should parse `--json` output, not the human tables.
