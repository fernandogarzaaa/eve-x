# EVE-X ML

`training/train.py` runs SFT + grounding head + verifier gate + preference
pass. `datasets/build.py` turns traces into datasets; `evaluation/eval.py`
scores runs; `inference/server.py` serves actions over HTTP (`/health`,
`/ready`, `/metrics`, `POST /infer`).

## Quick start

```bash
pip install -r ml/requirements.txt        # full training (torch CPU)
python ml/training/train.py --smoke --out out/smoke   # stdlib only, <60s
python ml/training/train.py --smoke --out out/run --max-epochs 3
python ml/training/train.py --smoke --out out/more --resume-from out/run --max-epochs 5
```

## Resume + epochs

- `--max-epochs N` trains N total epochs (default 1).
- `--resume-from DIR` continues DIR's run to `--max-epochs` total epochs.
  The config hash must match or training refuses (exit 2).
- Every write is atomic (tmp file + rename); `checkpoint.json` is flushed
  after each epoch and on SIGINT (exit 130), so a killed run stays resumable.

## SIGINT test procedure (manual)

```bash
# 1. Start a long run in the background (big step counts keep it alive)
echo '{"sft_steps":1000000,"grounding_steps":100000,"preference_steps":100000}' > /tmp/big.json
python ml/training/train.py --smoke --out out/sigint --config /tmp/big.json &
PID=$!
sleep 3
# 2. Interrupt it the way Ctrl+C does
kill -INT $PID   # Windows: taskkill /PID $PID
wait $PID; echo "exit=$?"   # expect 130
# 3. The checkpoint must still be loadable JSON
python -c "import json; d=json.load(open('out/sigint/checkpoint.json')); print(d['epochs_completed'], d['config_hash'][:12])"
# 4. Resume continues to completion
python ml/training/train.py --smoke --out out/sigint2 --resume-from out/sigint --max-epochs 1
```

Honesty rule: every number in `metrics.json` is measured from the loop that
wrote it — the pipeline never imputes or fabricates metrics.
