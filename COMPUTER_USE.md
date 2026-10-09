# COMPUTER_USE (Perception → Action Loop)

## Loop

The production worker ORCHESTRATES this loop through the control plane —
it never synthesizes perception or verification itself. Each step:
**observe → propose → ground → gate → act → record**.

1. **Observe.** `GET /v1/computer/{sessionId}/observe` returns a
   `ComputerPercept`: frame id, dimensions, PNG (base64), detected regions
   (`{regionId, bbox, label, confidence}`), cursor, window/dialog lists,
   loading flag, and provenance. The `frameId` anchors everything after it.
2. **Propose.** The inference service (`POST /v1/computer/{sessionId}/suggest`
   → inference `POST /infer` with frame + goal + regions) returns an action
   with full model identity (`model_id/version/sha256`, `degraded`).
3. **Ground.** The verifier binds the selected action to a detected region
   of the EXACT observed frame: the region must exist, the point must fall
   inside its bbox, and the frame must be current (stale `frameId` → 409).
   Region-free actions (`wait`, `observe`, `terminate`) pass without
   pointing. Ungrounded pointing is recorded `verified: false`, never
   upgraded.
4. **Gate.** The policy layer denies destructive / external-comms /
   credential-adjacent actions unless the task policy opts in, and escalates
   approval-listed categories to a human.
5. **Act.** `POST /v1/computer/{sessionId}/act` executes exactly one
   validated action against the grounded `frameId` under an idempotency key;
   replays collapse to a single execution; failures never advance the
   trajectory.
6. **Record.** Before/after frames, the chosen action, server-written
   grounding and execution verification, and outcome append to the
   SHA-256-chained trace ledger as a `TraceStep` (control-plane stamped).

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
