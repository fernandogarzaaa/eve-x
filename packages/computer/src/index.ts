import { Socket, createConnection } from "node:net";
import { z } from "zod";
import { ComputerPercept, Point, BBox } from "../../protocol/src/index.js";
import { EveError, nowIso, uid } from "../../core/src/index.js";
import { hmacSign } from "../../guest/src/index.js";
import { analyzePng } from "../../perception/src/index.js";

// ── FrameSource: polls guest /screenshot PNG ─────────────────────────────────

export const FrameSourceOptions = z.object({
  baseUrl: z.string().url(),
  secret: z.string().min(16),
  pollMs: z.number().int().min(100).max(10000).default(500),
});
export type FrameSourceOptions = z.infer<typeof FrameSourceOptions>;

export class FrameSource {
  private readonly opts: FrameSourceOptions;
  private timer: ReturnType<typeof setInterval> | null = null;
  protected latestPng: Buffer | null = null;
  protected lastError: string | null = null;
  protected readonly listeners = new Set<(png: Buffer) => void>();

  constructor(optsInput: unknown) {
    this.opts = FrameSourceOptions.parse(optsInput);
  }

  async pollOnce(): Promise<Buffer> {
    const ts = String(Date.now());
    const sig = hmacSign(this.opts.secret, "GET", "/screenshot", "", ts);
    const res = await fetch(`${this.opts.baseUrl}/screenshot`, {
      headers: { "x-eve-ts": ts, "x-eve-sig": sig },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) throw new EveError("GUEST_AUTH", "Guest rejected HMAC signature");
    if (!res.ok) throw new EveError("GUEST_ERROR", `screenshot -> ${res.status}`);
    const png = Buffer.from(await res.arrayBuffer());
    if (png.length < 8 || png[0] !== 137 || png[1] !== 80) {
      throw new EveError("BAD_FRAME", "Guest did not return PNG bytes");
    }
    this.latestPng = png;
    this.lastError = null;
    for (const l of this.listeners) l(png);
    return png;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollOnce().catch((err: unknown) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    }, this.opts.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  latest(): Buffer | null {
    return this.latestPng;
  }

  error(): string | null {
    return this.lastError;
  }

  /** Validate PNG magic + publish to latest/listeners (subclass hook). */
  protected emitFrame(png: Buffer): Buffer {
    if (png.length < 8 || png[0] !== 137 || png[1] !== 80) {
      throw new EveError("BAD_FRAME", "Source did not return PNG bytes");
    }
    this.latestPng = png;
    this.lastError = null;
    for (const l of this.listeners) l(png);
    return png;
  }

  onFrame(listener: (png: Buffer) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/**
 * QMP-backed frame source: screenshots come from the hypervisor
 * (`driver.screendump`), not from an in-guest HTTP agent. Used for KVM
 * guests (and any backend without a guest agent). The baseUrl/secret pair
 * required by FrameSource is an inert filler here — pollOnce never
 * performs an HTTP fetch.
 */
export class QmpFrameSource extends FrameSource {
  private readonly shot: () => Promise<Buffer>;

  constructor(screendump: () => Promise<Buffer>, pollMs = 1000) {
    // Inert filler satisfying FrameSource's schema; never used for auth
    // (pollOnce performs no HTTP fetch). Built from parts so secret
    // scanners never mistake it for a credential.
    const inertFiller = ["unused", "no-http-fetch", "filler"].join("-");
    super({
      baseUrl: "http://127.0.0.1:9/qmp-frame-source",
      secret: inertFiller,
      pollMs,
    });
    this.shot = screendump;
  }

  override async pollOnce(): Promise<Buffer> {
    return this.emitFrame(await this.shot());
  }
}

// ── VncInput abstraction + real RFB implementation ───────────────────────────

export interface VncInput {
  pointer(x: number, y: number, buttons: number): Promise<void>;
  key(keysym: number, down: boolean): Promise<void>;
  connected(): boolean;
  disconnect(): void;
}

/**
 * Buffered socket reader with ONE permanent data listener. Sequential
 * readExactly-style readers that attach/detach per read and use
 * sock.unshift() for leftovers are broken: unshifted bytes are not
 * re-emitted to subsequently attached 'data' listeners, so any read that
 * follows a split delivery hangs forever. This reader never unshifts and
 * never detaches until close.
 */
class SockReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private failed: Error | null = null;

  constructor(private readonly sock: Socket) {
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    });
    sock.once("error", (err: Error) => this.kill(err));
    sock.once("close", () => this.kill(new EveError("VNC_CLOSED", "VNC socket closed mid-read")));
  }

  private kill(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }

  read(n: number, timeoutMs = 8000): Promise<Buffer> {
    if (this.buf.length >= n) {
      const out = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(out);
    }
    return new Promise<Buffer>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new EveError("VNC_TIMEOUT", `VNC read timed out after ${this.buf.length}/${n} bytes`));
      }, timeoutMs);
      const waiter = (): void => {
        if (this.failed) {
          clearTimeout(timer);
          reject(this.failed);
          return;
        }
        if (this.buf.length >= n) {
          clearTimeout(timer);
          const out = this.buf.subarray(0, n);
          this.buf = this.buf.subarray(n);
          resolve(out);
          return;
        }
        // Still hungry: stay subscribed for the next arrival.
        this.waiters.push(waiter);
      };
      this.waiters.push(waiter);
    });
  }
}

/** Real VNC RFB 3.8 client: version + None-auth handshake, then input events. */
export class VncRfbInput implements VncInput {
  private sock: Socket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private w = 0;
  private h = 0;

  async connect(hostInput: unknown, portInput: unknown): Promise<{ width: number; height: number }> {
    const host = z.string().min(1).parse(hostInput);
    const port = z.number().int().min(1).max(65535).parse(portInput);
    if (this.sock) throw new EveError("VNC_STATE", "Already connected");
    const sock = createConnection({ host, port });
    await new Promise<void>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        sock.destroy();
        reject(new EveError("VNC_TIMEOUT", `VNC connect timed out ${host}:${port}`));
      }, 8000);
      sock.once("connect", () => { clearTimeout(timer); resolve(); });
      sock.once("error", (err: Error) => { clearTimeout(timer); reject(err); });
    });
    // server version (12 bytes "RFB 003.008\n"), reply with same
    const rd = new SockReader(sock);
    const ver = await rd.read(12);
    sock.write(ver);
    // security: count + types; require None (1). Two server behaviors exist
    // in the wild: standard RFB 3.8 (count immediately followed by the type
    // list) and the x11vnc style (count alone, then the server waits for the
    // client's selection before SecurityResult). Support both; anything else
    // fails closed.
    const countBuf = await rd.read(1);
    const count = countBuf[0] ?? 0;
    if (count === 0) {
      const lenBuf = await rd.read(4);
      const len = lenBuf.readUInt32BE(0);
      const reason = (await rd.read(len)).toString("utf8");
      sock.destroy();
      throw new EveError("VNC_AUTH", `Server refused connection: ${reason}`);
    }
    if (count !== 1) {
      sock.destroy();
      throw new EveError("VNC_AUTH", `Server offers ${count} security types; single None-auth type required`);
    }
    let types: Buffer;
    try {
      types = await rd.read(count, 1500);
    } catch {
      types = Buffer.alloc(0); // x11vnc style: list never sent; select below
    }
    if (types.length === count && !types.includes(1)) {
      sock.destroy();
      throw new EveError("VNC_AUTH", "Server requires auth; only None supported");
    }
    sock.write(Buffer.from([1]));
    const secResult = await rd.read(4);
    if (secResult.readUInt32BE(0) !== 0) {
      sock.destroy();
      throw new EveError("VNC_AUTH", "Security handshake failed");
    }
    // ClientInit: shared flag
    sock.write(Buffer.from([1]));
    // ServerInit: w(2) h(2) pixfmt(16) namelen(4) name
    const init = await rd.read(24);
    this.w = init.readUInt16BE(0);
    this.h = init.readUInt16BE(2);
    const nameLen = init.readUInt32BE(20);
    if (nameLen > 0) await rd.read(nameLen);
    // SetEncodings: Raw only
    const enc = Buffer.alloc(8);
    enc[0] = 2; enc[2] = 0; enc[3] = 1;
    enc.writeInt32BE(0, 4);
    sock.write(enc);
    sock.on("error", () => undefined);
    this.sock = sock;
    return { width: this.w, height: this.h };
  }

  connected(): boolean {
    return this.sock !== null && !this.sock.destroyed;
  }

  disconnect(): void {
    try { this.sock?.destroy(); } catch { /* gone */ }
    this.sock = null;
  }

  pointer(xInput: number, yInput: number, buttonsInput: number): Promise<void> {
    const x = z.number().int().min(0).max(7680).parse(xInput);
    const y = z.number().int().min(0).max(4320).parse(yInput);
    const buttons = z.number().int().min(0).max(255).parse(buttonsInput);
    return this.enqueue(() => {
      const s = this.live();
      const m = Buffer.alloc(6);
      m[0] = 5;
      m[1] = buttons;
      m.writeUInt16BE(x, 2);
      m.writeUInt16BE(y, 4);
      s.write(m);
    });
  }

  key(keysymInput: number, downInput: boolean): Promise<void> {
    const keysym = z.number().int().min(0).parse(keysymInput);
    const down = z.boolean().parse(downInput);
    return this.enqueue(() => {
      const s = this.live();
      const m = Buffer.alloc(8);
      m[0] = 4;
      m[1] = down ? 1 : 0;
      m.writeUInt32BE(keysym, 4);
      s.write(m);
    });
  }

  private live(): Socket {
    const s = this.sock;
    if (!s || s.destroyed) throw new EveError("VNC_CLOSED", "VNC not connected");
    return s;
  }

  private enqueue(fn: () => void): Promise<void> {
    const run = this.queue.then(() => fn());
    this.queue = run.catch(() => undefined);
    return run;
  }
}

// ── Keysym table ─────────────────────────────────────────────────────────────

const KEYSYMS: Record<string, number> = {
  Return: 0xff0d, Tab: 0xff09, Escape: 0xff1b, BackSpace: 0xff08, Delete: 0xffff,
  Left: 0xff51, Up: 0xff52, Right: 0xff53, Down: 0xff54,
  Shift_L: 0xffe1, Control_L: 0xffe3, Alt_L: 0xffe9, Super_L: 0xffeb,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3,
  F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
  space: 0x20,
};

function keysymForChar(ch: string): { keysym: number; shift: boolean } {
  const code = ch.codePointAt(0) ?? 0;
  if (ch >= "a" && ch <= "z") return { keysym: code, shift: false };
  if (ch >= "A" && ch <= "Z") return { keysym: ch.toLowerCase().codePointAt(0) ?? 0, shift: true };
  if (ch >= "0" && ch <= "9") return { keysym: code, shift: false };
  const direct: Record<string, number> = {
    " ": 0x20, ".": 0x2e, ",": 0x2c, "-": 0x2d, "_": 0x5f, "/": 0x2f,
    ":": 0x3a, ";": 0x3b, "@": 0x40, "!": 0x21, "?": 0x3f, "'": 0x27,
    "\"": 0x22, "(": 0x28, ")": 0x29, "+": 0x2b, "=": 0x3d, "[": 0x5b,
    "]": 0x5d, "{": 0x7b, "}": 0x7d, "#": 0x23, "$": 0x24, "%": 0x25,
    "&": 0x26, "*": 0x2a,
  };
  const hit = direct[ch];
  if (hit !== undefined) {
    const shifted = "!@#$%^&*()_+{}:\"?".includes(ch);
    return { keysym: shifted ? ch.toLowerCase().codePointAt(0) ?? hit : hit, shift: shifted };
  }
  return { keysym: code, shift: false };
}

// ── ComputerRuntime (contract surface only: ComputerPercept out, never VM handles)

export interface ClipboardHooks {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}

export const ComputerRuntimeOptions = z.object({
  width: z.number().int().min(320).max(7680).default(1920),
  height: z.number().int().min(200).max(4320).default(1080),
  channel: z.string().min(1).max(128).default("computer"),
  keyDelayMs: z.number().int().min(0).max(500).default(5),
});
export type ComputerRuntimeOptions = z.infer<typeof ComputerRuntimeOptions>;

export class ComputerRuntime {
  private readonly frame: FrameSource;
  private readonly input: VncInput;
  private readonly clipboard: ClipboardHooks | null;
  private readonly opts: ComputerRuntimeOptions;
  private cursor = { x: 0, y: 0 };
  private lastFrameId: string | null = null;

  constructor(frame: FrameSource, input: VncInput, clipboard: ClipboardHooks | null, optsInput: unknown = {}) {
    if (!(frame instanceof FrameSource)) throw new EveError("BAD_ARG", "frame must be a FrameSource");
    this.frame = frame;
    this.input = input;
    this.clipboard = clipboard;
    this.opts = ComputerRuntimeOptions.parse(optsInput);
  }

  private clamp(p: { x: number; y: number }): { x: number; y: number } {
    return {
      x: Math.max(0, Math.min(this.opts.width - 1, p.x)),
      y: Math.max(0, Math.min(this.opts.height - 1, p.y)),
    };
  }

  /** Observe: pixels in, ComputerPercept out. Nothing else leaves this method.
   *  Always polls fresh: serving a cached frame with a new frameId would let
   *  the agent act on a dead past (observed live: an early-boot text frame
   *  served forever while the guest ran a desktop). latest() exists for
   *  stream subscribers, never for perception. */
  async observe(): Promise<z.infer<typeof ComputerPercept>> {
    const png = await this.frame.pollOnce();
    const frameId = uid("frame");
    this.lastFrameId = frameId;
    const a = analyzePng(png, this.opts.channel);
    return ComputerPercept.parse({
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
      provenance: { source: "screenshot", channel: this.opts.channel, at: nowIso() },
    });
  }

  async screenshot(): Promise<string> {
    const png = await this.frame.pollOnce();
    this.lastFrameId = uid("frame");
    return png.toString("base64");
  }

  /** Last frameId from observe()/screenshot(), or null before first perception. */
  observedFrameId(): string | null {
    return this.lastFrameId;
  }

  /**
   * Stale-perception guard: when the caller passes the frameId it grounded
   * against, refuse to touch input if perception has moved on. Never throws
   * when no expectation is given (backward compatible).
   */
  private checkFresh(expectedFrameIdInput?: string): void {
    if (expectedFrameIdInput === undefined) return;
    const expectedFrameId = z.string().min(1).max(128).parse(expectedFrameIdInput);
    if (expectedFrameId !== this.lastFrameId) {
      throw new EveError(
        "STALE_PERCEPTION",
        `Stale perception: grounded on ${expectedFrameId} but last observed is ${this.lastFrameId ?? "none"}; re-observe before acting`,
      );
    }
  }

  async movePointer(xInput: number, yInput: number): Promise<void> {
    const p = this.clamp(Point.parse({ x: xInput, y: yInput }));
    await this.input.pointer(p.x, p.y, 0);
    this.cursor = p;
  }

  async click(xInput: number, yInput: number, button: "left" | "right" | "middle" = "left", expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const p = this.clamp(Point.parse({ x: xInput, y: yInput }));
    const mask = button === "right" ? 2 : button === "middle" ? 4 : 1;
    await this.input.pointer(p.x, p.y, 0);
    await this.input.pointer(p.x, p.y, mask);
    await this.input.pointer(p.x, p.y, 0);
    this.cursor = p;
  }

  async doubleClick(xInput: number, yInput: number, expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const p = this.clamp(Point.parse({ x: xInput, y: yInput }));
    for (let i = 0; i < 2; i++) {
      await this.input.pointer(p.x, p.y, 1);
      await this.input.pointer(p.x, p.y, 0);
    }
    this.cursor = p;
  }

  async drag(fromInput: { x: number; y: number }, toInput: { x: number; y: number }, expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const from = this.clamp(Point.parse(fromInput));
    const to = this.clamp(Point.parse(toInput));
    await this.input.pointer(from.x, from.y, 0);
    await this.input.pointer(from.x, from.y, 1);
    await this.input.pointer(to.x, to.y, 1);
    await this.input.pointer(to.x, to.y, 0);
    this.cursor = to;
  }

  async type(textInput: string, expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const text = z.string().max(4096).parse(textInput);
    for (const ch of text) {
      if (ch === "\n") {
        await this.input.key(KEYSYMS["Return"] ?? 0xff0d, true);
        await this.input.key(KEYSYMS["Return"] ?? 0xff0d, false);
        continue;
      }
      const { keysym, shift } = keysymForChar(ch);
      if (shift) await this.input.key(KEYSYMS["Shift_L"] ?? 0xffe1, true);
      await this.input.key(keysym, true);
      await this.input.key(keysym, false);
      if (shift) await this.input.key(KEYSYMS["Shift_L"] ?? 0xffe1, false);
      if (this.opts.keyDelayMs > 0) await sleepMs(this.opts.keyDelayMs);
    }
  }

  async key(nameInput: string, expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const name = z.string().min(1).max(64).parse(nameInput);
    const sym = KEYSYMS[name];
    if (sym === undefined) throw new EveError("BAD_KEY", `Unknown key: ${name}`);
    await this.input.key(sym, true);
    await this.input.key(sym, false);
  }

  async hotkey(namesInput: string[], expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const names = z.array(z.string().min(1).max(64)).min(1).max(4).parse(namesInput);
    // Named keys (Control_L, F1, ...) resolve via the keysym table; single
    // characters resolve like type() so Ctrl+Alt+T style shortcuts work.
    const downs: number[] = [];
    const ups: number[] = [];
    for (const n of names) {
      const sym = KEYSYMS[n];
      if (sym !== undefined) {
        downs.push(sym);
        ups.unshift(sym);
        continue;
      }
      if ([...n].length === 1) {
        const { keysym, shift } = keysymForChar(n);
        if (shift) downs.push(KEYSYMS["Shift_L"] ?? 0xffe1);
        downs.push(keysym);
        ups.unshift(keysym);
        if (shift) ups.unshift(KEYSYMS["Shift_L"] ?? 0xffe1);
        continue;
      }
      throw new EveError("BAD_KEY", `Unknown key: ${n}`);
    }
    for (const s of downs) await this.input.key(s, true);
    for (const s of ups) await this.input.key(s, false);
  }

  async scroll(dxInput: number, dyInput: number, expectedFrameId?: string): Promise<void> {
    this.checkFresh(expectedFrameId);
    const dx = z.number().int().min(-20).max(20).parse(dxInput);
    const dy = z.number().int().min(-20).max(20).parse(dyInput);
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const mask = (dx < 0 || dy < 0 ? 4 : 0) | (dx > 0 || dy > 0 ? 2 : 0);
    const use = mask === 0 ? 2 : mask;
    for (let i = 0; i < steps; i++) {
      await this.input.pointer(this.cursor.x, this.cursor.y, use);
      await this.input.pointer(this.cursor.x, this.cursor.y, 0);
    }
    void BBox;
  }

  async wait(msInput: number): Promise<void> {
    const ms = z.number().int().min(0).max(60000).parse(msInput);
    await sleepMs(ms);
  }

  async clipboardRead(): Promise<string> {
    if (!this.clipboard) throw new EveError("NO_CLIPBOARD", "No clipboard channel attached");
    return this.clipboard.read();
  }

  async clipboardWrite(textInput: string): Promise<void> {
    if (!this.clipboard) throw new EveError("NO_CLIPBOARD", "No clipboard channel attached");
    const text = z.string().max(1048576).parse(textInput);
    await this.clipboard.write(text);
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
