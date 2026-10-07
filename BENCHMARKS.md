# BENCHMARKS

Benchmarks are versioned task registries plus a scoring runner that measures
what happened — never what should have happened. Platform benchmarks execute
REAL sessions/VMs (`POST /v1/benchmarks`, RealAgentAdapter); mock agents
require `agent: mock-test-only` + `testOnly: true` and stamp records
synthetic/test_only, which production consumers refuse.

## Running an eval

```bash
python ml/evaluation/eval.py --registry benchmarks/eve-ground-v1.json \
  --predictions out/preds.jsonl --benchmark eve-ground-v1 --split test \
  --out out/eval-test.json
```

## Inputs

- **Registry JSON**: `{benchmark, tasks: [{task_id, split, goal, expect}]}`.
  `expect` may carry `success` and/or a `bbox` ground-truth box.
- **Predictions JSONL**: `{task_id, step_id?, bbox?, acted?, success?,
  verified?, recovered?, step?, ...}`, one per line. Invalid lines are
  counted as invalid input — they can only hurt, never help.

## Metrics (eval-v2 scoring; all counted, none imputed)

- **Grounding accuracy** — the ACTED prediction's IoU >= `--iou-threshold`
  (default 0.5) vs the expected box. Best-bbox credit across predictions is
  forbidden: single-prediction tasks score the lone decision;
  multi-prediction tasks must mark exactly one `acted: true` or grounding is
  INDETERMINATE (reported, excluded from the denominator). Tasks without a
  bbox expectation are excluded from numerator and denominator.
- **Success rate** — verified success only: `success: true` backed by
  `verified: true`, over scored tasks. `success: true` with `verified:
  false` is contradicted (failure); with no verification evidence it is
  unverified (inconclusive — never headline success). Missing predictions
  are inconclusive (`missing`), not failures.
- **Recovery rate** — temporal: a failure at step i, then a later verified
  success at step j>i, with a `recovered: true` marker at step k>i linking
  them. Pre-failure markers do not link.
- Predictions for unknown task ids are listed under
  `unknown_task_ids_ignored` and excluded from scoring.

## Artifact

The output JSON carries `metrics` (including `scored_total`,
`inconclusive`, `unverified_successes`, `contradicted`, `invalid_lines`),
per-task rows with `status` (scored | missing | indeterminate | unverified),
`scoring_rules: eval-v2/...`, and `provenance` (absolute paths + sha256 of
both inputs, prediction line count, IoU threshold, UTC timestamp), sealed
with a top-level `digest`. Feed it to `ModelRegistry.recordBenchmark` to
attach evidence to a model version.

Platform benchmark records (`POST /v1/benchmarks`) additionally carry
verdict counts (success/failure/inconclusive/invalid), a Wilson 95%
interval on the success rate, agent + model + environment identity, the
exact `METRIC_FORMULAS`, and the evidence digests behind every task.

## Genesis separation

Integrity (grounding on held-out, lineage validity, verifier pass) is scored
separately from performance (success rate, latency). Release requires both
bars plus blinded human review — see `HUMAN_VALIDATION.md` and
`tests/genesis.test.ts`.
