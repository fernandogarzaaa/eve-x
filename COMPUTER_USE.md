# COMPUTER_USE (Perception → Action Loop)

## Loop

Each step the worker runs: **observe → propose → ground → gate → act → record**.

1. **Observe.** `GET /v1/vms/{vmId}/screen` returns a `ComputerPercept`:
   frame id, dimensions, PNG (base64), detected regions
   (`{regionId, bbox, label, confidence}`), cursor, window/dialog lists,
   loading flag, and provenance.
2. **Propose.** The inference service (`POST /infer` with frame + goal +
   regions) returns ranked `candidate_actions` — `ActionIR` objects with
   confidence scores.
3. **Ground.** The verifier binds the selected action to a detected region:
   the region must exist, the bbox must lie inside the frame, and confidence
   must clear the 0.5 gate. Region-free actions (`wait`, `observe`,
   `terminate`) pass on confidence alone.
4. **Gate.** The policy layer denies destructive / external-comms /
   credential-adjacent actions unless the task policy opts in, and escalates
   approval-listed categories to a human.
5. **Act.** `POST /v1/vms/{vmId}/act` executes exactly one validated action
   under an idempotency key; replays collapse to a single execution.
6. **Record.** Before/after screens, the chosen action, grounding, and outcome
   append to the trace ledger as a `TraceStep`.

## Action IR

The canonical vocabulary (`protocol` `ActionType`): click, double_click,
move, drag, type, key, hotkey, scroll, wait, observe, zoom, crop,
open_application, terminal, tool, ask_human, terminate. Every action carries
`confidence` in [0,1]; `text` is capped at 4096 chars, `keys` at 8 entries,
`ms` at 60 s. Validation tests live in `tests/action-ir.test.ts`.

## Grounding details

- Coordinates are absolute frame pixels; the verifier rejects negative or
  out-of-frame boxes (`tests/verifier-grounding.test.ts`).
- `verification: {passed, reason}` travels with the action so reviewers and
  the dataset pipeline can distinguish grounded from heuristic steps.
- Unverified grounding with no human override is dropped by the dataset
  quality filter (`ml/datasets/build.py`).

## Failure handling

- Inference timeout/queue-full → worker backs off and retries the step with
  the same idempotency key; repeated failures mark the session for human
  takeover instead of looping forever.
- GPU/model failure flips inference to degraded heuristic mode; actions keep
  flowing with `degraded: true` and low confidence, which the verifier treats
  skeptically by construction.
