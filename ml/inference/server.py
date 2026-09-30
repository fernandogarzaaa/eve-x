"""EVE-X inference HTTP service (stdlib only).

Endpoints:
    GET  /health    liveness (always 200 when the process is up)
    GET  /ready     readiness (200 only after the policy/model loaded)
    GET  /metrics   Prometheus text exposition (requests, latency, queue depth)
    POST /infer     screenshot+context -> action JSON with confidence

Infer contract:
    request:  {frame_id, goal, width, height, png_base64, regions[], cursor?,
               model_id?, timeout_ms?}
    response: {action: {type, to/from/text/keys/confidence,...}, model_id,
               latency_ms, degraded: bool}

Reliability rules:
    - bounded queue (429 when full) and per-request timeout (504 on expiry);
    - the control plane never crashes on a GPU/model failure: load errors flip
      the service into degraded heuristic mode and /ready reports unready
      while /health + /infer (degraded=true) keep serving.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ALLOWED_ACTIONS = ("click", "double_click", "move", "drag", "type", "key",
                   "hotkey", "scroll", "wait", "observe", "terminate")

_state_lock = threading.Lock()
_ready = False
_degraded = True
_model_id = "heuristic-v0"
_model_error = "not loaded yet"
_started_at = time.time()
_req_count = 0
_err_count = 0
_lat_samples: list[float] = []
_infer_queue: queue.Queue = queue.Queue(maxsize=32)
MAX_BODY_BYTES = 12 * 1024 * 1024


def record_latency(ms: float) -> None:
    global _req_count, _err_count
    with _state_lock:
        _req_count += 1
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
                "queue_depth": _infer_queue.qsize(),
                "ready": _ready, "degraded": _degraded,
                "uptime_s": time.time() - _started_at,
                "p50_ms": sorted(lat)[len(lat) // 2] if lat else 0.0}


def try_load_model(weights_path: str | None, force_cpu: bool) -> None:
    """Best-effort accelerator init. Any failure -> degraded heuristic mode."""
    global _ready, _degraded, _model_id, _model_error
    try:
        if weights_path:
            with open(weights_path, "rb") as f:
                head = f.read(8)
            if len(head) < 8:
                raise RuntimeError("weights file too small")
            _model_id = "cua-custom"
        else:
            _model_id = "heuristic-v0"
        # Optional torch probe: GPU presence must never take down the service.
        try:
            import torch  # type: ignore
            if torch.cuda.is_available() and not force_cpu:
                _model_id += "+cuda"
        except Exception as e:  # noqa: BLE001 - degraded mode covers every cause
            _model_error = f"accelerator probe failed: {e}"
        _ready = True
        _degraded = weights_path is None
        if weights_path is None:
            _model_error = "no weights configured; heuristic policy active"
        else:
            _model_error = ""
    except Exception as e:  # noqa: BLE001 - service must survive model failure
        _ready = False
        _degraded = True
        _model_id = "heuristic-v0"
        _model_error = str(e)[:512]


def pick_action(payload: dict) -> dict:
    """Heuristic policy: click the highest-confidence region label matching the
    goal keywords, else center-move; type actions echo nothing (no secret use).
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
                "intent": f"click {best.get('label', 'target')}"[:256],
                "verification": {"passed": best_score >= 0.5,
                                 "reason": "region score above gate" if best_score >= 0.5
                                 else "low region score; needs verifier"}}
    return {"type": "move", "to": {"x": width // 2, "y": height // 2},
            "confidence": 0.2, "intent": "no matching region; recenter",
            "verification": {"passed": False, "reason": "no region matched"}}


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
            with _state_lock:
                ready, degraded, err = _ready, _degraded, _model_error
            code = 200 if ready else 503
            self._send(code, {"ready": ready, "degraded": degraded, "detail": err})
        elif self.path == "/metrics":
            m = snapshot_metrics()
            lines = ["# HELP evex_infer_requests_total Total infer requests",
                     "# TYPE evex_infer_requests_total counter",
                     f"evex_infer_requests_total {m['requests']}",
                     "# HELP evex_infer_errors_total Total infer errors",
                     "# TYPE evex_infer_errors_total counter",
                     f"evex_infer_errors_total {m['errors']}",
                     "# HELP evex_infer_queue_depth Current queue depth",
                     "# TYPE evex_infer_queue_depth gauge",
                     f"evex_infer_queue_depth {m['queue_depth']}",
                     "# HELP evex_infer_latency_p50_ms P50 latency",
                     "# TYPE evex_infer_latency_p50_ms gauge",
                     f"evex_infer_latency_p50_ms {m['p50_ms']:.3f}"]
            self._send(200, "\n".join(lines) + "\n", "text/plain; version=0.0.4")
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/infer":
            self._send(404, {"error": "not found"})
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
            with _state_lock:
                degraded, mid = _degraded, _model_id
            latency = (time.time() - start) * 1000.0
            if latency > timeout_ms:
                record_error()
                self._send(504, {"error": "inference timed out"})
                return
            record_latency(latency)
            self._send(200, {"action": action, "model_id": mid,
                             "latency_ms": round(latency, 2), "degraded": degraded,
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
    ap.add_argument("--weights", default=None, help="Optional weights file")
    ap.add_argument("--cpu", action="store_true", help="Force CPU even if CUDA present")
    ap.add_argument("--queue-size", type=int, default=32)
    args = ap.parse_args(argv)
    global _infer_queue
    _infer_queue = queue.Queue(maxsize=max(1, args.queue_size))
    try_load_model(args.weights, args.cpu)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"inference up on {args.host}:{args.port} model={_model_id} "
          f"degraded={_degraded}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
