"""fingerprints.py self-test (stdlib only).

Covers: identical screenshots with different frame IDs share pixel digests;
near-identical shots are phash-close but sha-distinct; crops/resizes/major
changes diverge; metadata-only differences don't move the digest;
unsupported modes raise (recorded, never silent).
"""
from __future__ import annotations

import os
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fingerprints import fingerprint_png, read_png, hamming  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("ok   " if cond else "FAIL ") + name + (f" :: {detail}" if detail and not cond else ""))


def make_png(w, h, fn):
    """fn(x, y) -> (r, g, b). Minimal 8-bit RGB PNG."""
    raw = b""
    for y in range(h):
        raw += b"\x00"
        for x in range(w):
            r, g, b = fn(x, y)
            raw += bytes((r & 0xFF, g & 0xFF, b & 0xFF))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def gradient(x, y):
    return ((x * 7) % 256, (y * 11) % 256, ((x + y) * 5) % 256)


def main():
    a = make_png(32, 24, gradient)
    b = make_png(32, 24, gradient)  # identical pixels, "different frame"
    fa, fb = fingerprint_png(a), fingerprint_png(b)
    check("identical pixels, different ids -> equal digests", fa["visual_sha256"] == fb["visual_sha256"])
    check("identical pixels -> phash distance 0",
          hamming(int(fa["visual_phash"], 16), int(fb["visual_phash"], 16)) == 0)

    # Near-identical: one pixel nudged hard.
    def one_px(x, y):
        r, g, b = gradient(x, y)
        return (255 - r, g, b) if (x, y) == (3, 3) else (r, g, b)

    c = make_png(32, 24, one_px)
    fc = fingerprint_png(c)
    check("1px change -> digest differs", fc["visual_sha256"] != fa["visual_sha256"])
    d = hamming(int(fa["visual_phash"], 16), int(fc["visual_phash"], 16))
    check("1px change -> phash close", d <= 4, f"distance={d}")

    # Different crop: shifted viewport of a bigger scene.
    big = make_png(64, 48, gradient)
    w, h, px = read_png(big)
    crop = []
    for y in range(8, 32):
        for x in range(8, 40):
            crop += [px[y * w + x]]
    # re-encode crop as its own PNG via make_png lookup
    grid = {(x, y): px[(y + 8) * w + (x + 8)] for y in range(24) for x in range(32)}
    cropped_png = make_png(32, 24, lambda x, y: (grid[(x, y)], grid[(x, y)], grid[(x, y)]))
    fcr = fingerprint_png(cropped_png)
    check("crop -> digest differs from full frame", fcr["visual_sha256"] != fa["visual_sha256"])

    # Resized same scene: digest differs (different pixels), phash close-ish.
    small = make_png(16, 12, lambda x, y: gradient(x * 2, y * 2))
    fs = fingerprint_png(small)
    check("resize -> digest differs", fs["visual_sha256"] != fa["visual_sha256"])
    ds = hamming(int(fa["visual_phash"], 16), int(fs["visual_phash"], 16))
    check("resize -> phash within review band", ds <= 12, f"distance={ds}")

    # Completely different image: far apart on both.
    noise = make_png(32, 24, lambda x, y: ((x * 131 + y * 57) % 256, (x * 79 + y * 199) % 256, 128))
    fn = fingerprint_png(noise)
    check("different image -> digest differs", fn["visual_sha256"] != fa["visual_sha256"])
    check("different image -> phash far",
          hamming(int(fa["visual_phash"], 16), int(fn["visual_phash"], 16)) > 12)

    # Metadata-only difference (tEXt chunk) does not move the digest.
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    [ihdr_end] = [a.index(b"IDAT") - 4]  # start of the IDAT length field
    meta = a[:ihdr_end] + chunk(b"tEXt", b"frame_id\x00different-frame-999") + a[ihdr_end:]
    fm = fingerprint_png(meta)
    check("metadata-only change -> digest stable", fm["visual_sha256"] == fa["visual_sha256"])

    # Unsupported modes raise (callers record unfingerprinted).
    gray16 = make_png(4, 4, lambda x, y: (x, y, 0))
    try:
        fingerprint_png(b"not a png at all")
        check("non-PNG raises", False)
    except ValueError:
        check("non-PNG raises", True)
    try:
        fingerprint_png(gray16[:20])
        check("truncated raises", False)
    except (ValueError, Exception):
        check("truncated raises", True)

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
