import { z } from "zod";
import { BBox, Point } from "../../protocol/src/index.js";
import { prng } from "../../core/src/index.js";

// ── Inputs / outputs ─────────────────────────────────────────────────────────

export const LumaFrame = z.object({
  width: z.number().int().min(8).max(7680),
  height: z.number().int().min(8).max(4320),
  luma: z.instanceof(Uint8Array),
});
export type LumaFrame = z.infer<typeof LumaFrame>;

export const RegionCandidate = z.object({
  regionId: z.string(),
  bbox: BBox,
  score: z.number().min(0).max(1),
});
export type RegionCandidate = z.infer<typeof RegionCandidate>;

export const ProposeOptions = z.object({
  scales: z.array(z.number().int().min(8).max(512)).default([24, 48, 96, 192]),
  maxCandidates: z.number().int().min(1).max(200).default(24),
  edgeThreshold: z.number().int().min(8).max(256).default(64),
  nmsIou: z.number().min(0).max(1).default(0.5),
});
export type ProposeOptions = z.infer<typeof ProposeOptions>;

// ── Edge field (Sobel magnitude on luminance) ────────────────────────────────

function sobel(frame: { width: number; height: number; luma: Uint8Array }, threshold: number): Float32Array {
  const { width, height, luma } = frame;
  const mag = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -(luma[i - width - 1] ?? 0) - 2 * (luma[i - 1] ?? 0) - (luma[i + width - 1] ?? 0) +
        (luma[i - width + 1] ?? 0) + 2 * (luma[i + 1] ?? 0) + (luma[i + width + 1] ?? 0);
      const gy =
        -(luma[i - width - 1] ?? 0) - 2 * (luma[i - width] ?? 0) - (luma[i - width + 1] ?? 0) +
        (luma[i + width - 1] ?? 0) + 2 * (luma[i + width] ?? 0) + (luma[i + width + 1] ?? 0);
      mag[i] = Math.sqrt(gx * gx + gy * gy) >= threshold ? 1 : 0;
    }
  }
  return mag;
}

function windowDensity(mag: Float32Array, width: number, x0: number, y0: number, size: number): number {
  let e = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) e += mag[y * width + x] ?? 0;
  }
  return e / (size * size);
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  const iw = Math.max(0, ix1 - ix0 + 1);
  const ih = Math.max(0, iy1 - iy0 + 1);
  const inter = iw * ih;
  if (inter === 0) return 0;
  const areaA = (a[2] - a[0] + 1) * (a[3] - a[1] + 1);
  const areaB = (b[2] - b[0] + 1) * (b[3] - b[1] + 1);
  return inter / (areaA + areaB - inter);
}

/**
 * Multi-scale sliding-window proposer over luminance edges. Fully
 * deterministic for a fixed seed: window order, scoring jitter, and NMS
 * tie-breaks all derive from prng(seed).
 */
export function proposeRegions(frameInput: unknown, seedInput: unknown, optsInput: unknown = {}): RegionCandidate[] {
  const frame = LumaFrame.parse(frameInput);
  const seed = z.number().int().parse(seedInput);
  const opts = ProposeOptions.parse(optsInput);
  if (frame.luma.length < frame.width * frame.height) {
    throw new Error("luma buffer smaller than width*height");
  }
  const rand = prng(seed);
  const mag = sobel(frame, opts.edgeThreshold);
  interface Scored {
    bbox: [number, number, number, number];
    score: number;
    order: number;
  }
  const scored: Scored[] = [];
  let order = 0;
  for (const size of [...opts.scales].sort((a, b) => a - b)) {
    if (size >= frame.width || size >= frame.height) continue;
    const stride = Math.max(4, Math.floor(size / 2));
    for (let y0 = 0; y0 + size <= frame.height; y0 += stride) {
      for (let x0 = 0; x0 + size <= frame.width; x0 += stride) {
        const density = windowDensity(mag, frame.width, x0, y0, size);
        if (density < 0.02) continue;
        // center bias: controls near the middle of the screen win ties
        const cx = (x0 + size / 2) / frame.width - 0.5;
        const cy = (y0 + size / 2) / frame.height - 0.5;
        const centerBonus = 0.1 * (1 - Math.min(1, Math.sqrt(cx * cx + cy * cy) * 2));
        // deterministic jitter breaks exact ties without harming ranking
        const jitter = (rand() - 0.5) * 0.01;
        const score = Math.max(0, Math.min(1, density * 0.9 + centerBonus + jitter));
        scored.push({ bbox: [x0, y0, x0 + size - 1, y0 + size - 1], score, order: order++ });
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const kept: Scored[] = [];
  for (const s of scored) {
    if (kept.length >= opts.maxCandidates * 3) break;
    let clash = false;
    for (const k of kept) {
      if (iou(s.bbox, k.bbox) > opts.nmsIou) { clash = true; break; }
    }
    if (!clash) kept.push(s);
  }
  return kept.slice(0, opts.maxCandidates).map((s, i) =>
    RegionCandidate.parse({ regionId: `r-${seed}-${i}`, bbox: s.bbox, score: Math.round(s.score * 1000) / 1000 }),
  );
}

// ── Coordinate resolver (region -> actuator point, resolved at exec time) ────

export const ResolveOptions = z.object({
  position: z.enum(["center", "top-left", "bottom-right"]).default("center"),
  screenWidth: z.number().int().min(1).max(7680).optional(),
  screenHeight: z.number().int().min(1).max(4320).optional(),
});
export type ResolveOptions = z.infer<typeof ResolveOptions>;

export function resolveToPoint(bboxInput: unknown, optsInput: unknown = {}): z.infer<typeof Point> {
  const bbox = BBox.parse(bboxInput);
  const opts = ResolveOptions.parse(optsInput);
  let x: number;
  let y: number;
  if (opts.position === "top-left") { x = bbox[0]; y = bbox[1]; }
  else if (opts.position === "bottom-right") { x = bbox[2]; y = bbox[3]; }
  else { x = Math.floor((bbox[0] + bbox[2]) / 2); y = Math.floor((bbox[1] + bbox[3]) / 2); }
  if (opts.screenWidth !== undefined) x = Math.max(0, Math.min(opts.screenWidth - 1, x));
  if (opts.screenHeight !== undefined) y = Math.max(0, Math.min(opts.screenHeight - 1, y));
  return Point.parse({ x, y });
}
