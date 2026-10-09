"""EVE-X benchmark evaluation runner (eval-v2 scoring).

Loads a benchmark registry JSON (task list + split assignments) plus a model
predictions JSONL file, scores them, and writes an artifact JSON with digests.

Scoring rules (scientific integrity over point estimates):

* DECISION-POINT GROUNDING: credit is computed for the ACTED prediction
  only — never best-bbox across arbitrary predictions. A task with a single
  prediction scores that lone decision. A task with several predictions must
  mark exactly one with "acted": true; otherwise grounding is INDETERMINATE
  (reported, excluded from the grounding denominator, never credited).
* VERIFIED SUCCESS: a task counts as success only for success:true backed by
  verified:true (independent server-side verification). success:true with
  verified:false is CONTRADICTED (failure). success:true with no
  verification evidence is UNVERIFIED (inconclusive — uncertainty is never
  collapsed into success or silently discarded).
* TEMPORAL RECOVERY: a failure at step i counts as recovered only with a
  later verified success AND a recovered:true marker LINKING them
  (first_fail < marker <= first later success). Floating markers do not
  link (failure -> corrective behavior -> later success, evidentially linked).
* TWO SUCCESS RATES, both labeled: success_rate over ALL samples (missing
  counts as failure — the headline) and scored_success_rate over scored
  tasks only. Missing tasks can never inflate the headline.
* INCONCLUSIVE is a UNION of task ids (missing/indeterminate/unverified):
  one task counts once, never twice. Tasks without a bbox expectation
  record grounded:null (not True) so per-task averaging cannot inflate.
* MISSING/INVALID/UNKNOWN: tasks with no predictions are inconclusive
  (missing, reported — not scored as failures); malformed JSONL lines are
  invalid (counted, attributed when a task_id is recoverable); predictions
  for unknown task ids are reported and ignored for scoring, never imputed.

It never fabricates numbers: every metric is computed from the inputs above.

Usage:
    python ml/evaluation/eval.py --registry benchmarks/registry.json \\
        --predictions out/preds.jsonl --benchmark eve-ground-v1 --split test \\
        --out out/eval.json
Registry format:
    {"benchmark": "name", "tasks": [{"task_id": ..., "split": "test",
      "goal": ..., "expect": {"success": true, "bbox": [x1,y1,x2,y2]}}]}
Predictions format (JSONL, one per line):
    {"task_id": ..., "step_id": ..., "bbox": [x1,y1,x2,y2] | null,
     "acted": true, "success": true|false, "verified": true|false|null,
     "recovered": true|false, "step": n, "total_steps": m}
Only task_id is required; acted/verified/step default to null and are
treated as absent evidence (see rules above).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

SCORING_RULES = "eval-v2/decision-point+verified-success+temporal-recovery"


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


def step_no(p: dict) -> float:
    try:
        return float(p.get("step", 0))
    except (TypeError, ValueError):
        return 0.0


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
    invalid_lines = 0
    with open(args.predictions, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            pred_lines += 1
            try:
                p = json.loads(line)
            except json.JSONDecodeError:
                invalid_lines += 1
                print(f"WARN predictions line {ln}: invalid JSON, counted as invalid input",
                      file=sys.stderr)
                continue
            if isinstance(p, dict) and p.get("task_id") is not None:
                preds_by_task.setdefault(str(p["task_id"]), []).append(p)
            else:
                invalid_lines += 1
                print(f"WARN predictions line {ln}: no task_id, counted as invalid input",
                      file=sys.stderr)

    known = {str(t.get("task_id")) for t in tasks}
    unknown_ids = sorted(set(preds_by_task) - known)
    ground_hits = 0
    ground_total = 0
    indeterminate = 0
    success = 0
    scored = 0
    unverified_successes = 0
    contradicted = 0
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
        scored += 1
        ordered = sorted(preds, key=step_no)
        # Decision-point grounding: the acted prediction, or the lone
        # prediction when unambiguous. Anything else is indeterminate.
        acted = [p for p in ordered if p.get("acted") is True]
        decision = None
        det_status = "scored"
        if len(acted) == 1:
            decision = acted[0]
        elif len(ordered) == 1 and not acted:
            decision = ordered[0]
        else:
            det_status = "indeterminate"
            indeterminate += 1
        exp_box = expect.get("bbox")
        best = 0.0
        hit = False
        if isinstance(exp_box, list) and decision is not None:
            if isinstance(decision.get("bbox"), list):
                best = iou(decision["bbox"], exp_box)
            ground_total += 1
            hit = best >= args.iou_threshold
            ground_hits += 1 if hit else 0
        elif not isinstance(exp_box, list):
            hit = None  # no bbox expectation: grounding not applicable (null, not True — averaging must skip)
        # Verified success: success:true needs verified:true. Contradicted
        # (verified:false) is failure; absent verification is inconclusive.
        succ_flags = [p.get("success") is True for p in ordered]
        ver_flags = [p.get("verified") for p in ordered]
        verified_ok = any(s and v is True for s, v in zip(succ_flags, ver_flags))
        contradicted_here = any(s and v is False for s, v in zip(succ_flags, ver_flags))
        unverified_here = any(succ_flags) and not verified_ok and not contradicted_here
        if verified_ok:
            ok = True
            success += 1
        elif contradicted_here:
            ok = False
            contradicted += 1
        elif unverified_here:
            ok = False
            unverified_successes += 1
        else:
            ok = False
        # Temporal recovery: a failure at step i, then a later verified
        # success, with a recovered:true marker LINKING them (between the
        # failure and the first later success). A floating marker elsewhere
        # does not establish recovery.
        fail_steps = [step_no(p) for p in ordered if p.get("success") is False]
        succ_steps = [step_no(p) for p in ordered if p.get("success") is True and p.get("verified") is True]
        rec_steps = [step_no(p) for p in ordered if p.get("recovered") is True]
        if fail_steps:
            recovery_total += 1
            first_fail = min(fail_steps)
            later_succ = [s for s in succ_steps if s > first_fail]
            linked = bool(later_succ) and any(first_fail < r <= min(later_succ) for r in rec_steps)
            recovery_ok += 1 if linked else 0
        status = det_status
        if det_status == "scored" and unverified_here:
            status = "unverified"
        per_task.append({"task_id": tid, "status": status, "success": ok,
                         "grounded": hit, "best_iou": best,
                         "predictions": len(preds)})

    total = len(tasks)
    # Union of non-scored task ids: a task that is both indeterminate AND
    # unverified counts once (no double-counting of uncertainty).
    inconclusive_tasks = sorted({p["task_id"] for p in per_task if p.get("status") != "scored"})
    artifact = {
        "benchmark": args.benchmark,
        "split": args.split,
        "samples": total,
        "scoring_rules": SCORING_RULES,
        "metrics": {
            "grounding_accuracy": (ground_hits / ground_total) if ground_total else 0.0,
            "grounding_hits": ground_hits,
            "grounding_total": ground_total,
            "grounding_basis": "task-decision",
            "indeterminate_grounding": indeterminate,
            # Two success rates, both labeled: scored-only (comparable runs)
            # and over-all-samples (missing counts as failure). The headline
            # is total_success_rate — scored-only inflates when hard tasks
            # go missing.
            "success_rate": success / total if total else 0.0,
            "scored_success_rate": success / scored if scored else 0.0,
            "successes": success,
            "scored_total": scored,
            "unverified_successes": unverified_successes,
            "contradicted": contradicted,
            "inconclusive": len(inconclusive_tasks),
            "inconclusive_task_ids": inconclusive_tasks,
            "missing_predictions": missing,
            "invalid_lines": invalid_lines,
            "recovery_rate": (recovery_ok / recovery_total) if recovery_total else 0.0,
            "recovery_ok": recovery_ok,
            "recovery_total": recovery_total,
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
          f"success_total={m['success_rate']:.3f} success_scored={m['scored_success_rate']:.3f} "
          f"grounding={m['grounding_accuracy']:.3f} "
          f"recovery={m['recovery_rate']:.3f} missing={missing} "
          f"inconclusive={m['inconclusive']} invalid={invalid_lines}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
