"""EVE-X inference HTTP service (stdlib only).

ModelRuntime design (verification over self-report):

    ModelArtifact  - weights file + expected identity (sha256, bytes, arch,
                     format, optional JSON manifest sidecar)
    verify_artifact() - existence, size, sha256, container format, manifest
                     agreement. ANY mismatch -> the artifact is refused.
    load_with_torch() - torch.load (weights_only) -> module or state dict ->
                     parameter census (count + finiteness). Success is the
                     ONLY path to weights_verified=true.
    try_load_model()  - runs the full chain; every failure leaves the
                     service NOT READY with the exact reason preserved.

Readiness truth table:

    weights verified              -> ready=true,  degraded=true(*), /infer 200
    no weights + --allow-heuristic-> ready=true,  degraded=true,  /infer 200
    anything else                 -> ready=false, /infer 503 model-not-loaded

    (*) degraded=true because served actions are produced by the EXPLICIT
    heuristic-v1 policy (action_source names the producer). A verified
    weights file proves MODEL IDENTITY (model_id/sha/arch/device), not
    action provenance. degraded=false is reserved for a future model-forward
    action path; nothing in this service may claim it today.

Every inference result identifies: model_id, model_version, model_sha256,
architecture, device, action_source, degraded, weights_verified,
latency_ms, frame_id.

Endpoints:
    GET  /health     liveness (always 200 when the process is up; no auth)
    GET  /ready      readiness (200 only when ready; open for orchestrators)
    GET  /metrics    Prometheus text exposition (open)
    GET  /model-info full model identity (bearer auth when a token is set)
    POST /infer      screenshot+context -> action JSON (bearer auth when set)

Security: when EVEX_INFERENCE_TOKEN (or --require-token) is set, /infer and
/model-info require `Authorization: Bearer <token>` (constant-time compare).
Bind defaults to loopback; the compose topology keeps the plane on the
internal network (no published port) behind the authenticated API.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
import queue
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_ACTIONS = ("click", "double_click", "move", "drag", "type", "key",
                   "hotkey", "scroll", "wait", "observe", "terminate")

HEURISTIC_POLICY_ID = "heuristic-v1"
MODEL_VERSION_DEFAULT = "0"
MAX_BODY_BYTES = 12 * 1024 * 1024

# ---------------------------------------------------------------------------
# State (guarded by _state_lock)
# ---------------------------------------------------------------------------

_state_lock = threading.Lock()
_ready = False
_degraded = True
_model_id = HEURISTIC_POLICY_ID
_model_version = MODEL_VERSION_DEFAULT
_model_sha256: str | None = None
_architecture: str | None = None
_device = "cpu"
_action_source = "none"
_weights_verified = False
_model_error = "not loaded yet"
_started_at = time.time()
_req_count = 0
_err_count = 0
_degraded_count = 0
_load_failures = 0
_lat_samples: list[float] = []
_infer_queue: queue.Queue = queue.Queue(maxsize=32)
_require_token = ""


def _snapshot_identity() -> dict:
    with _state_lock:
        return {
            "ready": _ready,
            "degraded": _degraded,
            "model_id": _model_id,
            "model_version": _model_version,
            "model_sha256": _model_sha256,
            "architecture": _architecture,
            "device": _device,
            "action_source": _action_source,
            "weights_verified": _weights_verified,
            "detail": _model_error,
            "load_failures": _load_failures,
        }


def record_latency(ms: float, degraded: bool) -> None:
    global _req_count
    with _state_lock:
        _req_count += 1
        if degraded:
            global _degraded_count
            _degraded_count += 1
        _lat_samples.append(ms)
        if len(_lat_samples) > 512:
            del _lat_samples[:len(_lat_samples) - 512]


def record_error() -> None:
    global _err_count
    with _state_lock:
        _err_count += 1


def snapshot_metrics() -> dict:
    with _state_lock:
        lat = list(_lat_samples)
        return {"requests": _req_count, "errors": _err_count,
                "degraded": _degraded_count,
                "queue_depth": _infer_queue.qsize(),
                "ready": _ready, "load_failures": _load_failures,
                "uptime_s": time.time() - _started_at,
                "p50_ms": sorted(lat)[len(lat) // 2] if lat else 0.0}


# ---------------------------------------------------------------------------
# ModelRuntime: artifact verification + loading
# ---------------------------------------------------------------------------

def detect_container_format(head: bytes) -> str:
    """Identify a weights container from magic bytes. Unknown -> refuse.

    The safetensors sniff validates the JSON header (not just the length
    prefix) so unrelated binaries cannot be mistaken for safetensors.
    """
    if len(head) >= 8:
        (header_len,) = struct.unpack("<Q", head[:8])
        if 0 < header_len < 64 * 1024 * 1024 and len(head) >= 8 + header_len:
            try:
                if isinstance(json.loads(head[8:8 + header_len].decode("utf-8")), dict):
                    return "safetensors"
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
                pass
    if head[:4] == b"PK\x03\x04":
        return "torch-zip"
    if head[:1] == b"\x80":
        return "torch-pickle"
    return "unknown"


def read_manifest(manifest_path: str | None) -> dict:
    if not manifest_path:
        return {}
    with open(manifest_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise RuntimeError("weights manifest is not a JSON object")
    return data


def verify_artifact(path: str, expected_sha256: str | None,
                    expected_bytes: int | None, expected_arch: str | None,
                    manifest: dict) -> dict:
    """Verify a weights file WITHOUT trusting its name or provenance.

    Returns {sha256, bytes, format, arch}. Raises RuntimeError naming the
    exact failed check — the caller preserves this as the not-ready reason.
    """
    if not os.path.isfile(path):
        raise RuntimeError(f"weights file not found: {path}")
    exp_sha = (expected_sha256 or manifest.get("sha256") or "").strip().lower()
    if not exp_sha:
        # No pin, no trust: a digest computed from the file itself attests
        # nothing about provenance. weights_verified must bind the artifact
        # to an independently expected value, or any file becomes "verified".
        raise RuntimeError("weights sha256 pin required (--weights-sha256 or manifest.sha256); refusing unpinned artifact")
    exp_bytes = expected_bytes
    if exp_bytes is None and manifest.get("bytes") is not None:
        exp_bytes = int(manifest["bytes"])
    exp_arch = (expected_arch or manifest.get("arch") or "").strip() or None

    size = os.path.getsize(path)
    if size <= 0:
        raise RuntimeError("weights file is empty")
    if exp_bytes is not None and size != exp_bytes:
        raise RuntimeError(f"weights size mismatch: file has {size} bytes, expected {exp_bytes}")

    h = hashlib.sha256()
    with open(path, "rb") as f:
        # Enough prefix for container sniffing (safetensors header validation
        # needs the declared JSON), then stream the rest for the digest.
        head = f.read(65544)
        h.update(head)
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    digest = h.hexdigest()
    if exp_sha and digest != exp_sha:
        raise RuntimeError("weights sha256 mismatch: file does not match the expected digest")

    fmt = detect_container_format(head)
    if fmt == "unknown":
        raise RuntimeError("weights container format unrecognized (not safetensors/torch) — refusing")
    manifest_fmt = str(manifest.get("format") or "").strip()
    if manifest_fmt and manifest_fmt != fmt:
        raise RuntimeError(f"weights format mismatch: detected {fmt}, manifest declares {manifest_fmt}")

    return {"sha256": digest, "bytes": size, "format": fmt, "arch": exp_arch}


def load_with_torch(path: str, force_cpu: bool) -> dict:
    """Actually load the artifact with torch and census its parameters.

    Returns {device, params, dtype_note}. Success means the bytes parsed
    into real tensors with finite values — that is what weights_verified
    attests. Raises RuntimeError otherwise (torch missing, load failure,
    empty / non-finite parameters).
    """
    try:
        import torch  # type: ignore
    except Exception as e:
        raise RuntimeError(f"torch unavailable, cannot execute model load: {e}")
    device = "cpu"
    try:
        if torch.cuda.is_available() and not force_cpu:
            device = "cuda"
    except Exception:
        device = "cpu"
    try:
        obj = torch.load(path, map_location="cpu", weights_only=True)
    except Exception as e:
        raise RuntimeError(f"torch.load failed: {e}")
    if hasattr(obj, "parameters"):
        try:
            params = list(obj.parameters())
        except Exception as e:
            raise RuntimeError(f"model.parameters() failed: {e}")
    elif isinstance(obj, dict):
        params = [v for v in obj.values() if hasattr(v, "numel")]
    else:
        raise RuntimeError(f"torch.load produced {type(obj).__name__}, not a module or state dict")
    if not params:
        raise RuntimeError("model has no parameters")
    total = 0
    for p in params:
        try:
            total += int(p.numel())
        except Exception as e:
            raise RuntimeError(f"parameter census failed: {e}")
        try:
            finite = bool(torch.isfinite(p).all())
        except Exception as e:
            raise RuntimeError(f"parameter finiteness check failed: {e}")
        if not finite:
            raise RuntimeError("model parameters contain NaN/Inf — refusing")
    if total <= 0:
        raise RuntimeError("model parameter count is zero")
    return {"device": device, "params": total}


def try_load_model(weights_path: str | None, force_cpu: bool,
                   expected_sha256: str | None = None,
                   expected_bytes: int | None = None,
                   expected_arch: str | None = None,
                   manifest_path: str | None = None,
                   allow_heuristic: bool = False,
                   model_id: str | None = None,
                   model_version: str = MODEL_VERSION_DEFAULT) -> None:
    """Full load chain. Sets readiness + identity; never throws."""
    global _ready, _degraded, _model_id, _model_version, _model_sha256
    global _architecture, _device, _action_source, _weights_verified
    global _model_error, _load_failures
    try:
        manifest = read_manifest(manifest_path)
    except Exception as e:
        with _state_lock:
            _ready = False
            _degraded = True
            _model_id = HEURISTIC_POLICY_ID
            _weights_verified = False
            _action_source = "none"
            _model_error = f"weights manifest unreadable: {e}"
            _load_failures += 1
        return
    if weights_path:
        try:
            info = verify_artifact(weights_path, expected_sha256,
                                   expected_bytes, expected_arch, manifest)
            loaded = load_with_torch(weights_path, force_cpu)
        except Exception as e:
            with _state_lock:
                _ready = False
                _degraded = True
                _model_id = HEURISTIC_POLICY_ID
                _model_sha256 = None
                _architecture = (expected_arch or manifest.get("arch") or None) if isinstance(manifest.get("arch"), str) else (expected_arch or None)
                _weights_verified = False
                _action_source = "none"
                _model_error = f"model load failed: {e}"
                _load_failures += 1
            return
        digest = info["sha256"]
        with _state_lock:
            # Verified identity, but served actions still come from the
            # explicit heuristic policy (see module docstring) — degraded
            # stays true and the producer is named. degraded=false is
            # unreachable until a model-forward action path exists.
            _ready = True
            _degraded = True
            _model_id = model_id or f"local-weights-{digest[:16]}"
            _model_version = model_version
            _model_sha256 = digest
            _architecture = info["arch"]
            _device = loaded["device"]
            _weights_verified = True
            _action_source = HEURISTIC_POLICY_ID
            _model_error = (f"weights verified (sha256 {digest[:16]}…, "
                            f"{loaded['params']} params, {info['format']}); "
                            f"actions served by explicit {HEURISTIC_POLICY_ID} policy")
        return
    if allow_heuristic:
        with _state_lock:
            _ready = True
            _degraded = True
            _model_id = model_id or HEURISTIC_POLICY_ID
            _model_version = model_version
            _model_sha256 = None
            _architecture = expected_arch or None
            _device = "cpu"
            _weights_verified = False
            _action_source = HEURISTIC_POLICY_ID
            _model_error = "explicit heuristic fallback policy active (dev/test only)"
        return
    with _state_lock:
        _ready = False
        _degraded = True
        _model_id = HEURISTIC_POLICY_ID
        _model_sha256 = None
        _weights_verified = False
        _action_source = "none"
        _model_error = "no weights configured and --allow-heuristic not set; refusing to serve"
        _load_failures += 1


# ---------------------------------------------------------------------------
# Heuristic policy (explicit dev/test fallback ONLY)
# ---------------------------------------------------------------------------

def pick_action(payload: dict) -> dict:
    """Heuristic policy: click the highest-confidence region label matching the
    goal keywords, else center-move. ONLY served when readiness explicitly
    permits it, and ALWAYS labeled action_source=heuristic-v1, degraded=true.
    Confidence is derived from region scores, never invented."""
    goal = str(payload.get("goal", ""))
    width = int(payload.get("width", 1920))
    height = int(payload.get("height", 1080))
    regions = payload.get("regions", [])
    if not isinstance(regions, list):
        regions = []
    keywords = [w.strip().lower() for w in goal.split() if len(w.strip()) > 3]
    best = None
    best_score = 0.0
    for r in regions:
        if not isinstance(r, dict):
            continue
        label = str(r.get("label", "")).lower()
        try:
            conf = float(r.get("confidence", 0.0))
        except (TypeError, ValueError):
            conf = 0.0
        bonus = 0.15 if any(k in label for k in keywords) else 0.0
        score = max(0.0, min(1.0, conf + bonus))
        if best is None or score > best_score:
            best, best_score = r, score
    if best is not None and isinstance(best.get("bbox"), list) and len(best["bbox"]) == 4:
        x1, y1, x2, y2 = (float(v) for v in best["bbox"])
        cx, cy = int((x1 + x2) / 2), int((y1 + y2) / 2)
        cx = max(0, min(width - 1, cx))
        cy = max(0, min(height - 1, cy))
        return {"type": "click", "to": {"x": cx, "y": cy},
                "confidence": round(best_score, 3),
                "intent": f"click {best.get('label', 'target')}"[:256]}
    return {"type": "move", "to": {"x": width // 2, "y": height // 2},
            "confidence": 0.2, "intent": "no matching region; recenter"}


def check_bearer(handler: BaseHTTPRequestHandler) -> bool:
    with _state_lock:
        token = _require_token
    if not token:
        return True
    presented = handler.headers.get("Authorization", "")
    if not presented.startswith("Bearer "):
        return False
    return hmac.compare_digest(presented[len("Bearer "):].strip(), token)


class Handler(BaseHTTPRequestHandler):
    server_version = "EVEInference/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        pass

    def _send(self, code: int, obj: object, content_type: str = "application/json") -> None:
        body = obj.encode("utf-8") if isinstance(obj, str) else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, {"status": "ok"})
        elif self.path == "/ready":
            ident = _snapshot_identity()
            code = 200 if ident["ready"] else 503
            self._send(code, ident)
        elif self.path == "/model-info":
            if not check_bearer(self):
                record_error()
                self._send(401, {"error": "unauthorized"})
                return
            self._send(200, _snapshot_identity())
        elif self.path == "/metrics":
            # Model identity rides the metric labels: require the bearer
            # whenever auth is configured. /health and /ready stay open
            # (liveness/readiness probes for orchestrators carry no identity).
            if not check_bearer(self):
                record_error()
                self._send(401, {"error": "unauthorized"})
                return
            m = snapshot_metrics()
            ident = _snapshot_identity()
            lines = ["# HELP evex_infer_requests_total Total infer requests",
                     "# TYPE evex_infer_requests_total counter",
                     f"evex_infer_requests_total {m['requests']}",
                     "# HELP evex_infer_errors_total Total infer errors",
                     "# TYPE evex_infer_errors_total counter",
                     f"evex_infer_errors_total {m['errors']}",
                     "# HELP evex_infer_degraded_total Degraded (heuristic) responses",
                     "# TYPE evex_infer_degraded_total counter",
                     f"evex_infer_degraded_total {m['degraded']}",
                     "# HELP evex_infer_queue_depth Current queue depth",
                     "# TYPE evex_infer_queue_depth gauge",
                     f"evex_infer_queue_depth {m['queue_depth']}",
                     "# HELP evex_infer_latency_p50_ms P50 latency",
                     "# TYPE evex_infer_latency_p50_ms gauge",
                     f"evex_infer_latency_p50_ms {m['p50_ms']:.3f}",
                     "# HELP evex_model_ready Model loaded and serving (1) or not (0)",
                     "# TYPE evex_model_ready gauge",
                     f"evex_model_ready {1 if m['ready'] else 0}",
                     "# HELP evex_model_load_failures_total Model load failures",
                     "# TYPE evex_model_load_failures_total counter",
                     f"evex_model_load_failures_total {m['load_failures']}",
                     "# HELP evex_model_info Model identity (labels)",
                     "# TYPE evex_model_info gauge",
                     f"evex_model_info{{model_id=\"{ident['model_id']}\","
                     f"action_source=\"{ident['action_source']}\"}} 1"]
            self._send(200, "\n".join(lines) + "\n", "text/plain; version=0.0.4")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/infer":
            self._send(404, {"error": "not found"})
            return
        if not check_bearer(self):
            record_error()
            self._send(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            record_error()
            self._send(413 if length > MAX_BODY_BYTES else 400,
                       {"error": "invalid content length"})
            return
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            record_error()
            self._send(400, {"error": "invalid JSON"})
            return
        if not isinstance(payload, dict):
            record_error()
            self._send(400, {"error": "body must be a JSON object"})
            return
        for field in ("frame_id", "goal", "width", "height", "png_base64"):
            if payload.get(field) in (None, ""):
                record_error()
                self._send(400, {"error": f"missing field: {field}"})
                return
        png = payload["png_base64"]
        if not isinstance(png, str):
            record_error()
            self._send(400, {"error": "png_base64 must be a string"})
            return
        try:
            base64.b64decode(png[:len(png) - (len(png) % 4) + 4] if len(png) % 4 else png,
                             validate=False)
        except (binascii.Error, ValueError):
            record_error()
            self._send(400, {"error": "png_base64 is not valid base64"})
            return
        try:
            timeout_ms = int(payload.get("timeout_ms", 15000))
        except (TypeError, ValueError):
            timeout_ms = 15000
        timeout_ms = max(100, min(120000, timeout_ms))
        # Fail closed: not-ready serves NOTHING, not even heuristic output.
        # The control plane maps 503 to inference_unavailable / inconclusive.
        ident = _snapshot_identity()
        if not ident["ready"]:
            record_error()
            self._send(503, {"error": "model-not-loaded", "detail": ident["detail"]})
            return
        try:
            _infer_queue.put_nowait(1)
        except queue.Full:
            record_error()
            self._send(429, {"error": "inference queue full; retry later"})
            return
        start = time.time()
        try:
            action = pick_action(payload)
            if action.get("type") not in ALLOWED_ACTIONS:
                action["type"] = "observe"
            latency = (time.time() - start) * 1000.0
            if latency > timeout_ms:
                record_error()
                self._send(504, {"error": "inference timed out"})
                return
            record_latency(latency, True)
            self._send(200, {"action": action,
                             "action_source": HEURISTIC_POLICY_ID,
                             "model_id": ident["model_id"],
                             "model_version": ident["model_version"],
                             "model_sha256": ident["model_sha256"],
                             "architecture": ident["architecture"],
                             "device": ident["device"],
                             "degraded": True,
                             "weights_verified": ident["weights_verified"],
                             "latency_ms": round(latency, 2),
                             "frame_id": str(payload["frame_id"])})
        finally:
            try:
                _infer_queue.get_nowait()
            except queue.Empty:
                pass


def main(argv: list | None = None) -> int:
    ap = argparse.ArgumentParser(description="EVE-X inference HTTP service")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--weights", default=None, help="Weights file to verify+load (required for non-heuristic serving)")
    ap.add_argument("--weights-sha256", default=None, help="Expected SHA-256 of the weights file")
    ap.add_argument("--weights-bytes", type=int, default=None, help="Expected byte size of the weights file")
    ap.add_argument("--arch", default=None, help="Expected model architecture tag")
    ap.add_argument("--weights-manifest", default=None, help="JSON sidecar {sha256, bytes, arch, format}")
    ap.add_argument("--model-id", default=None, help="Model identity (default: local-weights-<sha12>)")
    ap.add_argument("--model-version", default=MODEL_VERSION_DEFAULT)
    ap.add_argument("--allow-heuristic", action="store_true",
                    help="Explicitly serve the heuristic-v1 dev/test policy (always degraded=true)")
    ap.add_argument("--require-token", default=None,
                    help="Bearer token for /infer + /model-info + /metrics (or EVEX_INFERENCE_TOKEN)")
    ap.add_argument("--allow-unauthenticated", action="store_true",
                    help="Permit --host 0.0.0.0 with no bearer token (explicitly insecure; refuses otherwise)")
    ap.add_argument("--cpu", action="store_true", help="Force CPU even if CUDA present")
    ap.add_argument("--queue-size", type=int, default=32)
    args = ap.parse_args(argv)
    global _infer_queue, _require_token
    _infer_queue = queue.Queue(maxsize=max(1, args.queue_size))
    _require_token = (args.require_token or os.environ.get("EVEX_INFERENCE_TOKEN") or "").strip()
    if args.host not in ("127.0.0.1", "localhost", "::1") and not _require_token and not args.allow_unauthenticated:
        print(f"refusing: --host {args.host} exposes the plane without a bearer token "
              "(set --require-token/EVEX_INFERENCE_TOKEN or pass --allow-unauthenticated explicitly)",
              flush=True)
        return 2
    try_load_model(args.weights, args.cpu,
                    expected_sha256=args.weights_sha256,
                    expected_bytes=args.weights_bytes,
                    expected_arch=args.arch,
                    manifest_path=args.weights_manifest,
                    allow_heuristic=args.allow_heuristic,
                    model_id=args.model_id,
                    model_version=args.model_version)
    ident = _snapshot_identity()
    print(f"inference up on {args.host}:{args.port} model={ident['model_id']} "
          f"ready={ident['ready']} degraded={ident['degraded']} "
          f"action_source={ident['action_source']} auth={'on' if _require_token else 'off'}",
          flush=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
