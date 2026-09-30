import { inflateSync } from "node:zlib";
import { EventEmitter } from "node:events";
import { z } from "zod";
import { ComputerPercept, Provenance, Point, BBox } from "../../protocol/src/index.js";
import { EveError, nowIso, uid } from "../../core/src/index.js";

// ── Minimal PNG decoder (8-bit; color types 0/2/4/6; no external deps) ───────

export interface DecodedFrame {
  width: number;
  height: number;
  luma: Uint8Array;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(pngInput: unknown): DecodedFrame {
  const png: Buffer = Buffer.isBuffer(pngInput)
    ? pngInput
    : Buffer.from(z.instanceof(Uint8Array).parse(pngInput));
  if (png.length < 33) throw new EveError("BAD_PNG", "Buffer too short to be a PNG");
  for (let i = 0; i < 8; i++) {
    if (png[i] !== PNG_SIG[i]) throw new EveError("BAD_PNG", "Missing PNG signature");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? -1;
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (width <= 0 || height <= 0 || width > 7680 || height > 4320) {
    throw new EveError("BAD_PNG", `Bad IHDR dimensions ${width}x${height}`);
  }
  if (bitDepth !== 8) throw new EveError("BAD_PNG", `Only 8-bit PNG supported, got ${bitDepth}`);
  if (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6) {
    throw new EveError("BAD_PNG", `Unsupported PNG color type ${colorType}`);
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const stride = width * channels;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new EveError("BAD_PNG", "IDAT inflate failed");
  }
  if (raw.length < height * (stride + 1)) throw new EveError("BAD_PNG", "Truncated IDAT payload");
  const luma = new Uint8Array(width * height);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0;
    for (let i = 0; i < stride; i++) cur[i] = raw[p++] ?? 0;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (cur[i - channels] ?? 0) : 0;
      const b = prev[i] ?? 0;
      const c = i >= channels ? (prev[i - channels] ?? 0) : 0;
      let v = cur[i] ?? 0;
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        v = (v + pr) & 255;
      }
      cur[i] = v;
    }
    for (let x = 0; x < width; x++) {
      let l: number;
      if (channels === 1) l = cur[x] ?? 0;
      else if (channels === 2) l = cur[x * 2] ?? 0;
      else l = (((cur[x * 3] ?? 0) * 77 + (cur[x * 3 + 1] ?? 0) * 150 + (cur[x * 3 + 2] ?? 0) * 29) >> 8) & 255;
      luma[y * width + x] = l;
    }
    prev.set(cur);
  }
  return { width, height, luma };
}

// ── Layout analysis (human-perception boundary: pixels only, never VM state) ─

export const TextRegion = z.object({
  regionId: z.string(),
  bbox: BBox,
  label: z.string(),
  confidence: z.number().min(0).max(1),
});
export type TextRegion = z.infer<typeof TextRegion>;

export interface FrameAnalysis {
  width: number;
  height: number;
  regions: TextRegion[];
  cursor: z.infer<typeof Point>;
  dialogs: string[];
  loading: boolean;
}

function edgeMap(luma: Uint8Array, width: number, height: number): Uint8Array {
  const edges = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const gx = Math.abs((luma[y * width + x + 1] ?? 0) - (luma[y * width + x - 1] ?? 0));
      const gy = Math.abs((luma[(y + 1) * width + x] ?? 0) - (luma[(y - 1) * width + x] ?? 0));
      edges[y * width + x] = gx + gy > 64 ? 1 : 0;
    }
  }
  return edges;
}

/** Row-projection text bands, split into column-projection regions. */
function textRegions(frame: DecodedFrame, maxRegions: number): TextRegion[] {
  const { width, height, luma } = frame;
  const darkFrac: number[] = new Array<number>(height).fill(0);
  for (let y = 0; y < height; y++) {
    let dark = 0;
    for (let x = 0; x < width; x += 2) {
      if ((luma[y * width + x] ?? 255) < 128) dark++;
    }
    darkFrac[y] = dark / Math.ceil(width / 2);
  }
  const bands: Array<[number, number]> = [];
  let start = -1;
  for (let y = 0; y <= height; y++) {
    const on = y < height && (darkFrac[y] ?? 0) > 0.04;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (y - start >= 6) bands.push([start, y - 1]);
      start = -1;
    }
  }
  const out: TextRegion[] = [];
  let n = 0;
  for (const [y0, y1] of bands) {
    const col: number[] = new Array<number>(width).fill(0);
    for (let x = 0; x < width; x++) {
      let dark = 0;
      for (let y = y0; y <= y1; y += 1) {
        if ((luma[y * width + x] ?? 255) < 128) dark++;
      }
      col[x] = dark / (y1 - y0 + 1);
    }
    let cs = -1;
    const spans: Array<[number, number]> = [];
    for (let x = 0; x <= width; x++) {
      const on = x < width && (col[x] ?? 0) > 0.15;
      if (on && cs < 0) cs = x;
      if (!on && cs >= 0) {
        if (x - cs >= 8) spans.push([cs, x - 1]);
        cs = -1;
      }
    }
    for (const [x0, x1] of spans) {
      if (out.length >= maxRegions) return out;
      const density = spans.length > 0 ? Math.min(1, ((x1 - x0 + 1) * (y1 - y0 + 1)) / (width * height) * 40 + 0.35) : 0.35;
      out.push({
        regionId: `t-${n++}`,
        bbox: [x0, y0, x1, y1],
        label: "text-line",
        confidence: Math.round(Math.min(0.95, Math.max(0.3, density)) * 100) / 100,
      });
    }
    if (out.length >= maxRegions) break;
  }
  return out;
}

/** Cursor heuristic: pixel with the strongest dark-on-bright local contrast. */
function cursorGuess(frame: DecodedFrame): z.infer<typeof Point> {
  const { width, height, luma } = frame;
  let best = 0;
  let bx = 0;
  let by = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 240));
  for (let y = 2; y < height - 2; y += step) {
    for (let x = 2; x < width - 2; x += step) {
      const c = luma[y * width + x] ?? 0;
      let ring = 0;
      for (let k = -2; k <= 2; k++) {
        ring += luma[(y - 2) * width + x + k] ?? 0;
        ring += luma[(y + 2) * width + x + k] ?? 0;
      }
      const contrast = Math.abs(ring / 10 - c);
      if (contrast > best) { best = contrast; bx = x; by = y; }
    }
  }
  return Point.parse({ x: bx, y: by });
}

/** Dialog heuristic: strong border edges around the centered 60% box. */
function dialogGuess(frame: DecodedFrame, edges: Uint8Array): string[] {
  const { width, height } = frame;
  const x0 = Math.floor(width * 0.2);
  const x1 = Math.floor(width * 0.8);
  const y0 = Math.floor(height * 0.2);
  const y1 = Math.floor(height * 0.8);
  let border = 0;
  let total = 0;
  for (let x = x0; x <= x1; x++) {
    for (const y of [y0, y0 + 1, y1 - 1, y1]) {
      total++;
      if (edges[y * width + x]) border++;
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (const x of [x0, x0 + 1, x1 - 1, x1]) {
      total++;
      if (edges[y * width + x]) border++;
    }
  }
  const ratio = total > 0 ? border / total : 0;
  return ratio > 0.18 ? ["center-dialog"] : [];
}

/** Loading heuristic: busy center with almost no stable text bands. */
function loadingGuess(frame: DecodedFrame, edges: Uint8Array, regionCount: number): boolean {
  const { width, height } = frame;
  const x0 = Math.floor(width * 0.35);
  const x1 = Math.floor(width * 0.65);
  const y0 = Math.floor(height * 0.35);
  const y1 = Math.floor(height * 0.65);
  let e = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      if (edges[y * width + x]) e++;
    }
  }
  const density = total > 0 ? e / total : 0;
  return density > 0.12 && regionCount < 3;
}

export function makeProvenance(channel: string): z.infer<typeof Provenance> {
  return Provenance.parse({ source: "screenshot", channel, at: nowIso() });
}

export function analyzePng(pngInput: unknown, channel = "perception"): FrameAnalysis {
  const frame = decodePng(pngInput);
  const edges = edgeMap(frame.luma, frame.width, frame.height);
  const regions = textRegions(frame, 64);
  return {
    width: frame.width,
    height: frame.height,
    regions,
    cursor: cursorGuess(frame),
    dialogs: dialogGuess(frame, edges),
    loading: loadingGuess(frame, edges, regions.length),
  };
}

// ── ScreenStream (agent-raw vs human-overlay subscribers) ────────────────────

export const OverlayFrame = z.object({
  frameId: z.string(),
  percept: ComputerPercept,
  boxes: z.array(z.object({
    bbox: BBox,
    label: z.string(),
    kind: z.enum(["text", "cursor", "dialog"]),
  })),
});
export type OverlayFrame = z.infer<typeof OverlayFrame>;

export type StreamKind = "agent-raw" | "human-overlay";

export class ScreenStream extends EventEmitter {
  private frames = 0;

  subscribe(kind: StreamKind, listener: (frame: ComputerPercept | OverlayFrame) => void): () => void {
    const event = kind === "agent-raw" ? "frame" : "overlay";
    super.on(event, listener);
    return () => { super.off(event, listener); };
  }

  subscriberCount(kind: StreamKind): number {
    return super.listenerCount(kind === "agent-raw" ? "frame" : "overlay");
  }

  pushPng(pngInput: unknown, channel = "screen-stream"): z.infer<typeof ComputerPercept> {
    const png = Buffer.isBuffer(pngInput) ? pngInput : Buffer.from(z.instanceof(Uint8Array).parse(pngInput));
    const frameId = uid("frame");
    const a = analyzePng(png, channel);
    const percept = ComputerPercept.parse({
      frameId,
      width: a.width,
      height: a.height,
      pngBase64: png.toString("base64"),
      regions: a.regions.map((r) => ({
        regionId: `${frameId}:${r.regionId}`,
        bbox: r.bbox,
        label: r.label,
        confidence: r.confidence,
      })),
      cursor: a.cursor,
      windows: [],
      dialogs: a.dialogs,
      loading: a.loading,
      provenance: makeProvenance(channel),
    });
    this.frames++;
    this.emit("frame", percept);
    const overlay = OverlayFrame.parse({
      frameId,
      percept,
      boxes: [
        ...a.regions.map((r) => ({ bbox: r.bbox, label: r.label, kind: "text" as const })),
        { bbox: [a.cursor.x, a.cursor.y, a.cursor.x + 1, a.cursor.y + 1] as [number, number, number, number], label: "cursor", kind: "cursor" as const },
        ...a.dialogs.map((d) => ({
          bbox: [
            Math.floor(a.width * 0.2), Math.floor(a.height * 0.2),
            Math.floor(a.width * 0.8), Math.floor(a.height * 0.8),
          ] as [number, number, number, number],
          label: d,
          kind: "dialog" as const,
        })),
      ],
    });
    this.emit("overlay", overlay);
    return percept;
  }

  frameCount(): number {
    return this.frames;
  }
}
