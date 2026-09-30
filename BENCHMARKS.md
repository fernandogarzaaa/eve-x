# BENCHMARKS

Benchmarks are versioned task registries plus a scoring runner that measures
what happened — never what should have happened.

## Running an eval

```bash
python ml/evaluation/eval.py --registry benchmarks/eve-ground-v1.json \
  --predictions out/preds.jsonl --benchmark eve-ground-v1 --split test \
  --out out/eval-test.json
```

## Inputs

- **Registry JSON**: `{benchmark, tasks: [{task_id, split, goal, expect}]}`.
  `expect` may carry `success` and/or a `bbox` ground-truth box.
- **Predictions JSONL**: `{task_id, step_id?, bbox?, success?, recovered?, …}`,
  one per line. Invalid lines are warned on and treated as absent — they can
  only hurt the score, never help it.

## Metrics (all counted, none imputed)

- **Grounding accuracy** — fraction of bbox-bearing tasks whose best
  prediction reaches IoU ≥ `--iou-threshold` (default 0.5) with the expected
  box. Tasks without a bbox expectation are excluded from numerator and
  denominator.
- **Success rate** — fraction of tasks with at least one `success: true`
  prediction. Tasks with zero predictions count as failures and are reported
  as `missing`.
- **Recovery rate** — among tasks showing an early `success: false`, the
  fraction that later succeed with a `recovered: true` flag.
- Predictions for unknown task ids are listed under
  `unknown_task_ids_ignored` and excluded from scoring.

## Artifact

The output JSON carries `metrics`, per-task rows, and `provenance`
(absolute paths + sha256 of both inputs, prediction line count, IoU
threshold, UTC timestamp), sealed with a top-level `digest`. Feed it to
`ModelRegistry.recordBenchmark` to attach evidence to a model version.

## Genesis separation

Integrity (grounding on held-out, lineage validity, verifier pass) is scored
separately from performance (success rate, latency). Release requires both
bars plus blinded human review — see `HUMAN_VALIDATION.md` and
`tests/genesis.test.ts`.
