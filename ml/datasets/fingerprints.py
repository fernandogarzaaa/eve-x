"""Visual fingerprints for dataset leakage defense (stdlib only).

Two complementary identities (never similarity-as-identity):

* ``pixel_sha256`` — SHA-256 over canonical grayscale pixels. Cryptographic:
  identical screenshots hash equal even with different frame IDs, metadata,
  or filenames. Different pixels (even 1px) hash different.
* ``phash`` — 64-bit difference hash (dHash) over an 8x8 perceptual grid.
  Near-identical screenshots (minor UI changes, resizes, crops that preserve
  layout) land within a small Hamming distance. Used for LEAKAGE DETECTION
  (flag suspicious cross-split pairs for review), never as sole identity.

PNG support is a minimal stdlib decoder (8-bit RGB/RGBA/grayscale,
non-interlaced). Anything else raises; callers treat undecodable images as
unfingerprinted (recorded, never silently skipped-over as clean).
"""
from __future__ import annotations

import hashlib
import struct
import zlib


def _unchannel(raw: bytes, width: int, height: int, ctype: int) -> list[int]:
    """Unfilter PNG scanlines -> flat grayscale pixels (0-255)."""
    ch = {0: 1, 2: 3, 6: 4}[ctype]
    stride = width * ch
    out: list[int] = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        f = raw[pos]
        pos += 1
        cur = bytearray(raw[pos:pos + stride])
        pos += stride
        if f == 1:
            for i in range(ch, stride):
                cur[i] = (cur[i] + cur[i - ch]) & 0xFF
        elif f == 2:
            for i in range(stride):
                cur[i] = (cur[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = cur[i - ch] if i >= ch else 0
                cur[i] = (cur[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = cur[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                cur[i] = (cur[i] + pr) & 0xFF
        elif f != 0:
            raise ValueError(f"unsupported PNG filter {f}")
        for x in range(width):
            px = cur[x * ch:(x + 1) * ch]
            if ch == 1:
                out.append(px[0])
            elif ch == 2:
                out.append((px[0] * 299 + px[1] * 587 + px[2] * 114) // 1000)
            else:
                r, g, b = px[0], px[1], px[2]
                a = px[3] if ch == 4 else 255
                # Composite alpha over mid-gray so transparency is stable.
                rr = (r * a + 128 * (255 - a)) // 255
                gg = (g * a + 128 * (255 - a)) // 255
                bb = (b * a + 128 * (255 - a)) // 255
                out.append((rr * 299 + gg * 587 + bb * 114) // 1000)
        prev = cur
    return out


def read_png(data: bytes) -> tuple[int, int, list[int]]:
    """Decode PNG -> (width, height, grayscale pixels). Raises on anything
    outside the supported subset (callers record unfingerprinted)."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    width = height = bitdepth = ctype = interlace = -1
    raw = b""
    while pos < len(data):
        if pos + 8 > len(data):
            raise ValueError("truncated PNG chunk header")
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype4 = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise ValueError("truncated PNG chunk body")
        if ctype4 == b"IHDR":
            width, height, bitdepth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if bitdepth != 8 or ctype not in (0, 2, 6) or interlace != 0:
                raise ValueError(f"unsupported PNG mode depth={bitdepth} ctype={ctype} interlace={interlace}")
        elif ctype4 == b"IDAT":
            raw += body
        elif ctype4 == b"IEND":
            break
        pos += 12 + length
    if width < 0:
        raise ValueError("PNG missing IHDR")
    pixels = _unchannel(zlib.decompress(raw), width, height, ctype)
    return width, height, pixels


def _resize_gray(pixels: list[int], w: int, h: int, tw: int, th: int) -> list[int]:
    out = []
    for y in range(th):
        for x in range(tw):
            x0 = (x * w) // tw
            y0 = (y * h) // th
            out.append(pixels[y0 * w + x0])
    return out


def dhash(pixels: list[int], w: int, h: int) -> int:
    """64-bit difference hash over a 9x8 perceptual grid."""
    small = _resize_gray(pixels, w, h, 9, 8)
    bits = 0
    for y in range(8):
        for x in range(8):
            bits = (bits << 1) | (1 if small[y * 9 + x] > small[y * 9 + x + 1] else 0)
    return bits


def hamming(a: int, b: int) -> int:
    n = a ^ b
    c = 0
    while n:
        c += n & 1
        n >>= 1
    return c


def fingerprint_png(data: bytes) -> dict:
    """Full visual identity: pixel digest + perceptual hash + dimensions."""
    w, h, pixels = read_png(data)
    blob = struct.pack(">II", w, h) + bytes(pixels)
    return {
        "visual_sha256": hashlib.sha256(blob).hexdigest(),
        "visual_phash": f"{dhash(pixels, w, h):016x}",
        "visual_w": w,
        "visual_h": h,
    }
