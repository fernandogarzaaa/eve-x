# Deterministic replay

Every step records `seed`, `candidate_actions`, `selected_action`, and
`screens`. Replay re-runs the trace with the same seed:

```text
eve_replay(sessionId, seed=42) → { replayed, verdict }
```

Verdicts: `deterministic-replay-ok` means every reselected action matched the
recorded one. Mismatches list diverging `seq` numbers — inspect those frames
before trusting the run. Replay never touches the live VM.
