# Deterministic replay

Every step records `seq`, `candidate_actions`, `selected_action`,
`screen_before`/`screen_after`, and provenance. Replay re-checks the stored
trace for continuity:

```bash
node skills/eve-computer/scripts/replay.mjs <sessionId>
# → POST /v1/replay/{sessionId} → {sessionId, replayed, verdict, issues}
```

Or via MCP: `eve_replay({ sessionId })`.

Verdicts: `deterministic-replay-ok` means seqs are contiguous from 0 with no
duplicates or digest-chain breaks. `replay-divergent` lists the offending
`issues` (gaps, duplicates, missing fields) — inspect those frames before
trusting the run. Replay never touches the live VM.
