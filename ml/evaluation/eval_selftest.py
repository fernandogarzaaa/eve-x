"""eval.py scoring-rule self-test (stdlib only).

Pins eval-v2 semantics: decision-point grounding, verified success,
temporal recovery, and inconclusive/invalid accounting. Run:
python3 ml/evaluation/eval_selftest.py — exit nonzero on failure.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
EVAL = os.path.join(HERE, "eval.py")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


def run_eval(registry, preds):
    d = tempfile.mkdtemp()
    reg = os.path.join(d, "registry.json")
    pr = os.path.join(d, "preds.jsonl")
    out = os.path.join(d, "eval.json")
    with open(reg, "w", encoding="utf-8") as f:
        json.dump(registry, f)
    with open(pr, "w", encoding="utf-8") as f:
        for p in preds:
            f.write((p if isinstance(p, str) else json.dumps(p)) + "\n")
    r = subprocess.run([sys.executable, EVAL, "--registry", reg,
                        "--predictions", pr, "--benchmark", "t",
                        "--split", "test", "--out", out],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"eval.py failed: {r.stderr[-2000:]}")
    with open(out, encoding="utf-8") as f:
        return json.load(f)


BOX = [10, 10, 110, 110]
REG = {"benchmark": "t", "tasks": [
    {"task_id": "t1", "split": "test", "goal": "click ok",
     "expect": {"success": True, "bbox": BOX}},
    {"task_id": "t2", "split": "test", "goal": "click cancel",
     "expect": {"success": True, "bbox": BOX}},
]}


def main():
    # 1. lone decision prediction scores (compat with single-pred producers)
    a = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX,
         "success": True, "verified": True, "step": 0},
        {"task_id": "t2", "step_id": "s0", "bbox": [5000, 5000, 5100, 5100],
         "success": False, "step": 0},
    ])
    check("lone decision grounding exact hit", a["metrics"]["grounding_hits"] == 1,
          json.dumps(a["metrics"]))
    check("verified success counts", a["metrics"]["successes"] == 1,
          json.dumps(a["metrics"]))

    # 2. best-bbox gaming is dead: multi-pred without acted marker is indeterminate
    b = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": [5000, 5000, 5100, 5100], "step": 0},
        {"task_id": "t1", "step_id": "s1", "bbox": BOX, "step": 1},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("unmarked multi-pred is indeterminate, not credited",
          b["metrics"]["indeterminate_grounding"] == 1 and b["metrics"]["grounding_hits"] == 1,
          json.dumps(b["metrics"]))

    # 3. acted marker selects the decision (a miss on the acted pred fails)
    c = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX, "step": 0},
        {"task_id": "t1", "step_id": "s1", "bbox": [5000, 5000, 5100, 5100],
         "acted": True, "step": 1},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("acted miss is a miss despite a good non-acted bbox",
          c["metrics"]["grounding_hits"] == 1, json.dumps(c["metrics"]))

    # 4. unverified success is inconclusive, never headline success
    d = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX, "success": True, "step": 0},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("unverified success excluded from headline rate",
          d["metrics"]["successes"] == 0 and d["metrics"]["unverified_successes"] == 1,
          json.dumps(d["metrics"]))
    check("unverified counted inconclusive",
          d["metrics"]["inconclusive"] >= 1, json.dumps(d["metrics"]))

    # 5. contradicted success (verified:false) is failure
    e = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX,
         "success": True, "verified": False, "step": 0},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("contradicted success is failure",
          e["metrics"]["contradicted"] == 1 and e["metrics"]["successes"] == 0,
          json.dumps(e["metrics"]))

    # 6. temporal recovery: failure -> later verified success + later marker
    f = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX,
         "success": False, "step": 0},
        {"task_id": "t1", "step_id": "s1", "bbox": BOX,
         "success": True, "verified": True, "recovered": True, "step": 2},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("temporal recovery credited",
          f["metrics"]["recovery_ok"] == 1 and f["metrics"]["recovery_total"] == 1,
          json.dumps(f["metrics"]))

    # 7. marker BEFORE the failure does not link (no time travel)
    g = run_eval(REG, [
        {"task_id": "t1", "step_id": "s0", "bbox": BOX,
         "success": True, "verified": True, "recovered": True, "step": 0},
        {"task_id": "t1", "step_id": "s1", "bbox": BOX, "success": False, "step": 1},
        {"task_id": "t2", "step_id": "s0", "bbox": BOX, "step": 0},
    ])
    check("pre-failure marker does not credit recovery",
          g["metrics"]["recovery_ok"] == 0 and g["metrics"]["recovery_total"] == 1,
          json.dumps(g["metrics"]))

    # 8. missing + invalid + unknown accounting
    h = run_eval(
        {"benchmark": "t", "tasks": REG["tasks"] + [
            {"task_id": "t3", "split": "test", "goal": "x",
             "expect": {"success": True, "bbox": BOX}}]},
        [{"task_id": "t1", "step_id": "s0", "bbox": BOX, "step": 0},
         "not json at all",
         {"task_id": "ghost", "step_id": "s9", "bbox": BOX, "step": 0}])
    check("missing is inconclusive, not failure-scored",
          h["metrics"]["missing_predictions"] == 2 and h["metrics"]["scored_total"] == 1,
          json.dumps(h["metrics"]))
    check("headline rate counts missing as failure",
          h["metrics"]["success_rate"] == 0.0, json.dumps(h["metrics"]))
    check("invalid lines counted", h["metrics"]["invalid_lines"] == 1,
          json.dumps(h["metrics"]))
    check("unknown ids reported + ignored",
          h["metrics"]["unknown_task_ids_ignored"] == ["ghost"],
          json.dumps(h["metrics"]))

    # 9. dual rates: scored-only never inflates the headline
    i = run_eval(
        {"benchmark": "t", "tasks": REG["tasks"] + [
            {"task_id": "t3", "split": "test", "goal": "x",
             "expect": {"success": True, "bbox": BOX}}]},
        [{"task_id": "t1", "step_id": "s0", "bbox": BOX,
          "success": True, "verified": True, "step": 0}])
    check("scored rate 1.0 with missing present",
          i["metrics"]["scored_success_rate"] == 1.0, json.dumps(i["metrics"]))
    check("headline rate diluted by missing",
          abs(i["metrics"]["success_rate"] - 1 / 3) < 1e-9, json.dumps(i["metrics"]))

    # 10. union: one task, indeterminate + unverified, counts once
    j = run_eval(
        {"benchmark": "t", "tasks": [REG["tasks"][0]]},
        [{"task_id": "t1", "step_id": "s0", "bbox": BOX, "success": True, "step": 0},
         {"task_id": "t1", "step_id": "s1", "bbox": BOX, "success": True, "step": 1}])
    check("inconclusive union counts the task once",
          j["metrics"]["inconclusive"] == 1, json.dumps(j["metrics"]))
    check("unverified + indeterminate both visible",
          j["metrics"]["unverified_successes"] == 1 and j["metrics"]["indeterminate_grounding"] == 1,
          json.dumps(j["metrics"]))

    # 11. no bbox expectation -> grounded null (not True)
    k = run_eval(
        {"benchmark": "t", "tasks": [
            {"task_id": "t1", "split": "test", "goal": "x", "expect": {"success": True}}]},
        [{"task_id": "t1", "step_id": "s0", "success": True, "verified": True, "step": 0}])
    check("no-bbox grounded is null",
          k["per_task"][0]["grounded"] is None, json.dumps(k["per_task"]))
    check("no-bbox excluded from grounding denominator",
          k["metrics"]["grounding_total"] == 0, json.dumps(k["metrics"]))

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
