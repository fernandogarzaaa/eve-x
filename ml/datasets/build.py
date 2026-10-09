"""EVE-X trajectory -> dataset pipeline.

Reads JSONL trajectories (one TraceStep-like object per line, or a whole
trajectory object with a "steps" list), then:
  1. dedups on a normalized action/percept fingerprint,
  2. sanitizes/redacts secrets (API keys, tokens, passwords, private paths),
  3. quality-filters (drop unverified grounding, empty goals, corrupt rows),
  4. splits into train/val/test/held-out preserving provenance (task_id groups
     never straddle splits; held-out tasks are quarantined for promotion gates),
  5. writes a digest file covering every output row.

Usage:
    python ml/datasets/build.py --in traces.jsonl --out data/eve-v1 --val 0.1 --test 0.1 --heldout 0.05
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import random
import re
import sys

from fingerprints import fingerprint_png, hamming

SECRET_PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9_-]{8,}"), "[REDACTED_API_KEY]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9_]{8,}"), "[REDACTED_GITHUB_TOKEN]"),
    (re.compile(r"xox[bpars]-[A-Za-z0-9-]{8,}"), "[REDACTED_SLACK_TOKEN]"),
    (re.compile(r"(?i)(password|passwd|pwd|secret)\s*[:=]\s*\S+"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/-]{8,}"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)aws_[a-z_]*key[a-z_]*\s*[:=]\s*\S+"), "AWS_KEY=[REDACTED]"),
    (re.compile(r"C:\\Users\\[^\\/\s]+"), "C:\\\\Users\\\\[REDACTED]"),
    (re.compile(r"/home/[^/\\s]+"), "/home/[REDACTED]"),
]

REDACTED_MARK = "[REDACTED"


def redact_text(s: str) -> tuple[str, int]:
    count = 0
    out = s
    for pat, repl in SECRET_PATTERNS:
        out, n = pat.subn(repl, out)
        count += n
    return out, count


def redact_obj(obj: object) -> tuple[object, int]:
    if isinstance(obj, str):
        return redact_text(obj)
    if isinstance(obj, list):
        total = 0
        items = []
        for v in obj:
            nv, n = redact_obj(v)
            total += n
            items.append(nv)
        return items, total
    if isinstance(obj, dict):
        total = 0
        out: dict = {}
        for k, v in obj.items():
            if isinstance(k, str) and re.search(r"(?i)^(.*(password|secret|token|api[_-]?key).*)$", k):
                out[k] = "[REDACTED]"
                total += 1
                continue
            nv, n = redact_obj(v)
            total += n
            out[k] = nv
        return out, total
    return obj, 0


def norm_text(s: object) -> str:
    import string as _string
    t = str(s or "").lower()
    t = t.translate(str.maketrans({c: " " for c in _string.punctuation}))
    return " ".join(t.split())


def visual_identity(step: dict) -> dict:
    """Visual identity of the observed screen, when pixel data is present.

    Returns {_visual: {visual_sha256, visual_phash, ...}} or
    {_visual: {unfingerprinted: reason}}. Steps without pixel bytes keep
    frame-id binding only (documented constraint, not silent skippage).
    """
    for key in ("png_base64", "screenshot_base64", "image_base64"):
        raw = step.get(key)
        if isinstance(raw, str) and raw.strip():
            try:
                data = base64.b64decode(raw, validate=True)
            except (binascii.Error, ValueError):
                return {"_visual": {"unfingerprinted": f"invalid base64 in {key}"}}
            try:
                info = fingerprint_png(data)
            except ValueError as e:
                return {"_visual": {"unfingerprinted": f"undecodable image: {e}"}}
            return {"_visual": info}
    return {"_visual": {"unfingerprinted": "no pixel data (frame-id binding only)"}}


def fingerprint(step: dict) -> str:
    """Identity of a training example. Binds the NORMALIZED goal + action
    core to the VISUAL STATE (frame ids + step digest when present): two
    examples with materially different screens never dedupe together, while
    near-identical phrasing over the same frame does. Pure goal+action
    dedupe is forbidden (it merges distinct visual states)."""
    goal = str(step.get("goal", ""))
    sel = step.get("selected_action") or step.get("actual_action") or {}
    if isinstance(sel, dict):
        tgt = sel.get("target") if isinstance(sel.get("target"), dict) else {}
        core = {"t": sel.get("type"), "x": norm_text(sel.get("text")),
                "to": sel.get("to"), "from": sel.get("from"),
                "keys": sel.get("keys"), "delta": sel.get("delta"),
                "region": tgt.get("regionId"), "label": norm_text(tgt.get("label"))}
    else:
        core = {"t": str(sel)}
    visual = {"before": step.get("screen_before"), "after": step.get("screen_after"),
              "png": step.get("png_sha256") or step.get("png_sha")}
    vis = step.get("_visual") if isinstance(step.get("_visual"), dict) else {}
    if isinstance(vis.get("visual_sha256"), str):
        # Pixel identity dominates: identical screenshots dedupe even across
        # different frame IDs. Frame IDs are observation-point labels, not
        # content — without this, the same screen re-observed never dedupes.
        visual = {"pixels": vis["visual_sha256"]}
    norm = json.dumps({"g": norm_text(goal), "a": core, "v": visual}, sort_keys=True)
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def label_block(step: dict) -> dict:
    """Provenance of the training label: what the supervision is, where it
    came from, and whether independent verification backs it."""
    ver = step.get("verification")
    verified = ver.get("passed") is True if isinstance(ver, dict) else None
    g = step.get("grounding")
    grounded = g.get("verified") is True if isinstance(g, dict) else None
    judgments = step.get("human_judgment") or step.get("human_intervention")
    return {
        "source": "demonstration-action",
        "validation_status": ("verified" if verified else
                              "human-judged" if judgments else
                              "unvalidated"),
        "frame_before": step.get("screen_before"),
        "frame_after": step.get("screen_after"),
        "frame_digest": step.get("digest"),
        "grounding_verified": grounded,
        "task_id": step.get("task_id"),
        "session_id": step.get("session_id"),
        "environment": step.get("environment_version"),
        "model": step.get("model_version"),
    }


def iter_steps(path: str):
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARN line {ln}: invalid JSON skipped ({e})", file=sys.stderr)
                continue
            if isinstance(obj, dict) and isinstance(obj.get("steps"), list):
                for s in obj["steps"]:
                    if isinstance(s, dict):
                        yield s
            elif isinstance(obj, dict):
                yield obj
            else:
                print(f"WARN line {ln}: non-object row skipped", file=sys.stderr)


def quality_ok(step: dict) -> tuple[bool, str]:
    if not str(step.get("goal", "")).strip():
        return False, "empty-goal"
    if not str(step.get("session_id", "")).strip():
        return False, "missing-session"
    g = step.get("grounding")
    if isinstance(g, dict) and g.get("verified") is False and step.get("human_intervention") is not True:
        return False, "unverified-grounding"
    sel = step.get("selected_action") or step.get("actual_action")
    if sel is None:
        return False, "no-action"
    return True, ""


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="EVE-X trajectory dataset builder")
    ap.add_argument("--in", dest="inp", required=True, help="Input JSONL trajectories")
    ap.add_argument("--out", required=True, help="Output dataset directory")
    ap.add_argument("--val", type=float, default=0.1)
    ap.add_argument("--test", type=float, default=0.1)
    ap.add_argument("--heldout", type=float, default=0.05)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--min-goal-chars", type=int, default=4)
    ap.add_argument("--allow-visual-leak", action="store_true",
                    help="Record visual-leakage violations without failing (explicit, noted in manifest; default refuses)")
    args = ap.parse_args(argv)

    if not (0 <= args.val < 1 and 0 <= args.test < 1 and 0 <= args.heldout < 1
            and args.val + args.test + args.heldout < 1):
        raise SystemExit("ERROR: val/test/heldout must be in [0,1) and sum < 1")

    rng = random.Random(args.seed)
    seen: set[str] = set()
    kept: list[dict] = []
    stats = {"read": 0, "dedup_dropped": 0, "quality_dropped": {},
             "redactions": 0, "short_goal_dropped": 0}

    for step in iter_steps(args.inp):
        stats["read"] += 1
        if len(str(step.get("goal", ""))) < args.min_goal_chars:
            stats["short_goal_dropped"] += 1
            continue
        vis = visual_identity(step)
        if isinstance(vis.get("_visual"), dict) and "visual_sha256" in vis["_visual"]:
            step["_visual"] = vis["_visual"]
        elif "_visual" not in step:
            step["_visual"] = vis["_visual"]
        fp = fingerprint(step)
        if fp in seen:
            stats["dedup_dropped"] += 1
            continue
        seen.add(fp)
        ok, reason = quality_ok(step)
        if not ok:
            stats["quality_dropped"][reason] = stats["quality_dropped"].get(reason, 0) + 1
            continue
        clean, n = redact_obj(step)
        stats["redactions"] += n
        assert isinstance(clean, dict)
        clean["_fingerprint"] = fp
        clean["_redactions"] = n
        clean["_label"] = label_block(step)
        kept.append(clean)

    # Provenance-preserving split: group by task_id so one task never lands in
    # two splits. Held-out tasks are quarantined for promotion gates.
    by_task: dict[str, list[dict]] = {}
    for s in kept:
        by_task.setdefault(str(s.get("task_id", "unknown")), []).append(s)
    tasks = sorted(by_task.keys())
    rng.shuffle(tasks)
    n = len(tasks)
    n_held = max(0, int(round(n * args.heldout)))
    n_test = max(0, int(round(n * args.test)))
    n_val = max(0, int(round(n * args.val)))
    held_tasks = set(tasks[:n_held])
    test_tasks = set(tasks[n_held:n_held + n_test])
    val_tasks = set(tasks[n_held + n_test:n_held + n_test + n_val])

    splits: dict[str, list[dict]] = {"train": [], "val": [], "test": [], "held-out": []}
    for t, rows in by_task.items():
        if t in held_tasks:
            splits["held-out"].extend(rows)
        elif t in test_tasks:
            splits["test"].extend(rows)
        elif t in val_tasks:
            splits["val"].extend(rows)
        else:
            splits["train"].extend(rows)

    os.makedirs(args.out, exist_ok=True)
    manifest: dict = {"splits": {}, "stats": stats, "seed": args.seed,
                      "input": os.path.abspath(args.inp)}
    for name, rows in splits.items():
        rows_sorted = sorted(rows, key=lambda r: (str(r.get("session_id")),
                                                  int(r.get("seq", 0))))
        h = hashlib.sha256()
        path = os.path.join(args.out, f"{name}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in rows_sorted:
                line = json.dumps(r, sort_keys=True)
                h.update(line.encode("utf-8"))
                f.write(line + "\n")
        manifest["splits"][name] = {"rows": len(rows_sorted),
                                    "tasks": len({str(r.get('task_id')) for r in rows_sorted}),
                                    "sha256": h.hexdigest(), "file": f"{name}.jsonl"}
    # Visual leakage defense: pixel-identical screens must never straddle
    # train/val/test/held-out, even with different frame IDs. Exact digest
    # matches FAIL the build (correctness property); near-duplicate phash
    # pairs (distance <= 10) are reported for review, never sole identity.
    train_shas: dict[str, str] = {}
    for r in splits["train"]:
        v = r.get("_visual") if isinstance(r.get("_visual"), dict) else {}
        if isinstance(v.get("visual_sha256"), str):
            train_shas[v["visual_sha256"]] = str(r.get("task_id"))
    visual_leakage = []
    for name in ("val", "test", "held-out"):
        for r in splits[name]:
            v = r.get("_visual") if isinstance(r.get("_visual"), dict) else {}
            sha = v.get("visual_sha256")
            if isinstance(sha, str) and sha in train_shas:
                visual_leakage.append({"split": name, "task_id": str(r.get("task_id")),
                                       "visual_sha256": sha, "also_in_train_task": train_shas[sha]})
    manifest["visual_leakage"] = {"violations": visual_leakage,
                                  "count": len(visual_leakage)}
    # Near-duplicate review band (informational): closest cross-split phash
    # pairs. Capped for cost; absence of a pair here is not proof of absence.
    train_ph: list[tuple[str, int, str]] = []
    for r in splits["train"][:2000]:
        v = r.get("_visual") if isinstance(r.get("_visual"), dict) else {}
        if isinstance(v.get("visual_phash"), str):
            train_ph.append((str(r.get("task_id")), int(v["visual_phash"], 16), v["visual_phash"]))
    near_dupes = []
    for name in ("val", "test", "held-out"):
        for r in splits[name][:2000]:
            v = r.get("_visual") if isinstance(r.get("_visual"), dict) else {}
            if not isinstance(v.get("visual_phash"), str):
                continue
            ph = int(v["visual_phash"], 16)
            best = min(((hamming(ph, tph), ttask) for ttask, tph, _ in train_ph), default=None)
            if best is not None and best[0] <= 10:
                near_dupes.append({"split": name, "task_id": str(r.get("task_id")),
                                   "phash_distance": best[0], "train_task_id": best[1]})
                if len(near_dupes) >= 50:
                    break
        if len(near_dupes) >= 50:
            break
    manifest["visual_near_duplicates"] = {"pairs": near_dupes, "count": len(near_dupes),
                                          "note": "review band only (phash<=10); not sole identity; capped at 50/2000-row scan"}
    with open(os.path.join(args.out, "digest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    dataset_digest = hashlib.sha256(json.dumps(
        {k: v["sha256"] for k, v in sorted(manifest["splits"].items())},
        sort_keys=True).encode("utf-8")).hexdigest()
    manifest["dataset_digest"] = dataset_digest
    with open(os.path.join(args.out, "digest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    print(f"done read={stats['read']} kept={len(kept)} "
          f"train={manifest['splits']['train']['rows']} "
          f"val={manifest['splits']['val']['rows']} "
          f"test={manifest['splits']['test']['rows']} "
          f"held-out={manifest['splits']['held-out']['rows']} "
          f"redactions={stats['redactions']} "
          f"visual_leaks={manifest['visual_leakage']['count']} "
          f"near_dupes={manifest['visual_near_duplicates']['count']}")
    if manifest["visual_leakage"]["count"] > 0 and not args.allow_visual_leak:
        print(f"ERROR: {manifest['visual_leakage']['count']} pixel-identical screens straddle splits "
              "(see digest.json visual_leakage); refusing. Re-split or pass --allow-visual-leak explicitly.",
              file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
