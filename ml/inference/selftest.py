"""EVE-X inference self-test (stdlib only; no torch required).

Exercises the ModelRuntime verification chain with a stub torch module
injected into sys.modules, plus live HTTP checks (readiness table, auth,
identity fields) against ephemeral servers. Run: python3 selftest.py
Exit nonzero on any failure.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import struct
import sys
import tempfile
import threading
import types
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import server as S  # noqa: E402


PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


class FakeTensor:
    def __init__(self, n, finite=True):
        self._n = n
        self._finite = finite

    def numel(self):
        return self._n


class FakeFinite:
    def __init__(self, ok):
        self._ok = ok

    def all(self):
        return self._ok


def install_fake_torch(mode="ok"):
    mod = types.ModuleType("torch")
    mod.cuda = types.SimpleNamespace(is_available=lambda: False)

    def fake_load(path, map_location=None, weights_only=None):
        if mode == "load-error":
            raise RuntimeError("boom in torch.load")
        if mode == "nonfinite":
            return {"w": FakeTensor(10, False)}
        if mode == "empty":
            return {}
        if mode == "not-module":
            return 42

        class M:
            def parameters(self):
                return [FakeTensor(100), FakeTensor(23)]

        return M()

    def fake_isfinite(t):
        ok = t._finite if isinstance(t, FakeTensor) else True

        class B:
            def all(self):
                return ok

        return B()

    mod.load = fake_load
    mod.isfinite = fake_isfinite
    sys.modules["torch"] = mod


def remove_torch():
    sys.modules.pop("torch", None)


def make_weights(fmt="pickle", size=64):
    if fmt == "safetensors":
        header = b'{"a":1}'
        head = struct.pack("<Q", len(header)) + header
    elif fmt == "zip":
        head = b"PK\x03\x04" + b"\x00" * 32
    elif fmt == "pickle":
        head = b"\x80\x04" + b"\x00" * 32
    else:
        head = b"ZZZZZZZZ" + b"\x00" * 32
    body = head + os.urandom(max(0, size - len(head)))
    f = tempfile.NamedTemporaryFile(delete=False, suffix=".bin")
    f.write(body)
    f.close()
    digest = hashlib.sha256(body).hexdigest()
    return f.name, digest, len(body)


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


def serve(port_holder, **kw):
    from http.server import ThreadingHTTPServer
    srv = ThreadingHTTPServer(("127.0.0.1", 0), S.Handler)
    port_holder.append(srv.server_address[1])
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


def get(port, path, token=None):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def post(port, path, body, token=None):
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


FRAME = {"frame_id": "f-1", "goal": "open settings", "width": 1280,
         "height": 800, "png_base64": "aGk=", "regions": []}


def main():
    # 1. good weights + stub torch -> ready, verified identity, degraded acts
    install_fake_torch("ok")
    reset_state()
    p, digest, size = make_weights("pickle")
    S.try_load_model(p, True, expected_sha256=digest, expected_bytes=size,
                     expected_arch="cua-test", model_id=None)
    ident = S._snapshot_identity()
    check("verified weights -> ready", ident["ready"] is True)
    check("verified weights keep degraded=true (heuristic acts)", ident["degraded"] is True)
    check("model_id embeds digest", digest[:16] in ident["model_id"], ident["model_id"])
    check("model_sha256 recorded", ident["model_sha256"] == digest)
    check("weights_verified true", ident["weights_verified"] is True)
    check("action_source names heuristic", ident["action_source"] == S.HEURISTIC_POLICY_ID)

    # 2. bad sha -> not ready, reason names sha256
    reset_state()
    S.try_load_model(p, True, expected_sha256="0" * 64, expected_bytes=size)
    ident = S._snapshot_identity()
    check("sha mismatch -> not ready", ident["ready"] is False)
    check("sha mismatch reason", "sha256" in ident["detail"].lower(), ident["detail"])

    # 3. bad size -> not ready
    reset_state()
    S.try_load_model(p, True, expected_sha256=digest, expected_bytes=size + 1)
    check("size mismatch -> not ready", S._snapshot_identity()["ready"] is False)

    # 4. unknown container -> not ready (pinned, so the format gate is
    # genuinely what refuses — not the pin requirement)
    reset_state()
    q, qdigest, _ = make_weights("bogus")
    S.try_load_model(q, True, expected_sha256=qdigest)
    ident = S._snapshot_identity()
    check("unknown format refused", ident["ready"] is False and "format" in ident["detail"].lower(),
          ident["detail"])

    # 4b. unpinned artifact -> not ready even when the file is well-formed
    reset_state()
    S.try_load_model(p, True)
    ident = S._snapshot_identity()
    check("unpinned weights refused", ident["ready"] is False and "pin required" in ident["detail"],
          ident["detail"])

    # 5. torch.load raising -> not ready
    install_fake_torch("load-error")
    reset_state()
    S.try_load_model(p, True, expected_sha256=digest)
    ident = S._snapshot_identity()
    check("torch.load failure -> not ready", ident["ready"] is False and "torch.load" in ident["detail"],
          ident["detail"])

    # 6. non-finite params -> not ready
    install_fake_torch("nonfinite")
    reset_state()
    S.try_load_model(p, True, expected_sha256=digest)
    check("non-finite params refused", S._snapshot_identity()["ready"] is False)

    # 7. empty params -> not ready
    install_fake_torch("empty")
    reset_state()
    S.try_load_model(p, True, expected_sha256=digest)
    check("empty model refused", S._snapshot_identity()["ready"] is False)

    # 8. no torch at all -> not ready (names torch)
    remove_torch()
    import builtins
    real_import = builtins.__import__

    def no_torch(name, *a, **k):
        if name == "torch":
            raise ImportError("No module named torch")
        return real_import(name, *a, **k)

    builtins.__import__ = no_torch
    try:
        reset_state()
        S.try_load_model(p, True, expected_sha256=digest)
        ident = S._snapshot_identity()
        check("missing torch -> not ready", ident["ready"] is False and "torch" in ident["detail"].lower(),
              ident["detail"])
    finally:
        builtins.__import__ = real_import
    install_fake_torch("ok")

    # 9. manifest agreement enforced
    reset_state()
    man = tempfile.NamedTemporaryFile(delete=False, suffix=".json", mode="w")
    json.dump({"sha256": digest, "bytes": size, "arch": "cua-test", "format": "torch-pickle"}, man)
    man.close()
    S.try_load_model(p, True, manifest_path=man.name)
    check("manifest agreement -> ready", S._snapshot_identity()["ready"] is True)
    reset_state()
    S.try_load_model(p, True, expected_arch="other-arch", manifest_path=man.name)
    check("arch honored from explicit flag", S._snapshot_identity()["architecture"] == "other-arch")

    # 10. heuristic requires the explicit flag
    reset_state()
    S.try_load_model(None, True)
    check("no weights + no flag -> not ready", S._snapshot_identity()["ready"] is False)
    reset_state()
    S.try_load_model(None, True, allow_heuristic=True)
    ident = S._snapshot_identity()
    check("explicit heuristic -> ready+degraded", ident["ready"] is True and ident["degraded"] is True)
    check("heuristic identity honest", ident["model_id"] == S.HEURISTIC_POLICY_ID
          and ident["weights_verified"] is False)

    # 11. live HTTP: not-ready serves 503, never heuristic-as-model
    reset_state()
    S.try_load_model("/nonexistent-weights.bin", True)
    ports = []
    srv = serve(ports)
    port = ports[0]
    code, body = get(port, "/ready")
    check("not-ready /ready is 503", code == 503, f"{code} {body}")
    code, body = post(port, "/infer", FRAME)
    check("not-ready /infer is 503 model-not-loaded", code == 503 and body.get("error") == "model-not-loaded",
          f"{code} {body}")
    code, _ = get(port, "/health")
    check("/health stays open", code == 200)
    srv.shutdown()

    # 12. live HTTP: heuristic serves with honest identity fields
    reset_state()
    S.try_load_model(None, True, allow_heuristic=True)
    ports = []
    srv = serve(ports)
    port = ports[0]
    code, body = get(port, "/ready")
    check("heuristic /ready is 200", code == 200, f"{code}")
    code, body = post(port, "/infer", FRAME)
    check("heuristic /infer 200", code == 200, f"{code} {body}")
    for field in ("action", "action_source", "model_id", "model_version",
                  "model_sha256", "architecture", "device", "degraded",
                  "weights_verified", "latency_ms", "frame_id"):
        check(f"response carries {field}", field in body, str(body.keys()))
    check("heuristic degraded=true", body.get("degraded") is True)
    check("heuristic action_source named", body.get("action_source") == S.HEURISTIC_POLICY_ID)
    check("frame echoed", body.get("frame_id") == "f-1")
    code, body = get(port, "/model-info")
    check("/model-info identity", code == 200 and body.get("model_id") == S.HEURISTIC_POLICY_ID,
          f"{code} {body}")
    srv.shutdown()

    # 13. auth enforced when a token is set
    reset_state()
    with S._state_lock:
        S._require_token = "test-token-123"
    S.try_load_model(None, True, allow_heuristic=True)
    ports = []
    srv = serve(ports)
    port = ports[0]
    code, _ = post(port, "/infer", FRAME)
    check("missing bearer -> 401", code == 401, f"{code}")
    code, _ = post(port, "/infer", FRAME, token="wrong")
    check("wrong bearer -> 401", code == 401, f"{code}")
    code, body = post(port, "/infer", FRAME, token="test-token-123")
    check("correct bearer -> 200", code == 200, f"{code}")
    code, _ = get(port, "/model-info")
    check("/model-info without bearer -> 401", code == 401, f"{code}")
    code, _ = get(port, "/metrics")
    check("/metrics without bearer -> 401 (identity in labels)", code == 401, f"{code}")
    import urllib.request as _urlreq

    def get_metrics_text(token=None):
        _req = _urlreq.Request(f"http://127.0.0.1:{port}/metrics")
        if token:
            _req.add_header("Authorization", f"Bearer {token}")
        try:
            with _urlreq.urlopen(_req, timeout=10) as _r:
                return _r.status, _r.read().decode()
        except urllib.error.HTTPError as _e:
            return _e.code, _e.read().decode()

    _code, _text = get_metrics_text(token="test-token-123")
    check("/metrics with bearer -> 200", _code == 200, f"{_code}")
    check("/metrics carries model identity labels", 'model_id="heuristic-v1"' in _text, _text[:160])
    code, _ = get(port, "/ready")
    check("/ready open despite auth (orchestrator probe)", code == 200, f"{code}")
    code, _ = get(port, "/health")
    check("/health open despite auth", code == 200, f"{code}")
    srv.shutdown()

    # 14. binding 0.0.0.0 without a token refuses unless explicitly allowed
    reset_state()
    with S._state_lock:
        S._require_token = ""
    rc = S.main(["--host", "0.0.0.0", "--port", "18099"])
    check("0.0.0.0 without token refuses (exit 2)", rc == 2, f"rc={rc}")

    for f in (p, q):
        try:
            os.unlink(f)
        except OSError:
            pass
    try:
        os.unlink(man.name)
    except OSError:
        pass
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
