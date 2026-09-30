# TRAINING

Entry point: `ml/training/train.py`. Four phases run in order — SFT,
grounding head, verifier gate, preference pass — and every reported number is
measured from the loop that just ran.

## Modes

```bash
# Dependency-free smoke test (<60s, exercises all four phases on synthetic data)
python ml/training/train.py --smoke --out out/smoke

# Full run (requires pip torch CPU)
python ml/training/train.py --config ml/training/config.json --out out/run1
python ml/training/train.py --config ml/training/config.json --out out/run1 --seed 7
```

Missing torch produces a clear install message (`pip install torch` CPU
index URL) and exit code 2; `--smoke` always runs because it uses a pure-Python
toy optimizer.

## Config

JSON merged over built-in defaults (`architecture`, `hidden`, `layers`,
`seq_len`, `vocab`, `sft_steps`, `grounding_steps`, `preference_steps`, `lr`,
`seed`, `quantization`, `dataset_digest`, `parent_model_id`). The effective
config's sha256 becomes `config_hash`, the reproducibility anchor recorded in
`model.json` and `lineage.json`.

## Phases (full mode)

1. **SFT** — backbone + LM head, cross-entropy next-token loss on synthetic
   batches shaped like trace contexts.
2. **Grounding head** — bbox regression head (`sigmoid` + MSE) trained jointly
   with the LM loss; accuracy = fraction of predictions within 0.2 MAE.
3. **Verifier gate** — passes iff grounding accuracy ≥ 0.5; a failure prints a
   warning and continues so diagnostics are preserved, but the recorded
   `verifier_passed: false` blocks downstream promotion.
4. **Preference pass** — joint grounding + verifier-objective fine-tuning;
   weights persist to `weights.pt` alongside the JSON artifacts.

## Outputs (`--out`)

- `model.json` — `model_id` (derived from `config_hash`), architecture,
  quantization, seed, mode, elapsed seconds.
- `metrics.json` — per-phase steps, final/mean loss, accuracy, plus a
  `summary` rollup. Nothing is imputed.
- `lineage.json` — `config_hash`, `dataset_digest`, `code_digest` (sha256 of
  `train.py`), parent model, UTC timestamp. This is what the model registry
  stores when the version is registered.

## Registering the result

```bash
# after eval.py produces benchmark scores, register + attach evidence,
# then promote only with a human approval token (see MODEL.md)
```
