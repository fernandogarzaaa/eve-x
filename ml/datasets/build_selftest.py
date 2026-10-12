"""build.py dataset-integrity self-test (stdlib only).

Pins: frame-bound fingerprints (same action, different screens do not
dedupe), near-identical phrasing dedupes, task-grouped splits with no
cross-split leakage, label provenance blocks, and redaction. Run:
python3 ml/datasets/build_selftest.py — exit nonzero on failure.
"""
from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build.py")

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


def step(sid, tid, seq, goal, action="click", before="f-1", after="f-2", **kw):
    s = {"session_id": sid, "task_id": tid, "step_id": f"{sid}-{seq}",
         "seq": seq, "goal": goal,
         "selected_action": {"type": action, "confidence": 0.9},
         "grounding": {"verified": True},
         "screen_before": before, "screen_after": after,
         "digest": f"{'a' * 63}{seq}",
         "model_version": "m1", "environment_version": "e1"}
    s.update(kw)
    return s


def run_build(rows, **kw):
    d = tempfile.mkdtemp()
    inp = os.path.join(d, "in.jsonl")
    out = os.path.join(d, "out")
    with open(inp, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    args = [sys.executable, BUILD, "--in", inp, "--out", out,
            "--val", "0.25", "--test", "0.25", "--heldout", "0.0",
            "--seed", "7"]
    for k, v in kw.items():
        flag = f"--{k.replace('_', '-')}"
        if v is True:
            args += [flag]
        else:
            args += [flag, str(v)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode not in (0, 3):
        raise AssertionError(f"build.py failed: {r.stderr[-2000:]}")
    with open(os.path.join(out, "digest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    splits = {}
    for name in ("train", "val", "test", "held-out"):
        p = os.path.join(out, f"{name}.jsonl")
        rows_out = []
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        rows_out.append(json.loads(line))
        splits[name] = rows_out
    return manifest, splits, r.returncode


def main():
    # 1. same goal+action on DIFFERENT screens must not dedupe
    m, s, _rc = run_build([
        step("s1", "t1", 0, "Open Settings", before="f-1", after="f-2"),
        step("s1", "t1", 1, "Open Settings", before="f-9", after="f-10"),
    ], val=0, test=0, heldout=0)
    total = sum(len(v) for v in s.values())
    check("distinct visual states survive dedupe", total == 2, f"kept={total}")

    # 2. near-identical phrasing on the SAME frame dedupes
    m, s, _rc = run_build([
        step("s1", "t1", 0, "Open Settings!", before="f-1", after="f-2"),
        step("s1", "t1", 1, "open   settings", before="f-1", after="f-2"),
    ], val=0, test=0, heldout=0)
    total = sum(len(v) for v in s.values())
    check("near-identical phrasing dedupes", total == 1, f"kept={total}")

    # 3. task groups never straddle splits
    rows = []
    for t in ("tA", "tB", "tC", "tD"):
        for i in range(3):
            rows.append(step(f"s-{t}", t, i, f"Goal for {t}", before=f"f-{t}-{i}"))
    m, s, _rc = run_build(rows)
    seen = {}
    clash = []
    for name, rr in s.items():
        for r in rr:
            t = r["task_id"]
            if t in seen and seen[t] != name:
                clash.append((t, seen[t], name))
            seen[t] = name
    check("no task straddles splits", not clash, str(clash))
    check("dataset digest recorded", bool(m.get("dataset_digest")), str(m.get("dataset_digest"))[:16])

    # 4. label provenance blocks on every row
    m, s, _rc = run_build([step("s1", "t1", 0, "Open Settings")], val=0, test=0, heldout=0)
    row = s["train"][0]
    check("label block present", isinstance(row.get("_label"), dict), str(row.keys()))
    check("label source recorded", row["_label"].get("source") == "demonstration-action")
    check("frame binding recorded", row["_label"].get("frame_before") == "f-1")

    # 5. unverified grounding still filtered (quality gate intact)
    m, s, _rc = run_build([
        step("s1", "t1", 0, "Open Settings", grounding={"verified": False}),
    ], val=0, test=0, heldout=0)
    total = sum(len(v) for v in s.values())
    check("unverified grounding filtered", total == 0, f"kept={total}")

    # 6. secrets redacted
    m, s, _rc = run_build([
        step("s1", "t1", 0, "Email sk-abcdefgh12345678 to bob", before="f-1"),
    ], val=0, test=0, heldout=0)
    row = s["train"][0]
    check("secret redacted", "sk-abcdefgh12345678" not in json.dumps(row))

    # 7. pixel-identical screens with different frame IDs dedupe + bind
    def shot_png(seed):
        raw = b""
        for y in range(12):
            raw += b"\x00"
            for x in range(16):
                raw += bytes(((x * 13 + seed) % 256, (y * 17 + seed) % 256, 128))
        ihdr = struct.pack(">IIBBBBB", 16, 12, 8, 2, 0, 0, 0)

        def chunk(tag, body):
            return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

        return base64.b64encode(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
                                + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")).decode()

    pix = shot_png(5)
    r1 = step("s1", "t1", 0, "Open Settings", before="f-1", after="f-2")
    r1["png_base64"] = pix
    r2 = step("s1", "t1", 1, "Open Settings", before="f-9", after="f-10")
    r2["png_base64"] = pix
    m, s, _rc = run_build([r1, r2], val=0, test=0, heldout=0)
    total = sum(len(v) for v in s.values())
    check("pixel-identical screens dedupe across frame IDs", total == 1, f"kept={total}")
    row = s["train"][0]
    check("visual identity recorded", isinstance(row.get("_visual"), dict)
          and "visual_sha256" in row["_visual"], str(row.get("_visual")))

    # 8. pixel-identical screens straddling splits fail the build
    rows = []
    for t in ("tA", "tB", "tC", "tD", "tE", "tF"):
        r = step(f"s-{t}", t, 0, f"Goal for {t}", before=f"f-{t}-0")
        r["png_base64"] = pix
        rows.append(r)
    m, s, rc = run_build(rows)
    check("cross-split pixel identity fails closed",
          rc == 3 and m["visual_leakage"]["count"] > 0,
          f"rc={rc} leaks={m['visual_leakage']['count']}")
    m2, _, rc2 = run_build(rows, allow_visual_leak=True)
    check("explicit allow-flag records instead of failing",
          rc2 == 0 and m2["visual_leakage"]["count"] > 0)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
