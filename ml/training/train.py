"""EVE-X supervised fine-tuning entrypoint: SFT + grounding head + verifier + preference pass.

Usage:
    python ml/training/train.py --config ml/training/config.json --out out/run1
    python ml/training/train.py --smoke --out out/smoke
    python ml/training/train.py --smoke --out out/run1 --max-epochs 3
    python ml/training/train.py --smoke --out out/run2 --resume-from out/run1 --max-epochs 3

Modes:
    --smoke   Tiny synthetic run (CPU, no dataset download, <60s). Exercises the
              full pipeline: config hash -> toy SFT loop -> grounding head ->
              verifier gate -> preference pass -> lineage JSON. Works with plain
              pip torch CPU; if torch is missing, smoke falls back to a pure
              Python toy optimizer so `--smoke` always runs.
    full      Requires torch. Imports are guarded with a clear install message.

Resume:
    --resume-from <dir> loads that run's checkpoint.json (+ model.json /
    metrics.json / lineage.json) and continues until --max-epochs total
    epochs. The current config hash must equal the stored config hash,
    otherwise training refuses to start (exit 2) instead of silently mixing
    runs. Epoch state is written atomically (tmp file + os.replace) after
    every epoch, and a SIGINT handler flushes a loadable checkpoint before
    exiting (exit 130), so killing a run mid-epoch never corrupts the output
    directory. See ml/README.md for the manual SIGINT test procedure.

Outputs (under --out):
    model.json      model_id + architecture + quantization + config hash
    metrics.json    per-phase losses / accuracies measured from the run
    lineage.json    config hash + dataset digest + code digest + code commit + parent
    checkpoint.json epochs_completed + config hash + per-epoch history (+ resume state)
Never fabricates numbers: every metric is computed from the loop above.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import signal
import sys
import time


# ── interrupt handling: SIGINT flushes a loadable checkpoint, then exits ──

_interrupted = False
_saver: "callable[[], None] | None" = None


def _on_sigint(signum, frame) -> None:  # noqa: ANN001, ANN202
    global _interrupted
    _interrupted = True
    if _saver is not None:
        try:
            _saver()
        except Exception as e:  # noqa: BLE001 - must survive teardown
            print(f"WARNING: checkpoint-on-interrupt failed: {e}", file=sys.stderr)


try:
    signal.signal(signal.SIGINT, _on_sigint)
except (OSError, ValueError, RuntimeError):
    pass  # non-main thread or unsupported platform: loops still poll the flag


class _Interrupted(Exception):
    pass


def _poll_interrupt() -> None:
    if _interrupted:
        raise _Interrupted()


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


def git_commit() -> str:
    """Short honest provenance: current HEAD sha, or 'unknown' (never invented)."""
    try:
        import subprocess  # noqa: PLC0415

        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repo,
            capture_output=True, text=True, timeout=10,
        )
        sha = (out.stdout or "").strip()
        if out.returncode == 0 and sha:
            return sha
    except Exception:  # noqa: BLE001 - git may be absent; that is fine
        pass
    return "unknown"


def atomic_write_json(path: str, obj: object) -> None:
    """Interrupt-safe write: full bytes to tmp file, then atomic os.replace."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


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


def smoke_run(cfg: dict, out_dir: str, w_init: "list[float] | None" = None) -> "tuple[dict, list[float]]":
    """Dependency-free toy run: deterministic linear-model SGD on synthetic data.

    Returns (metrics, final_weights) so --resume-from can continue optimizing
    the same toy model instead of restarting from scratch.
    """
    seed = int(cfg.get("seed", 42))
    rng = random.Random(seed + len(w_init or []))
    hidden = int(cfg.get("hidden", 128))
    w = list(w_init) if w_init is not None else [rng.uniform(-0.5, 0.5) for _ in range(hidden)]
    lr = float(cfg.get("lr", 1e-3))
    metrics: dict = {"phases": {}}

    def run_phase(name: str, steps: int, noise: float) -> dict:
        losses = []
        correct = 0
        total = 0
        wl = list(w)
        for step in range(steps):
            _poll_interrupt()
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
    return metrics, w


def torch_run(cfg: dict, out_dir: str, resume_weights: "str | None" = None):
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
    if resume_weights and os.path.exists(resume_weights):
        try:
            saved = torch.load(resume_weights, map_location="cpu", weights_only=False)
            backbone.load_state_dict(saved["backbone"])
            print(f"resumed weights from {resume_weights}", flush=True)
        except Exception as e:  # noqa: BLE001 - corrupt weights must fail loudly
            raise SystemExit(f"ERROR: cannot load resume weights {resume_weights}: {e}")
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
            _poll_interrupt()
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
    # Persist weights (state dict) next to the lineage files (atomic).
    weights_path = os.path.join(out_dir, "weights.pt")
    tmp_weights = weights_path + ".tmp"
    torch.save({"backbone": backbone.state_dict(), "config": cfg}, tmp_weights)
    os.replace(tmp_weights, weights_path)
    metrics["weights_path"] = weights_path
    return metrics


def load_checkpoint(d: str) -> dict:
    p = os.path.join(d, "checkpoint.json")
    if not os.path.exists(p):
        raise SystemExit(f"ERROR: --resume-from {d} has no checkpoint.json; cannot resume")
    try:
        with open(p, "r", encoding="utf-8") as f:
            ck = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise SystemExit(f"ERROR: --resume-from checkpoint unreadable: {e}")
    if not isinstance(ck, dict):
        raise SystemExit("ERROR: --resume-from checkpoint must contain a JSON object")
    return ck


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="EVE-X SFT + grounding + verifier + preference training")
    ap.add_argument("--config", default=None, help="JSON config file (merged over defaults)")
    ap.add_argument("--out", required=True, help="Output directory for model/metrics/lineage JSON")
    ap.add_argument("--smoke", action="store_true", help="Tiny synthetic CPU run (<60s)")
    ap.add_argument("--seed", type=int, default=None, help="Override config seed")
    ap.add_argument("--max-epochs", type=int, default=1,
                    help="Total epochs to train (default 1; with --resume-from, continues to this total)")
    ap.add_argument("--resume-from", default=None, metavar="DIR",
                    help="Resume from a previous --out dir (config hash must match)")
    args = ap.parse_args(argv)

    if args.max_epochs is not None and args.max_epochs < 1:
        print("ERROR: --max-epochs must be >= 1", file=sys.stderr)
        return 2

    cfg = load_config(args.config)
    if args.seed is not None:
        cfg["seed"] = args.seed
    config_hash = sha256_json(cfg)
    max_epochs = int(args.max_epochs or 1)
    os.makedirs(args.out, exist_ok=True)
    started = time.time()

    epochs_done = 0
    history: list = []
    w_state: "list[float] | None" = None
    resume_weights: "str | None" = None
    if args.resume_from:
        ck = load_checkpoint(args.resume_from)
        if ck.get("config_hash") != config_hash:
            print(
                f"ERROR: config mismatch: current hash {config_hash[:12]} != "
                f"checkpoint hash {str(ck.get('config_hash'))[:12]}; refusing to resume "
                f"(train from scratch or pass the original --config/--seed)",
                file=sys.stderr,
            )
            return 2
        # Cross-check the sibling lineage/model files when present.
        for name in ("model.json", "lineage.json"):
            p = os.path.join(args.resume_from, name)
            if os.path.exists(p):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        doc = json.load(f)
                    if isinstance(doc, dict) and doc.get("config_hash") not in (None, config_hash):
                        print(f"ERROR: {name} in {args.resume_from} has a different "
                              f"config hash; refusing to resume", file=sys.stderr)
                        return 2
                except (OSError, json.JSONDecodeError) as e:
                    print(f"ERROR: cannot verify {name} in resume dir: {e}", file=sys.stderr)
                    return 2
        epochs_done = int(ck.get("epochs_completed", 0) or 0)
        history = list(ck.get("history", []) or [])
        if ck.get("smoke_state") is not None:
            w_state = list(ck["smoke_state"])
        if ck.get("weights_file"):
            cand = os.path.join(args.resume_from, str(ck["weights_file"]))
            if os.path.exists(cand):
                resume_weights = cand
        print(f"resuming from {args.resume_from}: epochs_completed={epochs_done}", flush=True)

    if epochs_done >= max_epochs:
        print(f"nothing to do: epochs_completed={epochs_done} >= --max-epochs={max_epochs}")
        return 0

    commit = git_commit()
    mode = "smoke" if args.smoke else "full"

    def write_checkpoint(metrics: "dict | None") -> None:
        atomic_write_json(os.path.join(args.out, "checkpoint.json"), {
            "config_hash": config_hash,
            "epochs_completed": epochs_done,
            "max_epochs": max_epochs,
            "mode": mode,
            "history": history,
            "smoke_state": w_state,
            "weights_file": "weights.pt" if (not args.smoke and metrics and metrics.get("weights_path")) else None,
            "code_commit": commit,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })

    global _saver

    def flush_on_interrupt() -> None:
        write_checkpoint(None)

    _saver = flush_on_interrupt
    # Baseline checkpoint so a SIGINT before epoch 1 still leaves a loadable file.
    write_checkpoint(None)

    metrics: dict = {}
    try:
        for epoch in range(epochs_done, max_epochs):
            _poll_interrupt()
            if args.smoke:
                metrics, w_state = smoke_run(cfg, args.out, w_state)
            else:
                metrics = torch_run(cfg, args.out, resume_weights)
                resume_weights = os.path.join(args.out, "weights.pt")
            metrics["epoch"] = epoch + 1
            metrics["max_epochs"] = max_epochs
            epochs_done = epoch + 1
            history.append({"epoch": epochs_done, "summary": metrics.get("summary")})
            write_checkpoint(metrics)
            atomic_write_json(os.path.join(args.out, "metrics.json"), metrics)
            print(f"epoch {epochs_done}/{max_epochs} done", flush=True)
    except _Interrupted:
        write_checkpoint(metrics or None)
        print(f"interrupted: checkpoint flushed (epochs_completed={epochs_done})", file=sys.stderr)
        return 130
    finally:
        _saver = None

    model_id = "model-%s" % hashlib.sha256(config_hash.encode()).hexdigest()[:8]
    elapsed = time.time() - started
    atomic_write_json(os.path.join(args.out, "model.json"),
                      {"model_id": model_id, "architecture": cfg.get("architecture"),
                       "quantization": cfg.get("quantization", "none"),
                       "config_hash": config_hash, "seed": cfg.get("seed"),
                       "mode": mode, "epochs_completed": epochs_done,
                       "elapsed_s": elapsed})
    atomic_write_json(os.path.join(args.out, "metrics.json"), metrics)
    atomic_write_json(os.path.join(args.out, "lineage.json"),
                      {"model_id": model_id, "config_hash": config_hash,
                       "dataset_digest": cfg.get("dataset_digest", "unknown"),
                       "code_digest": code_digest(),
                       "code_commit": commit,
                       "parent_model_id": cfg.get("parent_model_id"),
                       "mode": mode, "epochs_completed": epochs_done,
                       "resumed_from": args.resume_from,
                       "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
    write_checkpoint(metrics)
    print(f"done model_id={model_id} elapsed={elapsed:.1f}s out={args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
