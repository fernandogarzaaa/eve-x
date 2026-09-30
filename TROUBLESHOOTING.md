# TROUBLESHOOTING

## TypeScript

**`npx tsc --noEmit` fails on imports.**
This repo is ESM NodeNext: relative imports must use `.js` extensions
(`../packages/protocol/src/index.js`), even though the source files are
`.ts`. New packages must only import from `protocol` / `core` /
`model-registry` plus local code.

**`ZodTypeAny` or zod generics complain.**
Use `z.infer<typeof Schema>` for types and `safeParse` at boundaries; never
widen to an unchecked type to silence the compiler.

## Compose

**api unhealthy, worker waiting.**
Check `postgres`/`redis` health first — the api gates on both. Common cause:
`POSTGRES_PASSWORD` changed without wiping `pgdata`; reset the volume or
restore the password.

**`inference` 429s.**
Queue bound reached: lower study concurrency or add replicas. 429 is
backpressure, not an outage.

**`mcp` can't reach api.**
Compose DNS uses `http://api:8080` internally; `EVEX_CONTROL_PLANE_URL` set
to `localhost` inside the container is the usual mistake.

## ML scripts

**`train.py` exits 2 with a torch message.**
Install CPU torch or use `--smoke` for the dependency-free path.

**`build.py` reports zero kept rows.**
Check `stats` in `digest.json`: `quality_dropped` tells which filter fired
(usually `unverified-grounding` on raw agent logs — expected; those rows are
unsafe to train on).

**`eval.py` reports high `missing_predictions`.**
Task ids in predictions must match registry `task_id`s exactly, and `--split`
must match the registry split assignment.

**`server.py` serves degraded.**
No `--weights` was given or the accelerator probe failed; `/ready` explains
in `detail`. Heuristic mode is intentional — investigate, don't panic.

## VMs

**409 on control.**
Follow the legal edge from the current state (`VM.md` diagram); e.g. a
`PAUSED` VM resumes before it can stop.

**Guest agent unreachable.**
Reboot via control op; if `BOOTING` never reaches `READY`, rebuild from the
snapshot — the overlay may be corrupt.
