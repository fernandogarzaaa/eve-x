"""train.py lineage self-test (stdlib + train entrypoint).

Proves dataset consumption binding: the same dataset file yields the same
consumed_content_digest across runs (reproducibility), a changed byte
changes it, and lineage records runtime/hardware/preprocessing/sample
counts. Absent dataset is labeled not-consumed, never a fabricated digest.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN = os.path.join(HERE, "train.py")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


def run_train(out, dataset=None, manifest=None, seed=7):
    args = [sys.executable, TRAIN, "--smoke", "--out", out, "--seed", str(seed),
            "--max-epochs", "1"]
    if dataset:
        args += ["--dataset", dataset]
    if manifest:
        args += ["--dataset-manifest", manifest]
    r = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise AssertionError(f"train.py failed: {r.stderr[-2000:]}")
    with open(os.path.join(out, "lineage.json"), encoding="utf-8") as f:
        lineage = json.load(f)
    with open(os.path.join(out, "consumption.json"), encoding="utf-8") as f:
        consumption = json.load(f)
    return lineage, consumption


def main():
    d = tempfile.mkdtemp()
    rows = os.path.join(d, "train.jsonl")
    with open(rows, "w", encoding="utf-8") as f:
        for i in range(20):
            f.write(json.dumps({"step_id": f"s-{i}", "goal": "open settings",
                                "selected_action": {"type": "click", "confidence": 0.9},
                                "screen_before": f"f-{i}", "screen_after": f"f-{i+1}"}) + "\n")
    man = os.path.join(d, "digest.json")
    with open(man, "w", encoding="utf-8") as f:
        json.dump({"splits": {"train": {"rows": 20, "sha256": "x"}}}, f)

    lin1, con1 = run_train(os.path.join(d, "out1"), rows, man)
    lin2, con2 = run_train(os.path.join(d, "out2"), rows, man)

    check("consumption recorded", con1.get("consumed") is True)
    check("sample count bound", con1.get("sample_count") == 20, str(con1.get("sample_count")))
    check("sample ids bound", len(con1.get("sample_ids", [])) == 20)
    check("manifest digest bound", isinstance(con1.get("manifest_digest"), str) and len(con1["manifest_digest"]) == 64)
    check("runtime/hardware recorded",
          "python" in con1.get("runtime", {}) and "cpu_count" in con1.get("runtime", {}))
    check("preprocessing versioned", con1.get("preprocessing") == "1")
    check("lineage carries consumed digest, not config claim",
          lin1.get("dataset_digest") == con1.get("consumed_content_digest"))
    check("reproducible: same bytes, same digest",
          con1.get("consumed_content_digest") == con2.get("consumed_content_digest"))
    check("lineage stable across runs",
          lin1.get("dataset_digest") == lin2.get("dataset_digest")
          and lin1.get("config_hash") == lin2.get("config_hash"))

    # One changed byte changes the digest.
    with open(rows, "a", encoding="utf-8") as f:
        f.write(json.dumps({"step_id": "s-20", "goal": "open settings"}) + "\n")
    _, con3 = run_train(os.path.join(d, "out3"), rows, man)
    check("changed bytes change the digest",
          con3.get("consumed_content_digest") != con1.get("consumed_content_digest"))
    check("count tracks content", con3.get("sample_count") == 21)

    # Absent dataset: labeled, never fabricated.
    lin4, con4 = run_train(os.path.join(d, "out4"))
    check("absent dataset labeled not-consumed",
          con4.get("consumed") is False and "dataset_digest" in lin4)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
