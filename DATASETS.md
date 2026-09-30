# DATASETS

Pipeline: `ml/datasets/build.py` turns raw trajectory JSONL into
train/val/test/held-out splits with digests.

```bash
python ml/datasets/build.py --in traces.jsonl --out data/eve-v1 \
  --val 0.1 --test 0.1 --heldout 0.05 --seed 42
```

## Input

One JSON object per line: either a `TraceStep`-shaped step or a trajectory
object with a `steps` list. Malformed lines are skipped with a stderr warning
and counted — never silently fixed.

## Stages

1. **Dedup.** Each step is fingerprinted on normalized goal + core action
   fields (`type`, `text`, `to`/`from`, `keys`, `delta`); repeats are dropped
   and counted.
2. **Sanitize.** `redact_obj` walks every string and key: API keys, GitHub /
   Slack tokens, bearer credentials, password/secret assignments, AWS key
   assignments, and home-directory user names become `[REDACTED…]` markers.
   Keys that themselves look like secrets (`*password*`, `*token*`,
   `*api*key*`) have their values replaced wholesale. Counts land in
   `_redactions` per row.
3. **Quality filter.** Drops rows with empty goals, missing sessions, missing
   actions, or unverified grounding without a human override — each with its
   own counter. Short goals (< `--min-goal-chars`) are dropped separately.
4. **Provenance-preserving split.** Rows group by `task_id`; whole tasks are
   shuffled (seeded) into splits so no task straddles two files. Held-out
   tasks are quarantined: promotion gates consume them and training must
   never read them (`tests/benchmark-split.test.ts`).
5. **Digest.** `digest.json` records per-split row/task counts, per-file
   sha256, seed, input path, and the full filter/redaction statistics.

## Output layout

```
data/eve-v1/
  train.jsonl  val.jsonl  test.jsonl  held-out.jsonl
  digest.json
```

Downstream: `train.py` consumes `train.jsonl` (recording the split digest as
`dataset_digest`); `eval.py` scores predictions per split; the registry's
promotion gate requires test + held-out evidence from these exact files.
