"""EVE-X inference real-torch qualification (requires torch).

Proves the artifact-verification -> torch.load -> ready path with a REAL
torch runtime (no stubs): genuine checkpoints verify and serve identity;
tampered/truncated/malformed/non-finite artifacts stay not-ready; and the
policy demonstrably consumes image regions + goal text (counterfactual
sensitivity). Run with a torch-capable interpreter:
    /root/torch-venv/bin/python ml/inference/torch_qual.py
Exit 0 pass / 1 fail / 2 torch-unavailable (honest classification).
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile

try:
    import torch  # noqa: F401
except ImportError:
    print("torch_qual: UNAVAILABLE — no torch in this interpreter")
    raise SystemExit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server as S  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


def reset_state():
    with S._state_lock:
        S._ready = False
        S._degraded = True
        S._model_id = S.HEURISTIC_POLICY_ID
        S._model_version = S.MODEL_VERSION_DEFAULT
        S._model_sha256 = None
        S._architecture = None
        S._device = "cpu"
        S._action_source = "none"
        S._weights_verified = False
        S._model_error = "not loaded yet"
        S._load_failures = 0
        S._require_token = ""


def sha_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    d = tempfile.mkdtemp()
    # 1. genuine checkpoint: verifies, loads, serves identity
    good = os.path.join(d, "good.pt")
    torch.save({"w": torch.randn(8, 8), "b": torch.zeros(4)}, good)
    digest = sha_of(good)
    size = os.path.getsize(good)
    reset_state()
    S.try_load_model(good, True, expected_sha256=digest, expected_bytes=size,
                     expected_arch="qual-test", model_id=None)
    ident = S._snapshot_identity()
    check("real torch checkpoint -> ready", ident["ready"] is True, ident["detail"])
    check("weights_verified true on real load", ident["weights_verified"] is True)
    check("model_sha256 is the measured digest", ident["model_sha256"] == digest)
    check("model_id embeds digest", digest[:16] in ident["model_id"], ident["model_id"])
    check("serving stays degraded (heuristic acts)", ident["degraded"] is True)

    # 2. single-byte tamper with a STALE pin -> refused
    with open(good, "r+b") as f:
        f.seek(100)
        b = f.read(1)
        f.seek(100)
        f.write(bytes([b[0] ^ 0xFF]))
    reset_state()
    S.try_load_model(good, True, expected_sha256=digest, expected_bytes=size)
    ident = S._snapshot_identity()
    check("tampered bytes + stale pin -> not ready", ident["ready"] is False)

    # 3. truncated file with a FRESH (correct-for-truncated) pin -> refused.
    # This is the load-beyond-hashing proof: the digest matches, but the
    # bytes do not parse as a checkpoint.
    trunc = os.path.join(d, "trunc.pt")
    torch.save({"w": torch.randn(32, 32)}, trunc)
    with open(trunc, "r+b") as f:
        f.truncate(os.path.getsize(trunc) // 2)
    tdigest = sha_of(trunc)
    reset_state()
    S.try_load_model(trunc, True, expected_sha256=tdigest)
    ident = S._snapshot_identity()
    check("truncated file, correct pin -> not ready (load, not just hash)",
          ident["ready"] is False, ident["detail"])

    # 4. valid pickle magic + garbage payload, correct pin -> refused
    garbage = os.path.join(d, "garbage.pt")
    with open(garbage, "wb") as f:
        f.write(b"\x80\x04" + os.urandom(200))
    gdigest = sha_of(garbage)
    reset_state()
    S.try_load_model(garbage, True, expected_sha256=gdigest)
    check("garbage payload, correct pin -> not ready",
          S._snapshot_identity()["ready"] is False)

    # 5. non-finite parameters -> refused
    bad = os.path.join(d, "nonfinite.pt")
    w = torch.randn(4, 4)
    w[0, 0] = float("inf")
    torch.save({"w": w}, bad)
    bdigest = sha_of(bad)
    reset_state()
    S.try_load_model(bad, True, expected_sha256=bdigest)
    check("non-finite params -> not ready", S._snapshot_identity()["ready"] is False)

    # 6. counterfactual sensitivity: the policy consumes regions + goal.
    regions_a = [{"label": "settings button", "confidence": 0.9, "bbox": [100, 100, 200, 140]}]
    regions_b = [{"label": "browser icon", "confidence": 0.9, "bbox": [500, 500, 560, 540]}]
    base = {"goal": "open settings", "width": 1280, "height": 800, "png_base64": "aGk="}
    out_a = S.pick_action({**base, "regions": regions_a})
    out_b = S.pick_action({**base, "regions": regions_b})
    check("different regions -> different targets",
          out_a.get("to") != out_b.get("to"), f"{out_a.get('to')} vs {out_b.get('to')}")
    out_c = S.pick_action({**base, "goal": "open browser", "regions": regions_a})
    check("different goal -> different selection",
          out_c.get("intent") != out_a.get("intent") or out_c.get("confidence") != out_a.get("confidence"),
          f"{out_a} vs {out_c}")
    out_empty = S.pick_action({**base, "regions": []})
    check("empty regions -> honest low-confidence recenter",
          out_empty.get("type") == "move" and out_empty.get("confidence") == 0.2)

    print(f"\ntorch_qual: device={torch.cuda.is_available() and 'cuda' or 'cpu'} "
          f"{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
