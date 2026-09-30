# MODEL (Registry & Version Records)

`packages/model-registry` is the system of record for every model that can
serve inference. Records live as JSON files under `<registry>/records/` with
weight blobs under `<registry>/weights/`; an S3-compatible bucket mirrors
them when configured.

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
  "compat": { "protocolVersion": "1", "mcpVersion": "mcp/1", "minApiVersion": "v1" },
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
