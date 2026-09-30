import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, normalize, sep } from "node:path";
import { z } from "zod";
import { EveError, nowIso } from "../../core/src/index.js";

// ── HMAC auth shared by server + client ──────────────────────────────────────

export function hmacSign(secret: string, method: string, path: string, body: string, ts: string): string {
  return createHmac("sha256", secret).update(`${ts}\n${method}\n${path}\n${body}`, "utf8").digest("hex");
}

export function verifyHmac(
  secret: string,
  method: string,
  path: string,
  body: string,
  ts: string,
  sig: string,
  maxSkewMs = 60000,
): boolean {
  const when = Number(ts);
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > maxSkewMs) return false;
  const expected = hmacSign(secret, method, path, body, ts);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Guest agent (runs INSIDE the vm) ─────────────────────────────────────────

export const GuestAgentOptions = z.object({
  port: z.number().int().min(1).max(65535).default(18080),
  host: z.string().default("127.0.0.1"),
  secret: z.string().min(16),
  fsRoot: z.string().default("/tmp/eve-guest"),
  execAllowlist: z.array(z.string().min(1).max(64)).default(["ls", "cat", "echo", "pwd", "whoami", "scrot", "import", "xdotool"]),
  execTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  maxBodyBytes: z.number().int().min(1024).max(33554432).default(8388608),
  maxClipboardBytes: z.number().int().min(256).max(1048576).default(65536),
});
export type GuestAgentOptions = z.infer<typeof GuestAgentOptions>;

export const InputEvent = z.object({
  kind: z.enum(["mouse-move", "mouse-down", "mouse-up", "key-down", "key-up", "key-press"]),
  x: z.number().int().min(0).max(7680).optional(),
  y: z.number().int().min(0).max(4320).optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  key: z.string().max(64).optional(),
});
export type InputEvent = z.infer<typeof InputEvent>;

export const ExecRequest = z.object({
  argv: z.array(z.string().min(1).max(512)).min(1).max(16),
  timeoutMs: z.number().int().min(500).max(120000).optional(),
});
export type ExecRequest = z.infer<typeof ExecRequest>;

export const FsWriteRequest = z.object({
  path: z.string().min(1).max(1024),
  contentBase64: z.string().max(16777216),
});
export type FsWriteRequest = z.infer<typeof FsWriteRequest>;

export const ClipboardWrite = z.object({ text: z.string().max(1048576) });
export const HeartbeatMsg = z.object({ vmId: z.string().min(1), at: z.string().optional() });

const FALLBACK_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new EveError("BODY_TOO_LARGE", `Body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err: Error) => reject(err));
  });
}

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function runTool(cmd: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 2000);
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { err += d.toString("utf8"); });
    child.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(0, 65536), err: err.slice(0, 65536) });
    });
  });
}

export interface GuestAgent {
  url: string;
  close(): Promise<void>;
  beats(): Array<{ vmId: string; at: string }>;
}

export async function createGuestAgent(optsInput: unknown): Promise<GuestAgent> {
  const opts = GuestAgentOptions.parse(optsInput);
  await fs.mkdir(opts.fsRoot, { recursive: true });
  let clipboard = "";
  const beats: Array<{ vmId: string; at: string }> = [];
  const allow = new Set(opts.execAllowlist);

  const insideRoot = (p: string): string => {
    const full = normalize(join(opts.fsRoot, p));
    const root = normalize(opts.fsRoot + sep);
    if (full !== normalize(opts.fsRoot) && !full.startsWith(root)) {
      throw new EveError("FS_ESCAPE", "Path escapes guest fs root");
    }
    return full;
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle().catch((err: unknown) => {
      if (!res.writableEnded) sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    async function handle(): Promise<void> {
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://guest");
      const path = url.pathname;
      const rawBody = (await readBody(req, opts.maxBodyBytes)).toString("utf8");
      if (path !== "/health") {
        const ts = req.headers["x-eve-ts"];
        const sig = req.headers["x-eve-sig"];
        if (typeof ts !== "string" || typeof sig !== "string" ||
          !verifyHmac(opts.secret, method, path, rawBody, ts, sig)) {
          sendJson(res, 401, { ok: false, error: "bad signature or stale timestamp" });
          return;
        }
      }
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, at: nowIso() });
        return;
      }
      if (method === "GET" && path === "/screenshot") {
        // Prefer a real screen capture tool inside the guest; otherwise a
        // degraded 1x1 sentinel explicitly flagged as such.
        const candidates: Array<readonly string[]> = [
          ["scrot", "-o", join(opts.fsRoot, "shot.png")],
          ["import", "-window", "root", join(opts.fsRoot, "shot.png")],
        ];
        for (const [cmd, ...args] of candidates) {
          try {
            const r = await runTool(cmd ?? "", args, 10000);
            if (r.code === 0) {
              const png = await fs.readFile(join(opts.fsRoot, "shot.png"));
              res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
              res.end(png);
              return;
            }
          } catch { /* try next tool */ }
        }
        const png = Buffer.from(FALLBACK_PNG_B64, "base64");
        res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "x-eve-degraded": "true" });
        res.end(png);
        return;
      }
      if (method === "POST" && path === "/input") {
        const ev = InputEvent.parse(JSON.parse(rawBody || "{}") as unknown);
        const r = await runTool("xdotool", xdotoolArgs(ev), 8000).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("ENOENT")) {
            sendJson(res, 503, { ok: false, error: "xdotool missing inside guest" });
            return null;
          }
          throw err;
        });
        if (r === null) return;
        if (r.code !== 0) { sendJson(res, 502, { ok: false, error: r.err || "xdotool failed" }); return; }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/exec") {
        const body = ExecRequest.parse(JSON.parse(rawBody || "{}") as unknown);
        const bin = (body.argv[0] ?? "").split("/").pop() ?? "";
        if (!allow.has(bin)) {
          sendJson(res, 403, { ok: false, error: `binary not allowlisted: ${bin}` });
          return;
        }
        const timeout = body.timeoutMs ?? opts.execTimeoutMs;
        const r = await runTool(body.argv[0] ?? "", body.argv.slice(1), timeout);
        sendJson(res, 200, { ok: r.code === 0, code: r.code, stdout: r.out, stderr: r.err });
        return;
      }
      if (method === "GET" && path === "/fs") {
        const p = url.searchParams.get("path") ?? "";
        const full = insideRoot(z.string().min(1).max(1024).parse(p));
        const data = await fs.readFile(full);
        sendJson(res, 200, { ok: true, contentBase64: data.toString("base64"), bytes: data.length });
        return;
      }
      if (method === "POST" && path === "/fs") {
        const body = FsWriteRequest.parse(JSON.parse(rawBody || "{}") as unknown);
        const full = insideRoot(body.path);
        const data = Buffer.from(body.contentBase64, "base64");
        if (data.length > opts.maxBodyBytes) {
          sendJson(res, 413, { ok: false, error: "file too large" });
          return;
        }
        await fs.mkdir(join(full, ".."), { recursive: true });
        await fs.writeFile(full, data);
        sendJson(res, 200, { ok: true, bytes: data.length });
        return;
      }
      if (method === "GET" && path === "/clipboard") {
        sendJson(res, 200, { ok: true, text: clipboard });
        return;
      }
      if (method === "POST" && path === "/clipboard") {
        const body = ClipboardWrite.parse(JSON.parse(rawBody || "{}") as unknown);
        if (Buffer.byteLength(body.text, "utf8") > opts.maxClipboardBytes) {
          sendJson(res, 413, { ok: false, error: "clipboard payload too large" });
          return;
        }
        clipboard = body.text;
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "POST" && path === "/heartbeat") {
        const body = HeartbeatMsg.parse(JSON.parse(rawBody || "{}") as unknown);
        beats.push({ vmId: body.vmId, at: nowIso() });
        if (beats.length > 512) beats.splice(0, beats.length - 512);
        sendJson(res, 200, { ok: true, at: nowIso() });
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${method} ${path}` });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: Error) => reject(err));
    server.listen(opts.port, opts.host, () => resolve());
  });
  return {
    url: `http://${opts.host}:${opts.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    }),
    beats: () => [...beats],
  };
}

function xdotoolArgs(ev: InputEvent): string[] {
  switch (ev.kind) {
    case "mouse-move": return ["mousemove", String(ev.x ?? 0), String(ev.y ?? 0)];
    case "mouse-down": return ["mousedown", xdotoolButton(ev.button)];
    case "mouse-up": return ["mouseup", xdotoolButton(ev.button)];
    case "key-down": return ["keydown", ev.key ?? ""];
    case "key-up": return ["keyup", ev.key ?? ""];
    case "key-press": return ["key", ev.key ?? ""];
  }
}

function xdotoolButton(b: string): string {
  return b === "right" ? "3" : b === "middle" ? "2" : "1";
}

// ── HostGuestChannel (host-side client) ──────────────────────────────────────

export const HostGuestChannelOptions = z.object({
  baseUrl: z.string().url(),
  secret: z.string().min(16),
  timeoutMs: z.number().int().min(500).max(60000).default(10000),
  retries: z.number().int().min(0).max(5).default(2),
  heartbeatIntervalMs: z.number().int().min(1000).max(120000).default(10000),
  maxMissedBeats: z.number().int().min(1).max(20).default(3),
});
export type HostGuestChannelOptions = z.infer<typeof HostGuestChannelOptions>;

/**
 * HMAC-signed fetch client for the guest agent. Transport note: plain HTTP
 * here; over vsock, serve the same routes on a vsock listener inside the
 * guest (AF_VSOCK CID:port) and point baseUrl at a vsock-to-tcp forwarder on
 * the host — the signing envelope is transport-agnostic.
 */
export class HostGuestChannel {
  private readonly opts: HostGuestChannelOptions;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private missed = 0;
  private lastBeatAt: string | null = null;

  constructor(optsInput: unknown) {
    this.opts = HostGuestChannelOptions.parse(optsInput);
  }

  private async signedFetch(method: string, path: string, bodyText = ""): Promise<Response> {
    const ts = String(Date.now());
    const sig = hmacSign(this.opts.secret, method, path, bodyText, ts);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        const res = await fetch(`${this.opts.baseUrl}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-eve-ts": ts,
            "x-eve-sig": sig,
          },
          body: method === "GET" ? undefined : bodyText,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (res.status >= 500 && attempt < this.opts.retries) {
          await sleepMs(150 * (attempt + 1));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < this.opts.retries) await sleepMs(150 * (attempt + 1));
      }
    }
    throw new EveError("GUEST_UNREACHABLE", `Guest unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  private async call<T>(method: string, path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const text = method === "GET" ? "" : JSON.stringify(body ?? {});
    const res = await this.signedFetch(method, path, text);
    if (res.status === 401) throw new EveError("GUEST_AUTH", "Guest rejected HMAC signature");
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new EveError("GUEST_ERROR", `Guest ${method} ${path} -> ${res.status}: ${t.slice(0, 512)}`);
    }
    const parsed: unknown = await res.json().catch(() => ({}));
    return schema.parse(parsed);
  }

  async health(): Promise<{ ok: boolean; at: string }> {
    const res = await fetch(`${this.opts.baseUrl}/health`, { signal: AbortSignal.timeout(this.opts.timeoutMs) });
    if (!res.ok) throw new EveError("GUEST_ERROR", `health -> ${res.status}`);
    const parsed: unknown = await res.json().catch(() => ({}));
    return z.object({ ok: z.boolean(), at: z.string() }).parse(parsed);
  }

  async screenshot(): Promise<Buffer> {
    const ts = String(Date.now());
    const sig = hmacSign(this.opts.secret, "GET", "/screenshot", "", ts);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      try {
        const res = await fetch(`${this.opts.baseUrl}/screenshot`, {
          headers: { "x-eve-ts": ts, "x-eve-sig": sig },
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (res.status === 401) throw new EveError("GUEST_AUTH", "Guest rejected HMAC signature");
        if (!res.ok) throw new EveError("GUEST_ERROR", `screenshot -> ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      } catch (err) {
        lastErr = err;
        if (attempt < this.opts.retries) await sleepMs(150 * (attempt + 1));
      }
    }
    throw new EveError("GUEST_UNREACHABLE", `screenshot failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }

  async input(ev: InputEvent): Promise<void> {
    const parsed = InputEvent.parse(ev);
    await this.call("POST", "/input", parsed, z.object({ ok: z.boolean() }));
  }

  async exec(argv: string[], timeoutMs?: number): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
    // Client-side safe kill: abort the HTTP wait; the agent enforces its own
    // exec timeout and escalates SIGTERM -> SIGKILL on the child.
    const body = ExecRequest.parse({ argv, timeoutMs });
    return this.call("POST", "/exec", body, z.object({
      ok: z.boolean(), code: z.number().int(), stdout: z.string(), stderr: z.string(),
    }));
  }

  async readFile(path: string): Promise<Buffer> {
    const p = z.string().min(1).max(1024).parse(path);
    const ts = String(Date.now());
    const sig = hmacSign(this.opts.secret, "GET", "/fs", "", ts);
    const res = await fetch(`${this.opts.baseUrl}/fs?path=${encodeURIComponent(p)}`, {
      headers: { "x-eve-ts": ts, "x-eve-sig": sig },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new EveError("GUEST_ERROR", `fs read -> ${res.status}`);
    const parsed: unknown = await res.json().catch(() => ({}));
    const out = z.object({ ok: z.boolean(), contentBase64: z.string(), bytes: z.number() }).parse(parsed);
    return Buffer.from(out.contentBase64, "base64");
  }

  async writeFile(path: string, data: Buffer): Promise<number> {
    const body = FsWriteRequest.parse({ path, contentBase64: data.toString("base64") });
    const out = await this.call("POST", "/fs", body, z.object({ ok: z.boolean(), bytes: z.number() }));
    return out.bytes;
  }

  async clipboardRead(): Promise<string> {
    const out = await this.call("GET", "/clipboard", {}, z.object({ ok: z.boolean(), text: z.string() }));
    return out.text;
  }

  async clipboardWrite(text: string): Promise<void> {
    await this.call("POST", "/clipboard", ClipboardWrite.parse({ text }), z.object({ ok: z.boolean() }));
  }

  async heartbeat(vmId: string): Promise<void> {
    const id = z.string().min(1).parse(vmId);
    await this.call("POST", "/heartbeat", { vmId: id }, z.object({ ok: z.boolean(), at: z.string() }));
    this.lastBeatAt = nowIso();
    this.missed = 0;
  }

  /** Watchdog: heartbeats on an interval; calls onMissed after maxMissedBeats consecutive failures. */
  startWatchdog(vmId: string, onMissed: (info: { missed: number; lastBeatAt: string | null }) => void): void {
    const id = z.string().min(1).parse(vmId);
    const cb = z.custom<(info: { missed: number; lastBeatAt: string | null }) => void>(
      (v) => typeof v === "function",
    ).parse(onMissed);
    this.stopWatchdog();
    this.missed = 0;
    this.watchdog = setInterval(() => {
      void this.heartbeat(id).then(
        () => undefined,
        () => {
          this.missed++;
          if (this.missed >= this.opts.maxMissedBeats) {
            const info = { missed: this.missed, lastBeatAt: this.lastBeatAt };
            this.stopWatchdog();
            cb(info);
          }
        },
      );
    }, this.opts.heartbeatIntervalMs);
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  watchdogState(): { running: boolean; missed: number; lastBeatAt: string | null } {
    return { running: this.watchdog !== null, missed: this.missed, lastBeatAt: this.lastBeatAt };
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
