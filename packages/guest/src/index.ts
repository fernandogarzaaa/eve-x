import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { join, normalize, relative, resolve, sep, basename, dirname } from "node:path";
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

// ── Replay resistance ──────────────────────────────────────────────────
// A valid (ts, sig) pair is a bearer for its exact request inside the skew
// window: without single-use tracking, a captured /exec could be replayed
// for duplicate (possibly destructive) execution. The server records every
// accepted signature until it expires and rejects reuse. Bounded LRU-ish
// eviction keeps memory flat; entries outlive the skew window so late
// replays still hit the cache (and early ones hit the timestamp check).

export interface ReplayCache {
  /** Returns true when fresh (and records the signature); false on replay. */
  checkFresh(sig: string, nowMs?: number): boolean;
  size(): number;
}

export function createReplayCache(maxSkewMs = 60000, maxEntries = 4096): ReplayCache {
  const seen = new Map<string, number>();
  const ttl = Math.max(maxSkewMs * 2, 60000);
  return {
    checkFresh(sig: string, nowMs?: number): boolean {
      const now = nowMs ?? Date.now();
      if (seen.has(sig)) return false;
      if (seen.size >= maxEntries) {
        // Purge expired first; if still full, drop the oldest quarter.
        for (const [k, exp] of seen) {
          if (exp <= now) seen.delete(k);
          if (seen.size < maxEntries) break;
        }
        if (seen.size >= maxEntries) {
          const drop = Math.ceil(maxEntries / 4);
          const keys = seen.keys();
          for (let i = 0; i < drop; i += 1) {
            const k = keys.next();
            if (k.done) break;
            seen.delete(k.value);
          }
        }
      }
      seen.set(sig, now + ttl);
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}

// ── Guest agent (runs INSIDE the vm) ─────────────────────────────────────────

export const GuestAgentOptions = z.object({
  port: z.number().int().min(0).max(65535).default(18080),
  host: z.string().default("127.0.0.1"),
  secret: z.string().min(16),
  fsRoot: z.string().default("/tmp/eve-guest"),
  execAllowlist: z.array(z.string().min(1).max(64)).default(["ls", "cat", "echo", "pwd", "whoami", "scrot", "import", "xdotool"]),
  /** Trusted executable directories. Bare allowlisted names resolve ONLY
   *  here (never via ambient PATH); absolute paths must canonicalize
   *  inside one of these directories. Symlink escapes are refused. */
  execAllowDirs: z.array(z.string().min(1)).default(["/usr/bin", "/bin"]),
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

// ── Filesystem jail: canonical containment ─────────────────────────────
// Lexical normalization alone is defeated by symlinks (a link inside the
// root pointing outside passes every startsWith check, then the OS follows
// it). This jail layers three checks and fails closed on any of them:
//   1. lexical gate (rejects .. escapes without touching the fs);
//   2. component walk from the real root refusing symlinks (lstat);
//   3. no-follow open (O_NOFOLLOW) + post-open realpath containment.
//
// TOCTOU note: the walk and the open are not atomic. The O_NOFOLLOW open
// plus the post-open realpath re-check close the swap-a-symlink-in race
// for the opened file itself (a swapped-in symlink fails the open; a
// swapped-in real path outside the root fails the re-check), and the
// post-open nlink check closes the swap-a-hardlink-in race. Content races
// on already-jail-resident regular files are outside the jail threat model
// (the writer is the authenticated control plane). Mount-namespace purity
// (bind mounts, procfs/sysfs/device nodes under the root) is NOT covered
// by this jail: it guarantees PATH containment — the opened object is
// inside the boundary — while mount topology stays the operator's
// responsibility (jail roots live on ordinary tmpfs/disk, never /proc).

export function lexicalInsideRoot(fsRoot: string, p: string): string {
  // NFKC-normalize first: filesystems that normalize Unicode (macOS APFS)
  // may otherwise resolve a different name than the one we lexically
  // checked, and compatibility characters (e.g. U+FF0E FULLWIDTH FULL
  // STOP, which NFKC folds to ".") must not smuggle traversal past the
  // gate. The normalized form is used for the actual fs operation too,
  // so check and use cannot disagree.
  const full = normalize(join(fsRoot, p.normalize("NFKC")));
  const root = normalize(fsRoot + sep);
  if (full !== normalize(fsRoot) && !full.startsWith(root)) {
    throw new EveError("FS_ESCAPE", "Path escapes guest fs root");
  }
  return full;
}

export async function canonicalInsideRoot(fsRoot: string, p: string): Promise<string> {
  const lexical = lexicalInsideRoot(fsRoot, p);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(fsRoot);
  } catch {
    throw new EveError("FS_JAIL_BROKEN", "Guest fs root is unreachable");
  }
  const rel = relative(rootReal, lexical);
  if (rel.startsWith("..") || resolve(rootReal, rel) !== lexical) {
    throw new EveError("FS_ESCAPE", "Path escapes guest fs root");
  }
  // Walk existing prefixes; every one must be a non-symlink. The walk
  // stops at the first missing component (create path); the verified
  // prefix chain plus the no-follow open below carry the guarantee.
  let cur = rootReal;
  const parts = rel.split(sep).filter((x) => x.length > 0);
  for (let i = 0; i < parts.length; i += 1) {
    cur = join(cur, parts[i] as string);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") break;
      throw new EveError("FS_JAIL_BROKEN", "Guest fs jail is unreadable");
    }
    if (st.isSymbolicLink()) {
      throw new EveError("FS_ESCAPE", "Path traverses a symlink — refusing");
    }
    // Hardlinks share the target's inode: a hardlink inside the jail to a
    // file outside reads outside data while passing every symlink check.
    // The jail root is agent-managed scratch (fresh files are nlink=1), so
    // multi-link entries are treated as jail-break attempts, not data.
    if (!st.isDirectory() && st.nlink > 1) {
      throw new EveError("FS_ESCAPE", "Path has multiple hardlinks — refusing");
    }
    if (!st.isDirectory() && i < parts.length - 1) {
      throw new EveError("FS_ESCAPE", "Path traverses a non-directory — refusing");
    }
  }
  return lexical;
}

async function recheckContainment(fsRoot: string, full: string): Promise<void> {
  let rootReal: string;
  let fullReal: string;
  try {
    rootReal = await fs.realpath(fsRoot);
    fullReal = await fs.realpath(full);
  } catch (err) {
    throw new EveError("FS_ESCAPE", `Post-open containment re-check failed: ${(err as Error).message ?? err}`);
  }
  const root = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (fullReal !== rootReal && !fullReal.startsWith(root)) {
    throw new EveError("FS_ESCAPE", "Opened file is outside the guest fs root — refusing");
  }
}

function nofollowFlags(): number | undefined {
  // O_NOFOLLOW is a Linux facility; on other platforms the component walk
  // + post-open realpath re-check carry the guarantee (documented above).
  if (process.platform !== "linux") return undefined;
  return fsConstants.O_NOFOLLOW;
}

/** Open a jailed path for reading: canonical walk, no-follow open, re-check. */
export async function openJailedRead(fsRoot: string, p: string): Promise<{ data: Buffer; full: string }> {
  const full = await canonicalInsideRoot(fsRoot, p);
  const nofollow = nofollowFlags();
  let fh;
  try {
    fh = await fs.open(full, (fsConstants.O_RDONLY | (nofollow ?? 0)) as number);
  } catch (err) {
    throw new EveError("FS_ESCAPE", `Jailed open refused: ${((err as NodeJS.ErrnoException)?.code ?? err) as string}`);
  }
  try {
    await recheckContainment(fsRoot, full);
    const st = await fh.stat();
    if (!st.isFile()) throw new EveError("FS_ESCAPE", "Jailed open target is not a regular file");
    if (st.nlink > 1) throw new EveError("FS_ESCAPE", "Jailed open target has multiple hardlinks — refusing");
    const data = await fh.readFile();
    return { data, full };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Open a jailed path for writing: canonical walk, no-follow create, re-check. */
export async function writeJailedFile(fsRoot: string, p: string, data: Buffer, maxBytes: number): Promise<{ bytes: number; full: string }> {
  if (data.length > maxBytes) throw new EveError("FILE_TOO_LARGE", "file too large");
  const full = await canonicalInsideRoot(fsRoot, p);
  await fs.mkdir(dirname(full), { recursive: true });
  const nofollow = nofollowFlags();
  const flags = (fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (nofollow ?? 0)) as number;
  let fh;
  try {
    fh = await fs.open(full, flags, 0o600);
  } catch (err) {
    throw new EveError("FS_ESCAPE", `Jailed create refused: ${((err as NodeJS.ErrnoException)?.code ?? err) as string}`);
  }
  try {
    await recheckContainment(fsRoot, full);
    const st = await fh.stat();
    if (st.nlink > 1) throw new EveError("FS_ESCAPE", "Jailed target has multiple hardlinks — refusing");
    await fh.writeFile(data);
    return { bytes: data.length, full };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

// ── Executable identity: canonical authorization ───────────────────────
// Basename matching authorizes /tmp/evil/ls whenever "ls" is allowlisted.
// Authorization is by canonical identity instead: the basename must be
// allowlisted AND the resolved executable (symlinks fully resolved) must
// live inside a trusted directory. Bare names never consult ambient PATH.

export async function resolveExecutable(
  argv0: string,
  allowlist: ReadonlySet<string> | readonly string[],
  allowDirs: readonly string[],
  pathDirs?: readonly string[],
): Promise<string> {
  const raw = String(argv0 ?? "");
  if (!raw) throw new EveError("NOT_ALLOWLISTED", "empty executable");
  const bin = raw.split(/[/\\]/).pop() ?? "";
  const allowed = Array.isArray(allowlist)
    ? (allowlist as readonly string[]).includes(bin)
    : (allowlist as ReadonlySet<string>).has(bin);
  if (!allowed) throw new EveError("NOT_ALLOWLISTED", `binary not allowlisted: ${bin}`);
  const trusted = await Promise.all(allowDirs.map(async (d) => {
    try {
      return await fs.realpath(d);
    } catch {
      return null;
    }
  }));
  const trustedReal = trusted.filter((d): d is string => d !== null);
  const isTrusted = (resolved: string): boolean => trustedReal.some(
    (t) => resolved === t || resolved.startsWith(t.endsWith(sep) ? t : t + sep),
  );
  const candidates: string[] = [];
  if (raw.includes("/") || raw.includes("\\")) {
    // Explicit path: ONLY this path is authorized (never substituted with
    // a same-named trusted binary — silent substitution would hide the
    // caller's intent and the audit trail).
    candidates.push(raw);
  } else {
    for (const d of allowDirs) candidates.push(join(d, bin));
    if (pathDirs !== undefined) {
      for (const d of pathDirs) candidates.push(join(d, bin));
    }
  }
  for (const c of candidates) {
    let resolved: string;
    try {
      resolved = await fs.realpath(c);
    } catch {
      continue;
    }
    if (!isTrusted(resolved)) continue;
    try {
      await fs.access(resolved, fsConstants.X_OK);
    } catch {
      continue;
    }
    return resolved;
  }
  throw new EveError("NOT_ALLOWLISTED", `binary not resolvable inside trusted dirs: ${bin}`);
}

export async function createGuestAgent(optsInput: unknown): Promise<GuestAgent> {
  const opts = GuestAgentOptions.parse(optsInput);
  await fs.mkdir(opts.fsRoot, { recursive: true });
  let clipboard = "";
  const beats: Array<{ vmId: string; at: string }> = [];
  const allow = new Set(opts.execAllowlist);
  // Single-use signatures: a captured request cannot be replayed inside
  // the skew window (non-idempotent /exec especially).
  const replay = createReplayCache();

  const sendEveError = (res: ServerResponse, err: unknown): void => {
    const code = err instanceof EveError ? err.code : "";
    const message = err instanceof Error ? err.message : String(err);
    if (code === "FS_ESCAPE" || code === "NOT_ALLOWLISTED") {
      sendJson(res, 403, { ok: false, code, error: message });
      return;
    }
    if (code === "FILE_TOO_LARGE" || code === "BODY_TOO_LARGE") {
      sendJson(res, 413, { ok: false, code, error: message });
      return;
    }
    sendJson(res, 500, { ok: false, code: code || "internal", error: message });
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
        if (!replay.checkFresh(sig)) {
          sendJson(res, 401, { ok: false, error: "replayed request (signature already used)" });
          return;
        }
      }
      if (method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, at: nowIso() });
        return;
      }
      if (method === "GET" && path === "/screenshot") {
        // Prefer a real screen capture tool inside the guest; otherwise a
        // degraded 1x1 sentinel explicitly flagged as such. Capture tools
        // resolve through the same executable identity as /exec.
        const candidates: Array<readonly string[]> = [];
        for (const tool of [["scrot", "-o"], ["import", "-window", "root"]] as const) {
          try {
            const resolved = await resolveExecutable(tool[0], allow, opts.execAllowDirs);
            candidates.push([resolved, ...tool.slice(1), join(opts.fsRoot, "shot.png")]);
          } catch { /* tool unavailable: fall through to the sentinel */ }
        }
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
        let xdotool: string;
        try {
          xdotool = await resolveExecutable("xdotool", allow, opts.execAllowDirs);
        } catch {
          sendJson(res, 503, { ok: false, error: "xdotool missing inside guest" });
          return;
        }
        const r = await runTool(xdotool, xdotoolArgs(ev), 8000).catch((err: unknown) => {
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
        let resolved: string;
        try {
          resolved = await resolveExecutable(body.argv[0] ?? "", allow, opts.execAllowDirs);
        } catch (err) {
          sendEveError(res, err);
          return;
        }
        const timeout = body.timeoutMs ?? opts.execTimeoutMs;
        const r = await runTool(resolved, body.argv.slice(1), timeout);
        sendJson(res, 200, { ok: r.code === 0, code: r.code, stdout: r.out, stderr: r.err });
        return;
      }
      if (method === "GET" && path === "/fs") {
        const p = url.searchParams.get("path") ?? "";
        try {
          const parsed = z.string().min(1).max(1024).parse(p);
          const { data } = await openJailedRead(opts.fsRoot, parsed);
          sendJson(res, 200, { ok: true, contentBase64: data.toString("base64"), bytes: data.length });
        } catch (err) {
          sendEveError(res, err);
        }
        return;
      }
      if (method === "POST" && path === "/fs") {
        const body = FsWriteRequest.parse(JSON.parse(rawBody || "{}") as unknown);
        try {
          const data = Buffer.from(body.contentBase64, "base64");
          const { bytes } = await writeJailedFile(opts.fsRoot, body.path, data, opts.maxBodyBytes);
          sendJson(res, 200, { ok: true, bytes });
        } catch (err) {
          sendEveError(res, err);
        }
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
  const boundPort = (server.address() as { port?: number } | null)?.port ?? opts.port;
  return {
    url: `http://${opts.host}:${boundPort}`,
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
    // Fresh signature per attempt: the server treats signatures as
    // single-use (replay cache), so a retry must be a NEW request, never a
    // byte replay of the previous envelope.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      const ts = String(Date.now());
      const sig = hmacSign(this.opts.secret, method, path, bodyText, ts);
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
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      // Fresh signature per attempt (single-use server cache — see above).
      const ts = String(Date.now());
      const sig = hmacSign(this.opts.secret, "GET", "/screenshot", "", ts);
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
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new EveError("GUEST_ERROR", `fs read -> ${res.status}: ${t.slice(0, 300)}`);
    }
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
