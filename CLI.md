# CLI

Binary: `eve-x` (`dist/apps/cli/src/index.js`). All commands honor `--json` for
scripting and exit non-zero with `{code, message}` on failure.

## Commands

```
eve-x init [--dir <path>]               scaffold data dirs + .env
eve-x doctor                            environment + dependency sanity report
eve-x vm create [--image N] [--cpu N]   create a VM
eve-x vm status <id>                    VM status
eve-x vm rm <id> | vm destroy <id>      destroy a VM
eve-x session create --goal "..."       create session
eve-x session status <id>               session status
eve-x session stop <id>                 stop a session
eve-x benchmark run [--size N]          run benchmark suite
eve-x report <sessionId>                print session report
eve-x model status                      inference backend status
eve-x dataset ls                        list sessions (dataset helper)
eve-x dataset trace <sessionId>         print session trace
eve-x server | console | worker | mcp   run plane components in foreground
                                        (delegates to dist bundles; see package.json scripts)
```

Computer observe/act over HTTP is covered by the skill scripts
(`skills/eve-computer/scripts/observe.mjs`, `act.mjs`, `replay.mjs`) and the
MCP tools (`eve_computer_observe`, `eve_computer_act`); the CLI has no
`task run`, `trace read/export`, `model list/register/promote`, or
`skill install/verify` subcommands.

## Environment

`EVEX_API_URL` (default `http://localhost:8080`),
`EVEX_AUTH_TOKEN` (required for every command except `doctor`),
`EVEX_CONTROL_PLANE_TIMEOUT_MS` (default 15000).

## Exit codes

0 success · 1 usage/validation · 2 missing dependency or unreachable plane ·
3 policy/capability denial · 4 verification or promotion-gate failure.
`doctor` reports per-check pass/fail lines so operators can fix one item at a
time; automation should parse `--json` output, not the human tables.
