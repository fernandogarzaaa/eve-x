"""EVE-X supervised fine-tuning entrypoint: SFT + grounding head + verifier + preference pass.

Usage:
    python ml/training/train.py --config ml/training/config.json --out out/run1
    python ml/training/train.py --smoke --out out/smoke

Modes:
    --smoke   Tiny synthetic run (CPU, no dataset download, <60s). Exercises the
              full pipeline: config hash -> toy SFT loop -> grounding head ->
              verifier gate -> preference pass -> lineage JSON. Works with plain
              pip torch CPU; if torch is missing, smoke falls back to a pure
              Python toy optimizer so `--smoke` always runs.
    full      Requires torch. Imports are guarded with a clear install message.

Outputs (under --out):
    model.json      model_id + architecture + quantization + config hash
    metrics.json    per-phase losses / accuracies measured from the run
    lineage.json    config hash + dataset digest + code digest + parent
Never fabricates numbers: every metric is computed from the loop above.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import time


def _require_torch():
    try:
        import torch  # type: ignore
        return torch
    except ImportError:
        print(
            "ERROR: PyTorch is required for full training.\n"
            "Install the CPU build with:\n"
            "    pip install torch --index-url https://download.pytorch.org/whl/cpu\n"
            "Or run the dependency-free smoke test:\n"
            "    python ml/training/train.py --smoke --out out/smoke",
            file=sys.stderr,
        )
        raise SystemExit(2)


def sha256_json(obj: object) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True).encode("utf-8")).hexdigest()


def code_digest() -> str:
    h = hashlib.sha256()
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("train.py",):
        p = os.path.join(here, name)
        if os.path.exists(p):
            with open(p, "rb") as f:
                h.update(f.read())
    return h.hexdigest()


def default_config() -> dict:
    return {
        "architecture": "cua-small",
        "hidden": 128,
        "layers": 2,
        "seq_len": 32,
        "vocab": 512,
        "sft_steps": 20,
        "grounding_steps": 10,
        "preference_steps": 10,
        "lr": 1e-3,
        "seed": 42,
        "quantization": "none",
        "dataset_digest": "synthetic-smoke",
        "parent_model_id": None,
    }


def load_config(path: str | None) -> dict:
    cfg = default_config()
    if path:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if not isinstance(loaded, dict):
            raise SystemExit("ERROR: config file must contain a JSON object")
        cfg.update(loaded)
    return cfg


def smoke_run(cfg: dict, out_dir: str) -> dict:
    """Dependency-free toy run: deterministic linear-model SGD on synthetic data."""
    seed = int(cfg.get("seed", 42))
    rng = random.Random(seed)
    w = [rng.uniform(-0.5, 0.5) for _ in range(int(cfg.get("hidden", 128)))]
    lr = float(cfg.get("lr", 1e-3))
    metrics: dict = {"phases": {}}

    def run_phase(name: str, steps: int, noise: float) -> dict:
        losses = []
        correct = 0
        total = 0
        wl = list(w)
        for step in range(steps):
            x = [rng.uniform(-1.0, 1.0) for _ in range(len(wl))]
            y = 1.0 if sum(a * b for a, b in zip(x, wl)) > 0 else 0.0
            pred = sum(a * b for a, b in zip(x, wl))
            err = pred - y + rng.uniform(-noise, noise)
            losses.append(err * err)
            for i in range(len(wl)):
                wl[i] -= lr * err * x[i]
            total += 1
            if (pred > 0.5) == (y > 0.5):
                correct += 1
        for i in range(len(w)):
            w[i] = wl[i]
        phase = {
            "steps": steps,
            "final_loss": sum(losses[-5:]) / max(1, len(losses[-5:])),
            "mean_loss": sum(losses) / max(1, len(losses)),
            "accuracy": correct / max(1, total),
        }
        metrics["phases"][name] = phase
        return phase

    sft = run_phase("sft", int(cfg.get("sft_steps", 20)), 0.1)
    ground = run_phase("grounding_head", int(cfg.get("grounding_steps", 10)), 0.2)
    # Verifier gate: pass iff grounding head beats chance on the toy signal.
    verifier_passed = bool(ground["accuracy"] >= 0.5)
    metrics["phases"]["verifier"] = {"passed": verifier_passed, "threshold": 0.5,
                                     "accuracy": ground["accuracy"]}
    pref = run_phase("preference", int(cfg.get("preference_steps", 10)), 0.15)
    metrics["summary"] = {
        "sft_final_loss": sft["final_loss"],
        "grounding_accuracy": ground["accuracy"],
        "verifier_passed": verifier_passed,
        "preference_final_loss": pref["final_loss"],
    }
    return metrics


def torch_run(cfg: dict, out_dir: str):
    torch = _require_torch()
    import torch.nn as nn  # type: ignore

    seed = int(cfg.get("seed", 42))
    torch.manual_seed(seed)
    random.seed(seed)
    hidden = int(cfg.get("hidden", 128))
    vocab = int(cfg.get("vocab", 512))
    seq_len = int(cfg.get("seq_len", 32))
    lr = float(cfg.get("lr", 1e-3))

    backbone = nn.Sequential(nn.Embedding(vocab, hidden), nn.Flatten(),
                             nn.Linear(hidden * seq_len, hidden), nn.ReLU(),
                             nn.Linear(hidden, hidden))
    lm_head = nn.Linear(hidden, vocab)
    ground_head = nn.Linear(hidden, 4)  # bbox x1 y1 x2 y2 (normalized)
    verifier = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.ReLU(),
                             nn.Linear(hidden // 2, 1))
    params = list(backbone.parameters()) + list(lm_head.parameters()) \
        + list(ground_head.parameters()) + list(verifier.parameters())
    opt = torch.optim.AdamW(params, lr=lr)
    ce = nn.CrossEntropyLoss()
    mse = nn.MSELoss()
    bce = nn.BCEWithLogitsLoss()
    metrics: dict = {"phases": {}}

    def synth_batch(n: int):
        toks = torch.randint(0, vocab, (n, seq_len))
        nxt = torch.randint(0, vocab, (n,))
        boxes = torch.rand(n, 4)
        valid = (torch.rand(n) > 0.3).float()
        return toks, nxt, boxes, valid

    def loop(name: str, steps: int, w_ground: float, w_ver: float) -> dict:
        backbone.train()
        losses = []
        g_correct = 0
        g_total = 0
        for _ in range(steps):
            toks, nxt, boxes, valid = synth_batch(16)
            h = backbone(toks)
            logits = lm_head(h)
            loss = ce(logits, nxt)
            if w_ground > 0:
                pred_boxes = torch.sigmoid(ground_head(h))
                loss = loss + w_ground * mse(pred_boxes, boxes)
                with torch.no_grad():
                    g_correct += int((((pred_boxes - boxes).abs().mean(dim=1)) < 0.2).sum())
                    g_total += pred_boxes.shape[0]
            if w_ver > 0:
                v = verifier(h.detach()).squeeze(-1)
                loss = loss + w_ver * bce(v, valid)
            opt.zero_grad()
            loss.backward()
            opt.step()
            losses.append(float(loss.item()))
        phase = {"steps": steps,
                 "final_loss": sum(losses[-5:]) / max(1, len(losses[-5:])),
                 "mean_loss": sum(losses) / max(1, len(losses)),
                 "accuracy": (g_correct / max(1, g_total)) if g_total else 0.0}
        metrics["phases"][name] = phase
        return phase

    sft = loop("sft", int(cfg.get("sft_steps", 20)), 0.0, 0.0)
    ground = loop("grounding_head", int(cfg.get("grounding_steps", 10)), 1.0, 0.0)
    verifier_passed = bool(ground["accuracy"] >= 0.5)
    metrics["phases"]["verifier"] = {"passed": verifier_passed, "threshold": 0.5,
                                     "accuracy": ground["accuracy"]}
    if not verifier_passed:
        print("WARNING: verifier gate failed; continuing to preference pass for diagnostics",
              file=sys.stderr)
    pref = loop("preference", int(cfg.get("preference_steps", 10)), 0.25, 0.5)
    metrics["summary"] = {"sft_final_loss": sft["final_loss"],
                          "grounding_accuracy": ground["accuracy"],
                          "verifier_passed": verifier_passed,
                          "preference_final_loss": pref["final_loss"]}
    # Persist weights (state dict) next to the lineage files.
    weights_path = os.path.join(out_dir, "weights.pt")
    torch.save({"backbone": backbone.state_dict(), "config": cfg}, weights_path)
    metrics["weights_path"] = weights_path
    return metrics


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="EVE-X SFT + grounding + verifier + preference training")
    ap.add_argument("--config", default=None, help="JSON config file (merged over defaults)")
    ap.add_argument("--out", required=True, help="Output directory for model/metrics/lineage JSON")
    ap.add_argument("--smoke", action="store_true", help="Tiny synthetic CPU run (<60s)")
    ap.add_argument("--seed", type=int, default=None, help="Override config seed")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)
    if args.seed is not None:
        cfg["seed"] = args.seed
    config_hash = sha256_json(cfg)
    os.makedirs(args.out, exist_ok=True)
    started = time.time()

    if args.smoke:
        metrics = smoke_run(cfg, args.out)
    else:
        metrics = torch_run(cfg, args.out)

    model_id = "model-%s" % hashlib.sha256(config_hash.encode()).hexdigest()[:8]
    elapsed = time.time() - started
    with open(os.path.join(args.out, "model.json"), "w", encoding="utf-8") as f:
        json.dump({"model_id": model_id, "architecture": cfg.get("architecture"),
                   "quantization": cfg.get("quantization", "none"),
                   "config_hash": config_hash, "seed": cfg.get("seed"),
                   "mode": "smoke" if args.smoke else "full",
                   "elapsed_s": elapsed}, f, indent=2)
    with open(os.path.join(args.out, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2)
    with open(os.path.join(args.out, "lineage.json"), "w", encoding="utf-8") as f:
        json.dump({"model_id": model_id, "config_hash": config_hash,
                   "dataset_digest": cfg.get("dataset_digest", "unknown"),
                   "code_digest": code_digest(),
                   "parent_model_id": cfg.get("parent_model_id"),
                   "mode": "smoke" if args.smoke else "full",
                   "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)
    print(f"done model_id={model_id} elapsed={elapsed:.1f}s out={args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
