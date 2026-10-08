# MODEL (Registry & Version Records)

`packages/model-registry` is the system of record for every model that can
serve inference. Records live as JSON files under `<registry>/records/` with
weight blobs under `<registry>/weights/`; an S3-compatible bucket mirrors
them when configured.

## Serving runtime (ModelRuntime, `ml/inference/server.py`)

Weights are verified before they serve: existence, byte size, SHA-256,
container format (safetensors/torch), manifest agreement, then a real torch
load with a parameter census (non-empty, finite). Any failure leaves the
plane not-ready (`/ready` 503, `/infer` 503 `model-not-loaded`) — arbitrary
bytes are never called a loaded model.

Readiness truth table: verified weights → `ready=true, degraded=true`
(actions still come from the explicit `heuristic-v1` policy, named in
`action_source`); no weights + `--allow-heuristic` → `ready=true,
degraded=true` (dev/test only); anything else → not ready. `degraded=false`
is unreachable until a model-forward action path exists.

Every inference result identifies `model_id`, `model_version`,
`model_sha256`, `architecture`, `device`, `action_source`, `degraded`,
`weights_verified`, `latency_ms`, `frame_id`. `/model-info` reports the
same identity; `/infer` + `/model-info` require bearer auth when
`EVEX_INFERENCE_TOKEN` is set. The plane binds loopback by default and
stays on the internal compose network (no published port).

## Record shape

```json
{
  "modelId": "model-a1b2c3d4",
  "version": "0.3.0",
  "architecture": "cua-small",
  "weights": { "uri": "file:weights/...", "sha256": "…", "bytes": 0, "quantization": "none" },
  "lineage": { "configHash": "…", "datasetDigest": "…", "codeDigest": "…",
               "parentModelId": null, "trainedAt": "…", "trainedBy": "…" },
  "benchmarks": [ { "benchmark": "eve-ground-v1", "split": "test",
                    "successRate": 0.9, "groundingAccuracy": 0.9,
                    "recoveryRate": 0.7, "samples": 50, "digest": "…", "at": "…" } ],
  "config": { "lr": 0.001 },
  "compat": { "protocolVersion": "1", "mcpVersion": "evex-tools/1", "minApiVersion": "v1" },
  "runtime": { "accelerator": "cpu", "minVramMb": 0, "minRamMb": 2048,
               "maxLatencyMs": 15000, "maxQueueDepth": 32 },
  "stage": "experimental"
}
```

Architectures: `vit-ground`, `cua-small`, `cua-base`, `cua-large`,
`world-lstm`, `verifier-xgb`. Quantization: `none`, `fp16`, `int8`, `int4`.
Stages: `experimental` → `staging` → `production`, plus `retired`.

## Lifecycle API

- `createRecord(input)` — mints a `modelId`, stamps lineage, starts at
  `experimental`.
- `recordBenchmark(modelId, score)` — appends a measured score produced by
  `ml/evaluation/eval.py`. The registry never computes scores itself.
- `promote(modelId, target, gate, benchmark)` — gated transition:
  - `experimental` → `staging` → `production` only, in order;
  - a human `approvalToken` (≥ 8 chars) is mandatory — there is no automatic
    path and no background job that calls promote;
  - the named benchmark must clear `minSuccessRate`, `minGroundingAccuracy`,
    `minRecoveryRate` on the **test** split, and (by default) on **held-out**.
  - every refusal throws with the concrete reason.
- `retire(modelId)`, `checkCompat(...)`, `storeWeightsLocal(...)`,
  `pushRecordToObjects` / `pullRecordFromObjects` (plain-fetch S3, no SDK).

## Compatibility

`checkCompat` compares the client's protocol/MCP/API triple against the
record; mismatches return structured reasons so the worker can refuse to load
an incompatible model instead of failing mid-task.
