"""EVE-X benchmark evaluation runner.

Loads a benchmark registry JSON (task list + split assignments) plus a model
predictions JSONL file, computes grounding accuracy / task success / recovery
rate strictly from those inputs, and writes an artifact JSON with digests.

It never fabricates numbers: missing predictions are counted as failures and
reported, never imputed; unknown task ids in predictions are reported and
ignored for scoring.

Usage:
    python ml/evaluation/eval.py --registry benchmarks/registry.json \\
        --predictions out/preds.jsonl --benchmark eve-ground-v1 --split test \\
        --out out/eval.json
Registry format:
    {"benchmark": "name", "tasks": [{"task_id": ..., "split": "test",
      "goal": ..., "expect": {"success": true, "bbox": [x1,y1,x2,y2]}}]}
Predictions format (JSONL, one per line):
    {"task_id": ..., "step_id": ..., "bbox": [x1,y1,x2,y2] | null,
     "success": true|false, "recovered": true|false, "step": n, "total_steps": m}
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def iou(a: list, b: list) -> float:
    try:
        ax1, ay1, ax2, ay2 = (float(v) for v in a)
        bx1, by1, bx2, by2 = (float(v) for v in b)
    except (TypeError, ValueError):
        return 0.0
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    aa = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    bb = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = aa + bb - inter
    return inter / union if union > 0 else 0.0


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="EVE-X benchmark eval runner")
    ap.add_argument("--registry", required=True)
    ap.add_argument("--predictions", required=True)
    ap.add_argument("--benchmark", required=True)
    ap.add_argument("--split", required=True, choices=["train", "val", "test", "held-out"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--iou-threshold", type=float, default=0.5)
    args = ap.parse_args(argv)

    with open(args.registry, "r", encoding="utf-8") as f:
        reg = json.load(f)
    if not isinstance(reg, dict) or not isinstance(reg.get("tasks"), list):
        raise SystemExit("ERROR: registry must be {benchmark, tasks: [...]}")
    tasks = [t for t in reg["tasks"]
             if isinstance(t, dict) and t.get("split") == args.split]
    if not tasks:
        raise SystemExit(f"ERROR: no tasks for split={args.split} in registry")

    preds_by_task: dict[str, list[dict]] = {}
    pred_lines = 0
    with open(args.predictions, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            pred_lines += 1
            try:
                p = json.loads(line)
            except json.JSONDecodeError:
                print(f"WARN predictions line {ln}: invalid JSON, counted as failure input",
                      file=sys.stderr)
                continue
            if isinstance(p, dict) and p.get("task_id") is not None:
                preds_by_task.setdefault(str(p["task_id"]), []).append(p)

    known = {str(t.get("task_id")) for t in tasks}
    unknown_ids = sorted(set(preds_by_task) - known)
    ground_hits = 0
    ground_total = 0
    success = 0
    recovery_ok = 0
    recovery_total = 0
    missing = 0
    per_task = []
    for t in tasks:
        tid = str(t.get("task_id"))
        expect = t.get("expect") if isinstance(t.get("expect"), dict) else {}
        preds = preds_by_task.get(tid, [])
        if not preds:
            missing += 1
            per_task.append({"task_id": tid, "status": "missing",
                             "success": False, "grounded": False})
            continue
        # Grounding: best IoU over predicted bboxes vs expected bbox.
        exp_box = expect.get("bbox")
        best = 0.0
        for p in preds:
            if isinstance(p.get("bbox"), list) and isinstance(exp_box, list):
                best = max(best, iou(p["bbox"], exp_box))
        if isinstance(exp_box, list):
            ground_total += 1
            hit = best >= args.iou_threshold
            ground_hits += 1 if hit else 0
        else:
            hit = True  # no bbox expectation: grounding not applicable, not counted
        ok = any(p.get("success") is True for p in preds)
        success += 1 if ok else 0
        # Recovery: among tasks with an early failure flag that later succeed.
        failed_first = any(p.get("success") is False for p in preds)
        if failed_first:
            recovery_total += 1
            rec = ok and any(p.get("recovered") is True for p in preds)
            recovery_ok += 1 if rec else 0
        per_task.append({"task_id": tid, "status": "scored", "success": ok,
                         "grounded": hit, "best_iou": best,
                         "predictions": len(preds)})

    total = len(tasks)
    artifact = {
        "benchmark": args.benchmark,
        "split": args.split,
        "samples": total,
        "metrics": {
            "grounding_accuracy": (ground_hits / ground_total) if ground_total else 0.0,
            "grounding_hits": ground_hits,
            "grounding_total": ground_total,
            "success_rate": success / total if total else 0.0,
            "successes": success,
            "recovery_rate": (recovery_ok / recovery_total) if recovery_total else 0.0,
            "recovery_ok": recovery_ok,
            "recovery_total": recovery_total,
            "missing_predictions": missing,
            "unknown_task_ids_ignored": unknown_ids,
        },
        "per_task": per_task,
        "provenance": {
            "registry": os.path.abspath(args.registry),
            "registry_sha256": sha256_file(args.registry),
            "predictions": os.path.abspath(args.predictions),
            "predictions_sha256": sha256_file(args.predictions),
            "prediction_lines": pred_lines,
            "iou_threshold": args.iou_threshold,
            "evaluated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }
    digest = hashlib.sha256(json.dumps(artifact, sort_keys=True).encode()).hexdigest()
    artifact["digest"] = digest
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(artifact, f, indent=2)
    m = artifact["metrics"]
    print(f"done benchmark={args.benchmark} split={args.split} n={total} "
          f"success={m['success_rate']:.3f} grounding={m['grounding_accuracy']:.3f} "
          f"recovery={m['recovery_rate']:.3f} missing={missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
