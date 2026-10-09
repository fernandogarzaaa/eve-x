import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { appendFileSync as fsAppendFileSync, readFileSync as fsReadFileSync, existsSync as fsExistsSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { VmSpec, VmState } from "../../protocol/src/index.js";
import { uid, nowIso, EveError, StateMachine, VM_TRANSITIONS } from "../../core/src/index.js";

// ── Schemas (parsed at every boundary) ───────────────────────────────────────

export const VmAuditEntry = z.object({
  at: z.string(),
  op: z.string(),
  detail: z.string(),
});
export type VmAuditEntry = z.infer<typeof VmAuditEntry>;

export const VmRecordSchema = z.object({
  vmId: z.string(),
  owner: z.string(),
  backend: z.string(),
  spec: VmSpec,
  state: VmState,
  createdAt: z.string(),
  workdir: z.string(),
  qmpSocket: z.string().optional(),
  pid: z.number().optional(),
  containerName: z.string().optional(),
  detail: z.string().default(""),
});
export type VmRecord = z.infer<typeof VmRecordSchema>;

export const VmStatusSchema = z.object({
  vmId: z.string(),
  backend: z.string(),
  state: VmState,
  uptimeMs: z.number(),
  pid: z.number().optional(),
  detail: z.string(),
});
export type VmStatus = z.infer<typeof VmStatusSchema>;

export type VmStateT = z.infer<typeof VmState>;
export type VmSpecT = z.infer<typeof VmSpec>;

const TRANSITIONS = VM_TRANSITIONS as unknown as Record<VmStateT, VmStateT[]>;

// ── Driver interface ─────────────────────────────────────────────────────────

export interface VmDriver {
  readonly backend: string;
  create(specInput: unknown, owner: string, opts?: CreateOpts): Promise<VmRecord>;
  boot(vmId: string): Promise<void>;
  shutdown(vmId: string): Promise<void>;
  pause(vmId: string): Promise<void>;
  resume(vmId: string): Promise<void>;
  reboot(vmId: string): Promise<void>;
  snapshot(vmId: string, name: string): Promise<string>;
  restore(vmId: string, name: string): Promise<string>;
  clone(vmId: string, newOwner: string): Promise<VmRecord>;
  fork(vmId: string, newOwner: string): Promise<VmRecord>;
  destroy(vmId: string): Promise<void>;
  screendump(vmId: string): Promise<Buffer>;
  status(vmId: string): Promise<VmStatus>;
}

export const SnapshotName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);

/** Optional per-create driver options. `baseImage` names a read-only base
 *  qcow2 inside the driver's images directory; the VM gets a private
 *  copy-on-write overlay and the base is never written. `seedUserData`
 *  (cloud-config) and `sshKey` build a per-VM NoCloud seed ISO containing
 *  the guest-agent secret; the seed is attached read-only at boot. */
export interface CreateOpts {
  baseImage?: string;
  seedUserData?: string;
  sshKey?: string;
  hostname?: string;
}

// V13: single snapshot-label validator shared by every driver. Rejects empty
// and overlong labels (regex requires 1–64 chars); drivers must call this
// instead of inlining their own checks.
export function validateSnapshotLabel(name: string): string {
  return SnapshotName.parse(name);
}

// V7: docker image names are interpolated into `docker run` argv. Constrain
// the alphabet so a hostile spec cannot smuggle flags or shell metacharacters.
const DOCKER_IMAGE_RE = /^[a-z0-9._/:~-]{1,128}$/i;
export function validateDockerImage(image: string): string {
  if (!DOCKER_IMAGE_RE.test(image)) {
    throw new EveError("BAD_IMAGE", `Illegal docker image name: ${image}`);
  }
  return image;
}

/** Best-effort durable audit line (sync; tiny writes only). */
function appendAuditLine(workdir: string, entry: { at: string; op: string; detail: string }): void {
  fsAppendFileSync(join(workdir, "audit.jsonl"), JSON.stringify(entry) + "\n");
}

/** Read back persisted audit lines (reattach path). */
export function readAuditFile(workdir: string): VmAuditEntry[] {
  try {
    if (!fsExistsSync(join(workdir, "audit.jsonl"))) return [];
    const out: VmAuditEntry[] = [];
    for (const line of fsReadFileSync(join(workdir, "audit.jsonl"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t) as { at?: unknown; op?: unknown; detail?: unknown };
        if (typeof o.at === "string" && typeof o.op === "string") {
          out.push({ at: o.at, op: o.op, detail: String(o.detail ?? "") });
        }
      } catch { /* skip corrupt lines, keep the rest */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── Base-image overlays + guest-secret provisioning ─────────────────────────
// Base images are read-only golden artifacts. Every VM boots a private
// copy-on-write overlay; the base file itself is never opened for writing by
// EVE-X. `backingDigest` fingerprints size + head/tail bytes (fast even for
// multi-GB images) so boot can detect accidental or hostile base mutation.

export interface BasePin {
  base: string;
  digest: string;
  size: number;
}

export async function backingDigest(path: string): Promise<{ digest: string; size: number }> {
  const fh = await fs.open(path, "r");
  try {
    const st = await fh.stat();
    const h = createHash("sha256");
    h.update(`size:${st.size}\n`);
    const span = Math.min(65536, st.size);
    if (span > 0) {
      const head = Buffer.alloc(span);
      await fh.read(head, 0, span, 0);
      h.update(head);
      if (st.size > span) {
        const tail = Buffer.alloc(span);
        await fh.read(tail, 0, span, st.size - span);
        h.update(tail);
      }
    }
    return { digest: h.digest("hex"), size: st.size };
  } finally {
    await fh.close();
  }
}

/** Resolve a base-image name strictly inside `imagesDir` (no traversal). */
export function resolveBaseImage(imagesDir: string, name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name)) {
    throw new EveError("BAD_IMAGE", `Illegal base image name: ${name}`);
  }
  const p = resolve(imagesDir, name);
  if (p !== resolve(imagesDir, basename(p))) {
    throw new EveError("BAD_IMAGE", `Base image escapes images dir: ${name}`);
  }
  return p;
}

/** Per-VM guest-agent HMAC secret, 0600 inside the VM workdir. The host
 *  channel reads it back; cloud-init/seed injection carries it into the guest
 *  (see infra/vm-images/build.sh --secret-file). Never logged. */
export async function provisionGuestSecret(workdir: string): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  const p = join(workdir, "guest-secret");
  await fs.writeFile(p, secret + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(p, 0o600);
  } catch { /* best effort on non-posix fs */ }
  return secret;
}

export async function readGuestSecret(workdir: string): Promise<string | null> {
  try {
    const s = (await fs.readFile(join(workdir, "guest-secret"), "utf8")).trim();
    return s.length >= 16 ? s : null;
  } catch {
    return null;
  }
}

/** Default NoCloud user-data: locked guest account, qemu-guest-agent,
 *  openssh, and the per-VM EVE agent secret written for the in-guest
 *  runtime. The secret travels only inside the seed ISO, never in logs. */
export function defaultSeedUserData(input: { hostname: string; sshKey?: string; guestSecret: string }): string {
  const keyBlock = input.sshKey
    ? `    ssh_authorized_keys:\n      - ${input.sshKey}\n`
    : "";
  return `#cloud-config
hostname: ${input.hostname}
manage_etc_hosts: true
users:
  - name: eveagent
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    lock_passwd: true
${keyBlock}packages:
  - qemu-guest-agent
  - openssh-server
write_files:
  - path: /opt/eve-agent/secret
    owner: root:root
    permissions: '0600'
    content: |
      ${input.guestSecret}
runcmd:
  - [ systemctl, enable, --now, qemu-guest-agent ]
  - [ systemctl, enable, --now, ssh ]
  - [ mkdir, -p, /opt/eve-agent ]
  - [ chmod, "0755", /opt/eve-agent ]
`;
}

// ── Small process helper (real spawn, no shell) ──────────────────────────────

export interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCmd(cmd: string, args: readonly string[], timeoutMs = 30000): Promise<CmdResult> {
  return new Promise<CmdResult>((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    child.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}

export async function hasBinary(cmd: string, probeArgs: readonly string[] = ["--version"]): Promise<boolean> {
  try {
    const r = await runCmd(cmd, probeArgs, 8000);
    return r.code === 0;
  } catch {
    return false;
  }
}

// ── QMP connection (real QEMU Machine Protocol over a unix socket) ───────────

type QmpResponse = Record<string, unknown>;

// V11: hard cap on buffered inbound QMP bytes; a chatty or hostile peer must
// not be able to grow memory without bound.
const QMP_MAX_BUF = 4 * 1024 * 1024;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class QmpConnection {
  private sock: Socket | null = null;
  private buf = "";
  private pending = new Map<number, { resolve: (v: QmpResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  /**
   * Connect to a QEMU QMP socket: greeting + qmp_capabilities handshake.
   * Rejects on timeout, bad greeting, or failed handshake.
   */
  connect(sockPath: string, timeoutMs = 15000): Promise<void> {
    return this.handshake(sockPath, timeoutMs);
  }

  /**
   * Connect to a qemu-guest-agent virtio-serial socket. Unlike QMP, QGA
   * sends no greeting: the client must speak first. Liveness is proven by
   * an immediate guest-sync round-trip. Used because QMP guest-exec
   * passthrough is absent on some QEMU builds (e.g. Debian QEMU 10
   * registers no guest-* QMP commands) — the direct QGA channel is the
   * portable path.
   */
  async connectQga(sockPath: string, timeoutMs = 15000): Promise<void> {
    await this.connectRaw(sockPath, timeoutMs);
    const syncId = Math.floor(Math.random() * 1_000_000_000);
    let res: QmpResponse;
    try {
      res = await this.commandRaw("guest-sync", { id: syncId });
    } catch (err) {
      this.close();
      throw new EveError("QGA_ABSENT", `Guest agent sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const back = (res["return"] as number | undefined) ?? (res["result"] as number | undefined);
    if (back !== syncId) {
      this.close();
      throw new EveError("QGA_ABSENT", "Guest agent sync mismatch (no live agent on channel)");
    }
  }

  /** Attach to a socket with no greeting and no handshake (QGA-style peers
   *  that stay silent until spoken to). Resolves once connected. */
  private connectRaw(sockPath: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buf = "";
      const sock: Socket = createConnection({ path: sockPath });
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        try { sock.destroy(); } catch { /* already gone */ }
        finish(() => reject(new EveError("QMP_TIMEOUT", `QGA connect timed out: ${sockPath}`)));
      }, timeoutMs);
      let done = false;
      const finish = (fn: () => void): void => {
        if (!done) { done = true; clearTimeout(timer); fn(); }
      };
      this.sock = sock;
      sock.on("data", (chunk: Buffer) => {
        this.buf += chunk.toString("utf8");
        if (this.buf.length > QMP_MAX_BUF) {
          const flood = new EveError("QMP_FLOOD", "QGA buffer exceeded 4MB; closing connection");
          this.buf = "";
          this.failAll(flood);
          try { sock.destroy(); } catch { /* already gone */ }
          return;
        }
        this.pump();
      });
      sock.on("connect", () => finish(() => resolve()));
      sock.on("error", (err: Error) => {
        this.failAll(err);
        finish(() => reject(new EveError("QMP_CONNECT", `QGA socket error: ${err.message}`)));
      });
      sock.on("close", () => {
        this.failAll(new EveError("QMP_CLOSED", "QGA socket closed"));
      });
    });
  }

  private handshake(sockPath: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.buf = "";
      const sock: Socket = createConnection({ path: sockPath });
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        try { sock.destroy(); } catch { /* already gone */ }
        finish(() => reject(new EveError("QMP_TIMEOUT", `QMP connect timed out: ${sockPath}`)));
      }, timeoutMs);
      let greeted = false;
      let done = false;
      const finish = (fn: () => void): void => {
        if (!done) { done = true; clearTimeout(timer); fn(); }
      };
      // V1: exactly ONE data listener for the life of the socket. Before the
      // greeting it scans for the banner; after the greeting the same listener
      // pumps replies. A second listener would buffer every post-greeting
      // chunk twice and corrupt JSON framing, so it must never be added.
      sock.on("data", (chunk: Buffer) => {
        this.buf += chunk.toString("utf8");
        if (this.buf.length > QMP_MAX_BUF) {
          const flood = new EveError("QMP_FLOOD", "QMP buffer exceeded 4MB; closing connection");
          this.buf = "";
          this.failAll(flood);
          try { sock.destroy(); } catch { /* already gone */ }
          finish(() => reject(flood));
          return;
        }
        if (!greeted) {
          const nl = this.buf.indexOf("\n");
          if (nl < 0) return;
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.includes("\"QMP\"")) {
            this.buf = "";
            try { sock.destroy(); } catch { /* already gone */ }
            finish(() => reject(new EveError("QMP_GREETING", "Unexpected QMP greeting")));
            return;
          }
          greeted = true;
          this.sock = sock;
          // negotiate capabilities, then resolve
          this.commandRaw("qmp_capabilities").then(
            () => finish(() => resolve()),
            (err: Error) => {
              try { sock.destroy(); } catch { /* already gone */ }
              finish(() => reject(err));
            },
          );
        }
        this.pump();
      });
      sock.on("error", (err: Error) => {
        if (!greeted) {
          finish(() => reject(new EveError("QMP_CONNECT", `QMP socket error: ${err.message}`)));
        } else {
          this.failAll(err);
        }
      });
      sock.on("close", () => {
        this.failAll(new EveError("QMP_CLOSED", "QMP socket closed"));
      });
    });
  }

  private pump(): void {
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) return;
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: unknown;
      try { msg = JSON.parse(line) as unknown; } catch { continue; }
      if (!isRecord(msg)) continue;
      const id: unknown = msg["id"];
      if (typeof id !== "number") continue; // QMP event, not a reply
      const waiter = this.pending.get(id);
      if (!waiter) continue;
      this.pending.delete(id);
      if ("error" in msg) {
        waiter.reject(new EveError("QMP_ERROR", `QMP error: ${JSON.stringify(msg["error"])}`));
      } else {
        waiter.resolve(msg);
      }
    }
  }

  private failAll(err: Error): void {
    for (const w of this.pending.values()) w.reject(err);
    this.pending.clear();
  }

  // V12: callers that drive slow monitor operations (savevm/loadvm) pass a
  // larger timeout instead of sharing the 10s interactive default.
  private commandRaw(execute: string, args?: Record<string, unknown>, timeoutMs = 10000): Promise<QmpResponse> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.reject(new EveError("QMP_CLOSED", "QMP socket is closed"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = args ? { execute, arguments: args, id } : { execute, id };
    return new Promise<QmpResponse>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.pending.delete(id);
        reject(new EveError("QMP_TIMEOUT", `QMP command timed out: ${execute}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      sock.write(JSON.stringify(payload) + "\n", "utf8", (err?: Error | null) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new EveError("QMP_WRITE", `QMP write failed: ${err.message}`));
        }
      });
    });
  }

  command(execute: string, args?: Record<string, unknown>, timeoutMs = 10000): Promise<QmpResponse> {
    return this.commandRaw(execute, args, timeoutMs);
  }

  bufferedBytesForTest(): number {
    return this.buf.length;
  }

  close(): void {
    try { this.sock?.destroy(); } catch { /* already closed */ }
    this.sock = null;
    this.failAll(new EveError("QMP_CLOSED", "QMP connection closed"));
  }
}

// ── Shared cell (record + enforced state machine + audit + process) ──────────

interface CellInit {
  vmId: string;
  owner: string;
  backend: string;
  spec: VmSpecT;
  workdir: string;
  /** Initial audited state (default CREATING). Reattach passes RUNNING for a
   *  QEMU that never stopped — recording observed state, not a transition. */
  initialState?: VmStateT;
}

export class VmCell {
  readonly record: VmRecord;
  readonly sm: StateMachine<VmStateT>;
  proc: ChildProcess | null = null;
  qmp: QmpConnection | null = null;
  startedAtMs: number | null = null;
  readonly audit: VmAuditEntry[] = [];

  constructor(init: CellInit) {
    const initial = init.initialState ?? "CREATING";
    this.sm = new StateMachine<VmStateT>(initial, TRANSITIONS);
    this.record = VmRecordSchema.parse({
      vmId: init.vmId,
      owner: init.owner,
      backend: init.backend,
      spec: init.spec,
      state: this.sm.state,
      createdAt: nowIso(),
      workdir: init.workdir,
      detail: "",
    });
    if (init.initialState !== undefined) {
      this.note("reattach-init", `cell initialized at observed state ${initial}`);
    }
  }

  go(to: VmStateT, reason: string): void {
    this.sm.transition(to, reason);
    this.record.state = this.sm.state;
    this.note("transition", `${reason} -> ${to}`);
  }

  note(op: string, detail: string): void {
    const entry = { at: nowIso(), op, detail };
    this.audit.push(entry);
    // Durable mirror: the audit trail must survive control-plane restarts
    // (post-restart forensics depends on it). Best-effort sync append; the
    // in-memory list stays authoritative within the process.
    try {
      const dir = this.record.workdir;
      if (dir) appendAuditLine(dir, entry);
    } catch { /* workdir may not exist yet (early create); memory keeps it */ }
  }

  /** Load persisted audit lines (reattach path). File history is prepended
   *  so the merged trail stays chronological; constructor notes already in
   *  memory are deduplicated, not duplicated. */
  loadAudit(entries: VmAuditEntry[]): void {
    const seen = new Set(this.audit.map((e) => `${e.at}|${e.op}|${e.detail}`));
    const prefix: VmAuditEntry[] = [];
    for (const e of entries) {
      if (e && typeof e.at === "string" && typeof e.op === "string") {
        const norm = { at: e.at, op: e.op, detail: String(e.detail ?? "") };
        const key = `${norm.at}|${norm.op}|${norm.detail}`;
        if (!seen.has(key)) {
          seen.add(key);
          prefix.push(norm);
        }
      }
    }
    this.audit.unshift(...prefix);
  }

  snapshotRecord(): VmRecord {
    return VmRecordSchema.parse({ ...this.record, state: this.sm.state });
  }
}

function cellOrThrow(cells: Map<string, VmCell>, vmId: string): VmCell {
  const cell = cells.get(vmId);
  if (!cell) throw new EveError("VM_NOT_FOUND", `Unknown vm: ${vmId}`);
  return cell;
}

// V5: per-cell async op mutex. Each driver holds a locks map keyed by vmId and
// funnels every mutating op through this chain, so destroy (or shutdown) can
// never interleave with an in-flight boot/restore/pause on the same cell — it
// queues behind it instead. Lock entries are reaped when their tail settles.
async function runWithCellLock<T>(
  locks: Map<string, Promise<void>>,
  vmId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(vmId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const mine = new Promise<void>((res) => { release = res; });
  const tail = prev.catch(() => undefined).then(() => mine);
  locks.set(vmId, tail);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(vmId) === tail) locks.delete(vmId);
  }
}

// Best-effort transition to FAILED with an audit note. Used on command-phase
// failures so cells never sit in a transient state (BOOTING/PAUSING/STOPPING/
// RESTORING) after the operation that owned it has died.
function failCell(cell: VmCell, detail: string): void {
  cell.note("failed", detail);
  try {
    cell.go("FAILED", detail);
  } catch { /* state cannot take FAILED; destroy() drives it instead */ }
}

// V5: drive any pre-DESTROYING state to a DESTROYING-eligible one
// (CREATED/STOPPED/FAILED) without ever throwing, so destroy() always reaches
// DESTROYING -> DESTROYED. DESTROYED is entered only via DESTROYING.
const DESTROY_ELIGIBLE: ReadonlySet<VmStateT> = new Set(["CREATED", "STOPPED", "FAILED"]);

function driveToDestroyable(cell: VmCell, reason: string): void {
  if (cell.sm.state === "DESTROYING" || cell.sm.state === "DESTROYED") return;
  if (DESTROY_ELIGIBLE.has(cell.sm.state)) return;
  try {
    if (cell.sm.state === "RUNNING" || cell.sm.state === "PAUSED" || cell.sm.state === "READY") {
      cell.go("STOPPING", `${reason}: force-stop`);
    }
  } catch { /* keep driving */ }
  try {
    if (cell.sm.state === "STOPPING") cell.go("STOPPED", `${reason}: stopped`);
  } catch { /* keep driving */ }
  try {
    if (!DESTROY_ELIGIBLE.has(cell.sm.state) && cell.sm.can("FAILED")) {
      cell.go("FAILED", `${reason}: abort-inflight`);
    }
  } catch { /* destroy() surfaces any residual error */ }
}

// V4: classify restore/snapshot-load failures. A missing snapshot becomes
// SNAPSHOT_NOT_FOUND; every other error propagates unchanged (after the
// caller has moved the cell to FAILED with an audit note).
function asMissingSnapshot(err: unknown, tag: string): EveError | null {
  if (err instanceof EveError && err.code === "SNAPSHOT_NOT_FOUND") return err;
  const msg = err instanceof Error ? err.message : String(err);
  if (/no such|not found|does not exist|unknown snapshot|ENOENT/i.test(msg)) {
    return new EveError("SNAPSHOT_NOT_FOUND", `Snapshot not found: ${tag}`);
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-display host port triple. Agent/SSH forwards are derived (never a
 *  fixed per-host port) so N concurrent guests cannot collide. Bases are
 *  driver-configurable for test hermeticity (defaults = production). */
export function portsForDisplay(
  vncBase: number,
  display: number,
  agentBase = 18080,
  sshBase = 22000,
): { vnc: number; agent: number; ssh: number } {
  const i = display - vncBase;
  return { vnc: 5900 + display, agent: agentBase + i, ssh: sshBase + i };
}

/** True when something answers on host:port within `timeoutMs`. Used to
 *  avoid claiming displays held by out-of-band processes. */
export function tcpPortBusy(host: string, port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = (busy: boolean): void => {
      if (done) return;
      done = true;
      resolve(busy);
    };
    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* ignore */ }
      finish(false);
    }, timeoutMs);
    const sock = createConnection({ host, port });
    sock.on("connect", () => {
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      finish(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

function waitExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    proc.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── QemuDriver ───────────────────────────────────────────────────────────────

export interface QemuDriverOpts {
  imagesDir?: string;
  vncBase?: number;
  /** First host port for per-VM agent forwards (default 18080). */
  agentBase?: number;
  /** First host port for per-VM SSH forwards (default 22000). */
  sshBase?: number;
}

export class QemuDriver implements VmDriver {
  readonly backend = "qemu";
  private readonly cells = new Map<string, VmCell>();
  private readonly locks = new Map<string, Promise<void>>();
  // V2: allocated VNC displays; boot holds one per running cell so two cells
  // can never share a display. displayOf keys the holder for release.
  private readonly displays = new Set<number>();
  private readonly displayOf = new Map<string, number>();
  private readonly imagesDir: string;
  private readonly vncBase: number;
  private readonly agentBase: number;
  private readonly sshBase: number;

  constructor(opts: QemuDriverOpts = {}) {
    this.imagesDir = opts.imagesDir ?? join(tmpdir(), "eve-x", "images");
    this.vncBase = opts.vncBase ?? 10;
    this.agentBase = opts.agentBase ?? 18080;
    this.sshBase = opts.sshBase ?? 22000;
  }

  private portsFor(d: number): { vnc: number; agent: number; ssh: number } {
    return portsForDisplay(this.vncBase, d, this.agentBase, this.sshBase);
  }

  private withCellLock<T>(cell: VmCell, fn: () => Promise<T>): Promise<T> {
    return runWithCellLock(this.locks, cell.record.vmId, fn);
  }

  // V2 test hook + boot primitive: claim a free display in
  // [vncBase, vncBase+40), or throw NO_DISPLAY when exhausted. Idempotent per
  // vmId so a retry after FAILED reuses its own claim instead of leaking one.
  // The TCP probe guards against out-of-band holders (orphaned QEMU from a
  // previous process, foreign services): a display whose VNC/agent/SSH ports
  // answer is skipped, never stolen.
  async allocateDisplay(vmId: string): Promise<number> {
    const existing = this.displayOf.get(vmId);
    if (existing !== undefined) return existing;
    for (let d = this.vncBase; d < this.vncBase + 40; d++) {
      if (this.displays.has(d)) continue;
      // Reserve synchronously BEFORE any await: concurrent boots must never
      // observe the same display as free (TOCTOU double-claim → two QEMUs on
      // one VNC port → second boot dies). Probe failures release the claim.
      this.displays.add(d);
      this.displayOf.set(vmId, d);
      const ports = this.portsFor(d);
      if (await tcpPortBusy("127.0.0.1", ports.vnc)) { this.releaseDisplay(vmId); continue; }
      if (await tcpPortBusy("127.0.0.1", ports.agent)) { this.releaseDisplay(vmId); continue; }
      if (await tcpPortBusy("127.0.0.1", ports.ssh)) { this.releaseDisplay(vmId); continue; }
      return d;
    }
    throw new EveError("NO_DISPLAY", `No free VNC display in [${this.vncBase}, ${this.vncBase + 40})`);
  }

  /** Host ports derived from a display claim. VNC 59xx is QEMU's own
   *  mapping; agent/SSH forwards are per-VM so concurrent guests never
   *  collide on a fixed port. */
  guestAgentPort(vmId: string): number {
    const d = this.displayOf.get(vmId);
    if (d === undefined) throw new EveError("NO_DISPLAY", `No display claimed for ${vmId}`);
    return this.portsFor(d).agent;
  }

  guestSshPort(vmId: string): number {
    const d = this.displayOf.get(vmId);
    if (d === undefined) throw new EveError("NO_DISPLAY", `No display claimed for ${vmId}`);
    return this.portsFor(d).ssh;
  }

  /** Host TCP port of this VM's QEMU VNC server (127.0.0.1 only). */
  vncPortFor(vmId: string): number {
    const d = this.displayOf.get(vmId);
    if (d === undefined) throw new EveError("NO_DISPLAY", `No display claimed for ${vmId}`);
    return this.portsFor(d).vnc;
  }

  releaseDisplay(vmId: string): void {
    const d = this.displayOf.get(vmId);
    if (d !== undefined) {
      this.displayOf.delete(vmId);
      this.displays.delete(d);
    }
  }

  /** Display currently claimed by a cell, if any (persistence/recovery). */
  claimedDisplay(vmId: string): number | null {
    return this.displayOf.get(vmId) ?? null;
  }

  /**
   * Restore a display claim after process restart (recovery path only).
   * Bypasses the TCP probe deliberately: the still-running QEMU owns these
   * ports, so probing would refuse our own allocation. Callers must verify
   * the recorded pid is alive first.
   */
  restoreDisplayClaim(vmId: string, display: number): void {
    if (!Number.isInteger(display)) throw new EveError("BAD_ARG", "display must be an integer");
    this.displays.add(display);
    this.displayOf.set(vmId, display);
  }

  cellCountForTest(): number {
    return this.cells.size;
  }

  transitionForTest(vmId: string, to: VmStateT): void {
    cellOrThrow(this.cells, vmId).go(to, "test-hook");
  }

  /** Live QMP channel for a booted cell (qualification/diagnostics hook). */
  qmpForTest(vmId: string): QmpConnection {
    const cell = cellOrThrow(this.cells, vmId);
    if (!cell.qmp) throw new EveError("QMP_CLOSED", `No live QMP channel for ${vmId}`);
    return cell.qmp;
  }

  /**
   * Reattach a live QEMU that outlived the control-plane process (restart
   * recovery). The OS process cannot be adopted as a ChildProcess, so the
   * cell carries no proc handle: graceful shutdown uses QMP powerdown, and
   * destroy falls back to the recorded pid. Liveness is PROVEN first via
   * QMP query-status — a dead socket fails closed instead of hallucinating
   * a running VM. The caller must restore the display claim (ports still
   * belong to the live QEMU).
   */
  async reattach(vmId: string, owner: string, specInput: unknown, workdir: string, pid?: number): Promise<VmRecord> {
    if (this.cells.has(vmId)) throw new EveError("ALREADY_ATTACHED", `vm ${vmId} is already attached in this process`);
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const qmpSock = join(workdir, "qmp.sock");
    const probe = new QmpConnection();
    try {
      await probe.connect(qmpSock, 8000);
      const st = await probe.command("query-status");
      const qstate = (st["return"] as { status?: unknown } | undefined)?.status;
      if (qstate !== "running" && qstate !== "paused" && qstate !== "inmigrate") {
        probe.close();
        throw new EveError("VM_NOT_RUNNING", `QEMU for ${vmId} reports status ${String(qstate)}`);
      }
    } catch (err) {
      try { probe.close(); } catch { /* ignore */ }
      // Any failure to prove liveness (refused socket, timeout, bad status)
      // is the same verdict: no live QEMU to adopt. Fail closed.
      const detail = err instanceof Error ? err.message : String(err);
      throw new EveError("VM_NOT_RUNNING", `No live QEMU for ${vmId}: ${detail}`);
    }
    probe.close();
    // Reachable states map onto the audited machine without transitions:
    // the VM never stopped, so we record observed state, not a transition.
    const cell = new VmCell({ vmId, owner, backend: this.backend, spec, workdir, initialState: "RUNNING" });
    // Restore pre-restart history first so the audit trail is continuous;
    // the reattach note below lands last, in order.
    cell.loadAudit(readAuditFile(workdir));
    if (pid !== undefined) cell.record.pid = pid;
    cell.note("reattach", `adopted live QEMU${pid !== undefined ? ` pid=${pid}` : ""}`);
    this.cells.set(vmId, cell);
    return cell.snapshotRecord();
  }

  private qcow2(cell: VmCell): string {
    return join(cell.record.workdir, "disk.qcow2");
  }

  private qmpPath(cell: VmCell): string {
    return join(cell.record.workdir, "qmp.sock");
  }

  async create(specInput: unknown, owner: string, opts: CreateOpts = {}): Promise<VmRecord> {
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const vmId = uid("vm");
    const workdir = join(this.imagesDir, vmId);
    await fs.mkdir(workdir, { recursive: true });
    const cell = new VmCell({ vmId, owner, backend: this.backend, spec, workdir });
    // Per-VM guest-agent secret lands in the workdir before anything boots.
    const guestSecret = await provisionGuestSecret(workdir);
    // Per-VM NoCloud seed: identity + ssh + guest secret for the in-guest
    // agent. Built with cloud-localds when available; otherwise the VM boots
    // seedless and the audit record says so (never silently assumed).
    const seedIso = join(workdir, "seed.iso");
    let seeded = false;
    try {
      const userData = opts.seedUserData ?? defaultSeedUserData({
        hostname: opts.hostname ?? `eve-${vmId}`,
        sshKey: opts.sshKey,
        guestSecret,
      });
      await fs.writeFile(join(workdir, "user-data"), userData, "utf8");
      await fs.writeFile(
        join(workdir, "meta-data"),
        `instance-id: ${vmId}\nlocal-hostname: ${opts.hostname ?? `eve-${vmId}`}\n`,
        "utf8",
      );
      const seed = await runCmd("cloud-localds", [seedIso, join(workdir, "user-data"), join(workdir, "meta-data")], 60000);
      seeded = seed.code === 0;
      if (!seeded) await fs.rm(seedIso, { force: true });
    } catch {
      seeded = false;
    }
    cell.note("seed", seeded ? `nocloud ${seedIso}` : "seedless: cloud-localds unavailable");
    let imgArgs: string[];
    if (opts.baseImage) {
      // Overlay mode: private CoW layer over a read-only golden base. The
      // base itself is never opened for writing by this path.
      const base = resolveBaseImage(this.imagesDir, opts.baseImage);
      const pin = await backingDigest(base).catch((err) => {
        throw new EveError("BASE_MISSING", `Base image unreadable: ${opts.baseImage}: ${err instanceof Error ? err.message : String(err)}`);
      });
      await fs.writeFile(join(workdir, "base-pin.json"), JSON.stringify({ base, ...pin }, null, 2), "utf8");
      imgArgs = ["create", "-f", "qcow2", "-F", "qcow2", "-b", base, this.qcow2(cell)];
      cell.note("create", `overlay over ${opts.baseImage} digest=${pin.digest.slice(0, 16)} cpu=${spec.cpu} mem=${spec.memoryMb}Mb`);
    } else {
      imgArgs = ["create", "-f", "qcow2", this.qcow2(cell), `${spec.diskGb}G`];
      cell.note("create", `qcow2 ${spec.diskGb}G cpu=${spec.cpu} mem=${spec.memoryMb}Mb`);
    }
    const img = await runCmd("qemu-img", imgArgs, 60000);
    if (img.code !== 0) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new EveError("QEMU_IMAGE_FAILED", `qemu-img failed: ${img.stderr || img.stdout}`);
    }
    cell.go("CREATED", "image-ready");
    this.cells.set(vmId, cell);
    return cell.snapshotRecord();
  }

  /** Re-fingerprint the pinned base; any drift refuses boot (fail closed). */
  private async verifyBaseImmutable(cell: VmCell): Promise<void> {
    let pin: BasePin;
    try {
      pin = JSON.parse(await fs.readFile(join(cell.record.workdir, "base-pin.json"), "utf8")) as BasePin;
    } catch {
      return; // no overlay: nothing pinned
    }
    const cur = await backingDigest(pin.base).catch(() => null);
    if (!cur || cur.digest !== pin.digest || cur.size !== pin.size) {
      throw new EveError("BASE_MUTATED", `Base image ${pin.base} changed since overlay creation; refusing boot`);
    }
  }

  async boot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      // Allocated before any transition: NO_DISPLAY leaves state untouched.
      // Async: the allocator TCP-probes each candidate triple so an orphaned
      // QEMU (or any foreign listener) is skipped, never collided with.
      const display = await this.allocateDisplay(cell.record.vmId);
      // V3: a crashed previous boot leaves qmp.sock behind and the next bind
      // fails; remove it best-effort before spawning.
      await fs.rm(this.qmpPath(cell), { force: true }).catch(() => undefined);
      // V6: a FAILED cell re-enters the creation pipeline with an audit trail.
      // CREATING cannot go straight to BOOTING, so it passes via CREATED.
      if (cell.sm.state === "FAILED") {
        cell.go("CREATING", "boot-retry: failed-requeue");
        cell.go("CREATED", "boot-retry: recreated");
      }
      cell.go("BOOTING", "boot-requested");
      // Base immutability is enforced before the first byte of guest code can
      // run: a drifted golden image fails closed instead of booting.
      try {
        await this.verifyBaseImmutable(cell);
      } catch (err) {
        this.releaseDisplay(cell.record.vmId);
        failCell(cell, err instanceof Error ? err.message : String(err));
        throw err;
      }
      const spec = cell.record.spec;
      const qmpSock = this.qmpPath(cell);
      const qgaSock = join(cell.record.workdir, "qga.sock");
      await fs.rm(qgaSock, { force: true }).catch(() => undefined);
      const args: string[] = [
        // Repeated -accel flags = preference order (QEMU ≥7; the legacy
        // "kvm,tcg" comma form is rejected by QEMU 10+).
        "-accel", "kvm",
        "-accel", "tcg",
        "-m", String(spec.memoryMb),
        "-smp", String(spec.cpu),
        "-drive", `file=${this.qcow2(cell)},format=qcow2,if=virtio`,
        "-qmp", `unix:${qmpSock},server=on,wait=off`,
        // qemu-guest-agent channel (virtio-serial). The guest must run
        // qemu-guest-agent (baked via cloud-init packages); without it the
        // socket stays quiet and guest-exec fails closed with QGA_ABSENT.
        "-chardev", `socket,path=${qgaSock},server=on,wait=off,id=qga0`,
        "-device", "virtio-serial-pci",
        "-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0",
        // Serial console to a per-VM log: guest boot/diagnostic visibility
        // without VNC (invaluable when the framebuffer is a frozen BIOS).
        "-serial", `file:${join(cell.record.workdir, "console.log")}`,
        // Explicit std-VGA resolution from the VmSpec so the guest mode is
        // deterministic (otherwise QEMU/guest defaults apply and the mode
        // must be discovered from screendumps instead).
        "-device", `VGA,xres=${Number(spec.width) || 1280},yres=${Number(spec.height) || 800}`,
        "-display", "none",
        "-vnc", `127.0.0.1:${display}`,
        "-k", "en-us",
        "-rtc", "base=utc",
        // Seccomp sandbox: QEMU refuses obsolete syscalls, privilege
        // elevation, process spawning and resource-control tampering.
        "-sandbox", "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
      ];
      // Per-VM seed ISO, attached strictly read-only.
      let seedAttached = false;
      try {
        await fs.access(join(cell.record.workdir, "seed.iso"));
        args.push("-drive", `file=${join(cell.record.workdir, "seed.iso")},format=raw,if=virtio,readonly=on`);
        seedAttached = true;
      } catch { /* seedless boot */ }
      if (spec.network === "none") {
        args.push("-net", "none");
      } else {
        // User-mode networking with per-VM host-forwards for the in-guest
        // EVE agent and diagnostic SSH. All forwards bind 127.0.0.1 only
        // and are derived from the display claim (never fixed ports), so
        // concurrent guests cannot collide. SSH uses the per-VM seed key
        // and is a recovery channel, never the primary control mechanism
        // (QMP + HMAC guest agent are).
        const ports = this.portsFor(display);
        cell.note("forwards", `agent=127.0.0.1:${ports.agent} ssh=127.0.0.1:${ports.ssh} (seed key only)`);
        args.push(
          "-netdev", `user,id=net0,hostfwd=tcp:127.0.0.1:${ports.agent}-:18080,hostfwd=tcp:127.0.0.1:${ports.ssh}-:22`,
          "-device", "virtio-net-pci,netdev=net0",
        );
      }
      let proc: ChildProcess;
      try {
        proc = spawn("qemu-system-x86_64", args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        this.releaseDisplay(cell.record.vmId);
        failCell(cell, `spawn failed: ${errMsg(err)}`);
        throw new EveError("QEMU_SPAWN", "qemu-system-x86_64 spawn failed");
      }
      cell.proc = proc;
      cell.record.pid = proc.pid;
      proc.stdout?.on("data", () => undefined);
      proc.stderr?.on("data", () => undefined);
      proc.on("error", () => {
        failCell(cell, "qemu process error");
      });
      proc.on("exit", () => {
        cell.qmp?.close();
        cell.qmp = null;
      });
      // wait for the QMP socket to appear, then handshake
      const qmp = new QmpConnection();
      let connected = false;
      for (let i = 0; i < 50; i++) {
        try {
          await qmp.connect(qmpSock, 2000);
          connected = true;
          break;
        } catch {
          if (proc.exitCode !== null) break;
          await sleep(200);
        }
      }
      if (!connected) {
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
        cell.proc = null;
        this.releaseDisplay(cell.record.vmId);
        failCell(cell, "qmp-handshake-failed");
        throw new EveError("QMP_HANDSHAKE", "QEMU started but QMP handshake failed");
      }
      cell.qmp = qmp;
      cell.startedAtMs = Date.now();
      cell.note("boot", `pid=${proc.pid ?? -1} vnc=127.0.0.1:${display} qmp=${qmpSock} seed=${seedAttached ? "attached-ro" : "absent"}`);
      cell.go("READY", "qmp-handshake-ok");
      cell.go("RUNNING", "boot-complete");
    });
  }

  private async qmpOf(cell: VmCell): Promise<QmpConnection> {
    const q = cell.qmp;
    if (!q) throw new EveError("QMP_CLOSED", `No QMP channel for ${cell.record.vmId}`);
    return q;
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("STOPPING", "shutdown-requested");
      try {
        const q = await this.qmpOf(cell);
        // best-effort graceful powerdown (PAUSED vms need cont first)
        try { await q.command("cont"); } catch { /* maybe already running */ }
        await q.command("system_powerdown");
      } catch { /* fall through to SIGTERM */ }
      if (cell.proc) {
        try { cell.proc.kill("SIGTERM"); } catch { /* gone */ }
        await waitExit(cell.proc, 8000);
        cell.proc = null;
      }
      cell.qmp?.close();
      cell.qmp = null;
      cell.startedAtMs = null;
      this.releaseDisplay(cell.record.vmId);
      try {
        cell.go("STOPPED", "shutdown-complete");
      } catch (err) {
        failCell(cell, `shutdown-complete failed: ${errMsg(err)}`);
        throw err;
      }
    });
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("PAUSING", "pause-requested");
      try {
        const q = await this.qmpOf(cell);
        await q.command("stop");
      } catch (err) {
        failCell(cell, `pause failed: ${errMsg(err)}`);
        throw err;
      }
      cell.go("PAUSED", "qmp-stop-ok");
    });
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
      const q = await this.qmpOf(cell);
      await q.command("cont");
      cell.go("RUNNING", "qmp-cont-ok");
    });
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
      const q = await this.qmpOf(cell);
      await q.command("system_reset");
      cell.note("reboot", "qmp-system_reset-ok");
    });
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
      const q = await this.qmpOf(cell);
      // Snapshot ops never change state: failure is noted and rethrown with
      // the cell untouched. savevm scales with guest RAM + host I/O pressure
      // (minutes for desktop guests); timeout generously, fail loudly.
      try {
        await q.command("human-monitor-command", { "command-line": `savevm ${tag}` }, 600000);
      } catch (err) {
        cell.note("snapshot-failed", `savevm ${tag}: ${errMsg(err)}`);
        throw err;
      }
      const id = `${vmId}@${tag}`;
      cell.note("snapshot", id);
      return id;
    });
  }

  async restore(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "PAUSED" && cell.sm.state !== "RUNNING") {
        throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
      }
      const wasPaused = cell.sm.state === "PAUSED";
      cell.go("RESTORING", `restore ${tag}`);
      // V4: a loadvm failure must land in FAILED (never back in RUNNING) with
      // an audit note; a missing snapshot maps to SNAPSHOT_NOT_FOUND.
      try {
        const q = await this.qmpOf(cell);
        await q.command("human-monitor-command", { "command-line": `loadvm ${tag}` }, 120000);
        if (wasPaused) await q.command("cont");
      } catch (err) {
        failCell(cell, `restore failed: ${tag}: ${errMsg(err)}`);
        throw asMissingSnapshot(err, tag) ?? err;
      }
      cell.go("RUNNING", "restore-complete");
      const id = `${vmId}@${tag}`;
      cell.note("restore", id);
      return id;
    });
  }

  async clone(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    return this.withCellLock(src, async () => (await this.cloneInnerNoLock(src, newOwner)).rec);
  }

  /** Clone without taking the source lock; the caller must already hold it
   *  (clone() takes it; fork() holds it for the whole operation). */
  private async cloneInnerNoLock(src: VmCell, newOwner: string): Promise<{ rec: VmRecord; marker: string | null }> {
    const vmId = src.record.vmId;
    const dstId = uid("vm");
    const workdir = join(this.imagesDir, dstId);
    await fs.mkdir(workdir, { recursive: true });
    const dst = new VmCell({ vmId: dstId, owner: newOwner, backend: this.backend, spec: src.record.spec, workdir });
    let marker: string | null = null;
    try {
      if (src.sm.state === "RUNNING" || src.sm.state === "PAUSED") {
        marker = await this.liveCopy(src, dst);
      } else {
        const cp = await runCmd("qemu-img", ["convert", "-O", "qcow2", this.qcow2(src), this.qcow2(dst)], 120000);
        if (cp.code !== 0) {
          throw new EveError("QEMU_CLONE_FAILED", `qemu-img convert failed: ${cp.stderr || cp.stdout}`);
        }
      }
    } catch (err) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw err;
    }
    dst.note("clone", `from ${vmId}`);
    dst.go("CREATED", "clone-ready");
    this.cells.set(dstId, dst);
    return { rec: dst.snapshotRecord(), marker };
  }

  private async cloneInner(vmId: string, newOwner: string): Promise<{ rec: VmRecord; marker: string | null }> {
    const src = cellOrThrow(this.cells, vmId);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    return this.withCellLock(src, async () => this.cloneInnerNoLock(src, newOwner));
  }

  /**
   * Consistent copy of a LIVE source image. qemu-img convert cannot open an
   * image QEMU holds, so: halt CPUs (stop) → savevm a fork marker (flushes
   * all guest state into the image) → plain filesystem copy of the overlay
   * (no QEMU locks involved; backing is shared read-only and never copied)
   * → resume. The marker lets a forked child loadvm into the exact source
   * moment. Failures resume the source whenever possible; a source that
   * cannot resume lands in FAILED (never silently wedged).
   */
  private async liveCopy(src: VmCell, dst: VmCell): Promise<string> {
    const wasPaused = src.sm.state === "PAUSED";
    const q = await this.qmpOf(src);
    if (!wasPaused) {
      src.go("PAUSING", "clone-quiesce");
      try {
        await q.command("stop");
      } catch (err) {
        failCell(src, `clone-quiesce failed: ${errMsg(err)}`);
        throw err;
      }
      src.go("PAUSED", "clone-quiesced");
    }
    const tag = validateSnapshotLabel(`fork-base-${dst.record.vmId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}`);
    // savevm duration scales with guest RAM dirtied pages and host I/O
    // pressure (minutes for multi-GB desktop guests); the timeout is
    // generous and the tag is unique per fork so a timed-out partial never
    // collides with a retry.
    try {
      await q.command("human-monitor-command", { "command-line": `savevm ${tag}` }, 600000);
      src.note("fork-marker", tag);
    } catch (err) {
      await this.resumeCell(src, q).catch(() => undefined);
      throw new EveError("QEMU_CLONE_FAILED", `fork marker savevm failed: ${errMsg(err)}`);
    }
    const cp = await runCmd("cp", [this.qcow2(src), this.qcow2(dst)], 120000);
    if (cp.code !== 0) {
      await this.resumeCell(src, q).catch(() => undefined);
      throw new EveError("QEMU_CLONE_FAILED", `overlay copy failed: ${cp.stderr || cp.stdout}`);
    }
    if (!wasPaused) {
      await this.resumeCell(src, q);
    }
    return tag;
  }

  private async resumeCell(src: VmCell, q: QmpConnection): Promise<void> {
    // Resume is retried: after minutes of savevm + multi-GB copy under host
    // I/O pressure, a single 10 s QMP round-trip can spuriously time out on
    // an otherwise healthy QEMU. cont on a running guest is a harmless
    // no-op, so retries are safe; persistent failure lands FAILED honestly.
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await q.command("cont", undefined, 30000);
        if (src.sm.state === "PAUSED") src.go("RUNNING", "clone-resumed");
        return;
      } catch (err) {
        lastErr = err;
        src.note("resume-retry", `cont attempt ${attempt} failed: ${errMsg(err)}`);
        await sleep(2000);
      }
    }
    failCell(src, `clone-resume failed: ${errMsg(lastErr)}`);
    throw lastErr instanceof Error ? lastErr : new EveError("QEMU_RESUME_FAILED", String(lastErr));
  }

  async fork(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    // The source cell is locked for the whole fork; cloneInner/boot below
    // only ever lock the *destination* cell, so no lock nesting can occur.
    // cloneInner quiesces the live source itself (stop → marker → copy →
    // resume), so no outer stop/cont is needed or allowed here.
    return this.withCellLock(src, async () => {
      if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
      if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
      const { rec, marker } = await this.cloneInnerNoLock(src, newOwner);
      src.note("fork", `forked to ${rec.vmId}`);
      const dst = cellOrThrow(this.cells, rec.vmId);
      // fork goes through the normal boot path but keeps FORKING visible in audit
      dst.note("fork", `forked from ${vmId}`);
      await this.boot(dst.record.vmId);
      if (marker) {
        // Start the child at the exact source moment captured by the
        // marker. The marker was taken with CPUs halted, so the child must
        // be resumed after loadvm — otherwise it sits frozen while the
        // state machine claims RUNNING.
        const dq = await this.qmpOf(cellOrThrow(this.cells, rec.vmId));
        await dq.command("human-monitor-command", { "command-line": `loadvm ${marker}` }, 120000);
        await dq.command("cont");
        cellOrThrow(this.cells, rec.vmId).note("fork-resume", `loaded marker ${marker}`);
      }
      return cellOrThrow(this.cells, rec.vmId).snapshotRecord();
    });
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      // V5: best-effort stop from ANY state. Transition errors here are caught
      // so destroy can never be aborted by an in-flight op's leftovers.
      try {
        const q = cell.qmp;
        const st = cell.sm.state;
        if (q && (st === "RUNNING" || st === "PAUSED" || st === "READY")) {
          try {
            try { await q.command("cont"); } catch { /* maybe already running */ }
            await q.command("system_powerdown");
          } catch { /* fall through to signals */ }
          if (cell.proc) {
            try { cell.proc.kill("SIGTERM"); } catch { /* gone */ }
            await waitExit(cell.proc, 3000);
          }
        }
      } catch { /* best effort only */ }
      if (cell.proc) {
        try { cell.proc.kill("SIGKILL"); } catch { /* gone */ }
        cell.proc = null;
      }
      cell.qmp?.close();
      cell.qmp = null;
      cell.startedAtMs = null;
      this.releaseDisplay(cell.record.vmId);
      await fs.rm(cell.record.workdir, { recursive: true, force: true });
      driveToDestroyable(cell, "destroy");
      cell.go("DESTROYING", "destroy-requested");
      cell.go("DESTROYED", "destroy-complete");
      this.cells.delete(vmId);
    });
  }

  async screendump(vmId: string): Promise<Buffer> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot screendump from ${cell.sm.state}`);
    }
    const q = await this.qmpOf(cell);
    const out = join(cell.record.workdir, `screen-${Date.now()}.ppm`);
    await q.command("screendump", { filename: out, format: "png" }).catch(async () => {
      await q.command("screendump", { filename: out });
    });
    const data = await fs.readFile(out);
    await fs.rm(out, { force: true });
    return data;
  }

  async status(vmId: string): Promise<VmStatus> {
    const cell = cellOrThrow(this.cells, vmId);
    return VmStatusSchema.parse({
      vmId: cell.record.vmId,
      backend: this.backend,
      state: cell.sm.state,
      uptimeMs: cell.startedAtMs ? Date.now() - cell.startedAtMs : 0,
      pid: cell.record.pid,
      detail: `qemu pid=${cell.record.pid ?? -1}`,
    });
  }

  // ── qemu-guest-agent execution (direct virtio-serial channel) ─────────────
  // guest-exec runs a command INSIDE the guest (requires qemu-guest-agent
  // running there, installed via the seed/cloud-init path). The channel is a
  // direct connection to qga.sock with a guest-sync liveness proof — NOT QMP
  // passthrough, which is absent on some QEMU builds (Debian QEMU 10
  // registers no guest-* QMP commands). Without a live agent every call
  // fails closed with QGA_ABSENT — never silently local.

  /**
   * Run fn against a fresh QGA channel, always closing afterwards. The
   * virtio-serial host socket serves one client: connections are NEVER
   * cached, because every leaked half-open client wedges the slot for all
   * later callers (observed live as a permanently silent channel).
   */
  private async withQga<T>(cell: VmCell, fn: (q: QmpConnection) => Promise<T>): Promise<T> {
    const conn = new QmpConnection();
    try {
      await conn.connectQga(join(cell.record.workdir, "qga.sock"), 10000);
    } catch (err) {
      conn.close();
      throw new EveError("QGA_ABSENT", `Guest agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      return await fn(conn);
    } finally {
      conn.close();
    }
  }

  private qgaGuestExec(q: QmpConnection, argv: readonly string[]): Promise<Record<string, unknown>> {
    const parsed = z.array(z.string().min(1).max(512)).min(1).max(16).parse([...argv]);
    return q.command("guest-exec", {
      path: parsed[0] as string,
      arg: parsed.slice(1),
      "capture-output": true,
    });
  }

  async guestExec(vmId: string, argv: readonly string[]): Promise<{ pid: number }> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot guest-exec from ${cell.sm.state}`);
    }
    let res: Record<string, unknown>;
    try {
      res = await this.withQga(cell, (q) => this.qgaGuestExec(q, argv));
    } catch (err) {
      if (err instanceof EveError && err.code === "QGA_ABSENT") throw err;
      throw new EveError("QGA_ABSENT", `Guest agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { pid: parseGuestExecPid(res) };
  }

  async guestExecStatus(vmId: string, pid: number): Promise<{ exited: boolean; exitcode?: number; out?: string; err?: string }> {
    const cell = cellOrThrow(this.cells, vmId);
    let res: Record<string, unknown>;
    try {
      res = await this.withQga(cell, (q) => q.command("guest-exec-status", { pid }));
    } catch (err) {
      if (err instanceof EveError && err.code === "QGA_ABSENT") throw err;
      throw new EveError("QGA_ABSENT", `Guest agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseGuestExecStatus(res);
  }

  /** Run argv to completion inside the guest (one channel for exec+polls). */
  async guestExecSync(vmId: string, argv: readonly string[], timeoutMs = 60000): Promise<{ exitcode: number; out: string; err: string }> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot guest-exec from ${cell.sm.state}`);
    }
    return this.withQga(cell, async (q) => {
      let res: Record<string, unknown>;
      try {
        res = await this.qgaGuestExec(q, argv);
      } catch (err) {
        throw new EveError("QGA_ABSENT", `Guest agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const pid = parseGuestExecPid(res);
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let st: Record<string, unknown>;
        try {
          st = await q.command("guest-exec-status", { pid });
        } catch (err) {
          throw new EveError("QGA_ABSENT", `Guest agent unavailable: ${err instanceof Error ? err.message : String(err)}`);
        }
        const parsed = parseGuestExecStatus(st);
        if (parsed.exited) {
          return { exitcode: parsed.exitcode ?? -1, out: parsed.out ?? "", err: parsed.err ?? "" };
        }
        if (Date.now() > deadline) throw new EveError("QGA_TIMEOUT", `guest-exec timed out`);
        await sleep(500);
      }
    });
  }

  auditLog(vmId: string): VmAuditEntry[] {
    return [...cellOrThrow(this.cells, vmId).audit];
  }
}

/** QMP envelopes wrap payloads in `{"return": ...}`. This parser isolates
 *  that shape so a bare-payload regression fails loudly in unit tests. */
export function parseGuestExecPid(res: Record<string, unknown>): number {
  const pid = (res["return"] as { pid?: unknown } | undefined)?.pid;
  if (typeof pid !== "number") throw new EveError("QGA_ABSENT", "guest-exec returned no pid (agent missing?)");
  return pid;
}

/** Parse a guest-exec-status payload (base64 output decoded). */
export function parseGuestExecStatus(res: Record<string, unknown>): { exited: boolean; exitcode?: number; out?: string; err?: string } {
  const ret = (res["return"] ?? {}) as Record<string, unknown>;
  const out64 = typeof ret["out-data"] === "string" ? Buffer.from(ret["out-data"], "base64").toString("utf8") : undefined;
  const err64 = typeof ret["err-data"] === "string" ? Buffer.from(ret["err-data"], "base64").toString("utf8") : undefined;
  return {
    exited: Boolean(ret["exited"]),
    exitcode: typeof ret["exitcode"] === "number" ? ret["exitcode"] : undefined,
    out: out64,
    err: err64,
  };
}

// ── DockerDesktopDriver (real docker CLI: run/start/stop/commit/cp/exec/logs) ─

const DEFAULT_DOCKER_IMAGE = "dorowu/ubuntu-desktop-lxde-vnc:latest";

// V7: hardening + network flags shared by boot and restore so a restored
// container can never come back less isolated than a fresh boot.
function dockerRunHardening(spec: VmSpecT): { args: string[]; isolation: string; detail: string } {
  const harden = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "256"];
  if (spec.network === "none") {
    return {
      args: ["--network", "none", ...harden],
      isolation: "network=none+cap-drop+pids-limit",
      detail: "isolation: network=none, cap-drop ALL, no-new-privileges, pids-limit 256",
    };
  }
  if (spec.network === "allowlisted") {
    // Documented constraint: the allowlist is enforced at the proxy layer,
    // not by docker networking. The container itself runs fully offline
    // (--network none); this records that instead of claiming full
    // allowlisting at the container boundary.
    return {
      args: ["--network", "none", ...harden],
      isolation: "network=none+cap-drop+pids-limit(proxy-allowlist)",
      detail: "isolation: allowlisted egress enforced at proxy layer (documented constraint); container runs --network none, cap-drop ALL, no-new-privileges, pids-limit 256",
    };
  }
  return {
    args: [...harden],
    isolation: "bridge+cap-drop+pids-limit",
    detail: "isolation: default bridge, cap-drop ALL, no-new-privileges, pids-limit 256",
  };
}

export interface DockerDriverOpts {
  workdirBase?: string;
  defaultImage?: string;
}

export class DockerDesktopDriver implements VmDriver {
  readonly backend = "docker";
  private readonly cells = new Map<string, VmCell>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly base: string;
  private readonly defaultImage: string;

  constructor(opts: DockerDriverOpts = {}) {
    this.base = opts.workdirBase ?? join(tmpdir(), "eve-x", "docker");
    this.defaultImage = opts.defaultImage ?? DEFAULT_DOCKER_IMAGE;
  }

  private withCellLock<T>(cell: VmCell, fn: () => Promise<T>): Promise<T> {
    return runWithCellLock(this.locks, cell.record.vmId, fn);
  }

  cellCountForTest(): number {
    return this.cells.size;
  }

  transitionForTest(vmId: string, to: VmStateT): void {
    cellOrThrow(this.cells, vmId).go(to, "test-hook");
  }

  private imageFor(spec: VmSpecT): string {
    return spec.image === "ubuntu-desktop-v1" ? this.defaultImage : spec.image;
  }

  private cname(cell: VmCell): string {
    return `eve-${cell.record.vmId}`;
  }

  private async docker(args: readonly string[], timeoutMs = 60000): Promise<CmdResult> {
    const r = await runCmd("docker", args, timeoutMs);
    if (r.code !== 0) throw new EveError("DOCKER_FAILED", `docker ${args[0] ?? ""} failed: ${r.stderr || r.stdout}`);
    return r;
  }

  async create(specInput: unknown, owner: string, opts: CreateOpts = {}): Promise<VmRecord> {
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    validateDockerImage(this.imageFor(spec));
    if (opts.baseImage) {
      // Container backend boots from registry images, not qcow2 bases.
      throw new EveError("UNSUPPORTED", "Docker backend does not use qcow2 base images");
    }
    const vmId = uid("vm");
    const workdir = join(this.base, vmId);
    await fs.mkdir(workdir, { recursive: true });
    const cell = new VmCell({ vmId, owner, backend: this.backend, spec, workdir });
    cell.record.containerName = `eve-${vmId}`;
    cell.note("create", `image=${this.imageFor(spec)} name=eve-${vmId}`);
    cell.go("CREATED", "record-ready");
    this.cells.set(vmId, cell);
    return cell.snapshotRecord();
  }

  async boot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const spec = cell.record.spec;
      const image = validateDockerImage(this.imageFor(spec));
      // V6: FAILED retry re-enters the creation pipeline (via CREATED, since
      // CREATING cannot transition straight to BOOTING).
      if (cell.sm.state === "FAILED") {
        cell.go("CREATING", "boot-retry: failed-requeue");
        cell.go("CREATED", "boot-retry: recreated");
      }
      cell.go("BOOTING", "boot-requested");
      const name = this.cname(cell);
      const harden = dockerRunHardening(spec);
      try {
        // reuse an existing stopped container when present, else run a fresh xfce+x11vnc guest
        const inspect = await runCmd("docker", ["inspect", name], 15000);
        if (inspect.code === 0) {
          await this.docker(["start", name]);
        } else {
          const args = [
            "run", "-d", "--name", name,
            "--memory", `${spec.memoryMb}m`,
            "--cpus", String(spec.cpu),
            ...harden.args,
            "-e", `VNC_RESOLUTION=${spec.width}x${spec.height}`,
            "-e", `TZ=${spec.timezone}`,
            image,
          ];
          await this.docker(args, 120000);
        }
      } catch (err) {
        failCell(cell, `boot failed: ${errMsg(err)}`);
        throw err;
      }
      cell.record.detail = harden.detail;
      cell.startedAtMs = Date.now();
      cell.note("boot", `container=${name} image=${image} isolation=${harden.isolation}`);
      cell.go("READY", "container-running");
      cell.go("RUNNING", "boot-complete");
    });
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("STOPPING", "shutdown-requested");
      try {
        await this.docker(["stop", "-t", "10", this.cname(cell)], 60000);
      } catch (err) {
        failCell(cell, `shutdown failed: ${errMsg(err)}`);
        throw err;
      }
      cell.startedAtMs = null;
      cell.go("STOPPED", "container-stopped");
    });
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("PAUSING", "pause-requested");
      try {
        await this.docker(["pause", this.cname(cell)]);
      } catch (err) {
        failCell(cell, `pause failed: ${errMsg(err)}`);
        throw err;
      }
      cell.go("PAUSED", "container-paused");
    });
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
      await this.docker(["unpause", this.cname(cell)]);
      cell.go("RUNNING", "container-unpaused");
    });
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
      await this.docker(["restart", "-t", "10", this.cname(cell)], 90000);
      cell.startedAtMs = Date.now();
      cell.note("reboot", "container-restarted");
    });
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
        throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
      }
      const ref = `${this.cname(cell)}:${tag}`;
      // Snapshot ops never change state: failure is noted and rethrown with
      // the cell untouched.
      try {
        await this.docker(["commit", "-p", this.cname(cell), ref], 120000);
      } catch (err) {
        cell.note("snapshot-failed", `commit ${ref}: ${errMsg(err)}`);
        throw err;
      }
      cell.note("snapshot", ref);
      return `${vmId}@${tag}`;
    });
  }

  async restore(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED" && cell.sm.state !== "STOPPED") {
        throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
      }
      cell.go("RESTORING", `restore ${tag}`);
      // V4: run failure must land in FAILED (never back in RUNNING) with an
      // audit note; a missing snapshot image maps to SNAPSHOT_NOT_FOUND.
      const ref = `${this.cname(cell)}:${tag}`;
      const harden = dockerRunHardening(cell.record.spec);
      try {
        const insp = await runCmd("docker", ["image", "inspect", ref], 30000);
        if (insp.code !== 0) throw new EveError("SNAPSHOT_NOT_FOUND", `Snapshot not found: ${tag}`);
        await runCmd("docker", ["rm", "-f", this.cname(cell)], 60000);
        await this.docker(["run", "-d", "--name", this.cname(cell),
          "--memory", `${cell.record.spec.memoryMb}m`,
          "--cpus", String(cell.record.spec.cpu),
          ...harden.args,
          ref,
        ], 120000);
      } catch (err) {
        failCell(cell, `restore failed: ${tag}: ${errMsg(err)}`);
        throw asMissingSnapshot(err, tag) ?? err;
      }
      cell.record.detail = harden.detail;
      cell.startedAtMs = Date.now();
      cell.go("RUNNING", "restore-complete");
      const id = `${vmId}@${tag}`;
      cell.note("restore", id);
      return id;
    });
  }

  async clone(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    const rec = await this.create(src.record.spec, newOwner);
    const dst = cellOrThrow(this.cells, rec.vmId);
    dst.note("clone", `from ${vmId} image=${this.imageFor(src.record.spec)}`);
    return dst.snapshotRecord();
  }

  async fork(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    // Source locked for the whole fork; clone/boot only lock the destination.
    return this.withCellLock(src, async () => {
      if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
      if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
      const rec = await this.clone(vmId, newOwner);
      src.note("fork", `forked to ${rec.vmId}`);
      await this.boot(rec.vmId);
      const dst = cellOrThrow(this.cells, rec.vmId);
      dst.note("fork", `forked from ${vmId}`);
      return dst.snapshotRecord();
    });
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      // V5: best-effort stop from ANY state; docker/shutdown transition errors
      // are swallowed so destroy always reaches DESTROYING -> DESTROYED.
      try { await runCmd("docker", ["stop", "-t", "5", this.cname(cell)], 30000); } catch { /* best effort */ }
      driveToDestroyable(cell, "destroy");
      cell.go("DESTROYING", "destroy-requested");
      await runCmd("docker", ["rm", "-f", this.cname(cell)], 60000);
      await fs.rm(cell.record.workdir, { recursive: true, force: true });
      cell.startedAtMs = null;
      cell.go("DESTROYED", "destroy-complete");
      this.cells.delete(vmId);
    });
  }

  async screendump(vmId: string): Promise<Buffer> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot screendump from ${cell.sm.state}`);
    }
    const name = this.cname(cell);
    // X display number varies by image (:0, :1, ...): discover it from
    // /tmp/.X11-unix rather than assuming. Both tools need a live X server,
    // which lags container start by seconds — retry to absorb guest boot
    // skew instead of failing a healthy-but-warming guest.
    const capture = "D=$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | sed 's/^X/:/'); D=${D:-:0}; " +
      "(command -v scrot >/dev/null && DISPLAY=$D scrot -o /tmp/eve-shot.png) || " +
      "(command -v import >/dev/null && DISPLAY=$D import -window root /tmp/eve-shot.png)";
    let lastErr = "";
    for (let attempt = 0; attempt < 15; attempt++) {
      if (attempt > 0) await sleep(2000);
      const shot = await runCmd("docker", ["exec", name, "sh", "-c", capture], 30000);
      if (shot.code === 0) {
        const local = join(cell.record.workdir, `screen-${Date.now()}.png`);
        await this.docker(["cp", `${name}:/tmp/eve-shot.png`, local]);
        const data = await fs.readFile(local);
        await fs.rm(local, { force: true });
        return data;
      }
      lastErr = shot.stderr || shot.stdout;
    }
    throw new EveError(
      "SCREENSHOT_FAILED",
      "Guest X server never became capturable (or image provides neither scrot nor ImageMagick import; " +
        "bake one into the guest image — see docs/vm-images.md). " +
        `Detail: ${lastErr}`,
    );
  }

  async exec(vmId: string, argv: readonly string[]): Promise<CmdResult> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot exec from ${cell.sm.state}`);
    const parsed = z.array(z.string().min(1).max(512)).min(1).max(16).parse([...argv]);
    return this.docker(["exec", this.cname(cell), ...parsed]);
  }

  async logs(vmId: string, tail = 100): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    const n = z.number().int().min(1).max(5000).parse(tail);
    const r = await this.docker(["logs", "--tail", String(n), this.cname(cell)]);
    return r.stdout + r.stderr;
  }

  async status(vmId: string): Promise<VmStatus> {
    const cell = cellOrThrow(this.cells, vmId);
    let containerState = "container-state=unknown";
    try {
      const r = await runCmd("docker", ["inspect", "--format", "{{.State.Status}} pid={{.State.Pid}}", this.cname(cell)], 15000);
      if (r.code === 0) containerState = r.stdout.trim();
    } catch { /* keep unknown */ }
    return VmStatusSchema.parse({
      vmId: cell.record.vmId,
      backend: this.backend,
      state: cell.sm.state,
      uptimeMs: cell.startedAtMs ? Date.now() - cell.startedAtMs : 0,
      detail: `${cell.record.detail || "isolation=unknown"}; ${containerState}`,
    });
  }

  auditLog(vmId: string): VmAuditEntry[] {
    return [...cellOrThrow(this.cells, vmId).audit];
  }
}

// ── DevFramebufferDriver (explicit fallback when no hypervisor exists) ───────

const DEV_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export class DevFramebufferDriver implements VmDriver {
  readonly backend = "dev-framebuffer";
  readonly note = "Development framebuffer: no hypervisor present; lifecycle transitions are enforced, screen is a 1x1 sentinel.";
  private readonly cells = new Map<string, VmCell>();
  private readonly locks = new Map<string, Promise<void>>();

  private withCellLock<T>(cell: VmCell, fn: () => Promise<T>): Promise<T> {
    return runWithCellLock(this.locks, cell.record.vmId, fn);
  }

  cellCountForTest(): number {
    return this.cells.size;
  }

  transitionForTest(vmId: string, to: VmStateT): void {
    cellOrThrow(this.cells, vmId).go(to, "test-hook");
  }

  async create(specInput: unknown, owner: string, _opts: CreateOpts = {}): Promise<VmRecord> {
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const vmId = uid("vm");
    const cell = new VmCell({ vmId, owner, backend: this.backend, spec, workdir: join(tmpdir(), "eve-x", "devfb", vmId) });
    await fs.mkdir(cell.record.workdir, { recursive: true });
    cell.note("create", this.note);
    cell.go("CREATED", "record-ready");
    this.cells.set(vmId, cell);
    return cell.snapshotRecord();
  }

  async boot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      // V6: FAILED retry re-enters the creation pipeline (via CREATED).
      if (cell.sm.state === "FAILED") {
        cell.go("CREATING", "boot-retry: failed-requeue");
        cell.go("CREATED", "boot-retry: recreated");
      }
      cell.go("BOOTING", "boot-requested");
      cell.startedAtMs = Date.now();
      cell.go("READY", "framebuffer-ready");
      cell.go("RUNNING", "boot-complete");
    });
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("STOPPING", "shutdown-requested");
      cell.startedAtMs = null;
      cell.go("STOPPED", "shutdown-complete");
    });
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      cell.go("PAUSING", "pause-requested");
      cell.go("PAUSED", "paused");
    });
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
      cell.go("RUNNING", "resumed");
    });
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
      cell.startedAtMs = Date.now();
      cell.note("reboot", "framebuffer-reset");
    });
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
        throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
      }
      // Snapshot ops never change state: failure is noted and rethrown with
      // the cell untouched.
      const id = `${vmId}@${tag}`;
      try {
        await fs.writeFile(join(cell.record.workdir, `${tag}.snap`), id, "utf8");
      } catch (err) {
        cell.note("snapshot-failed", `write ${tag}: ${errMsg(err)}`);
        throw err;
      }
      cell.note("snapshot", id);
      return id;
    });
  }

  async restore(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      const tag = validateSnapshotLabel(name);
      if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
        throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
      }
      cell.go("RESTORING", `restore ${tag}`);
      // V4: a missing snapshot file mapped to SNAPSHOT_NOT_FOUND (never a raw
      // ENOENT), any failure lands in FAILED with an audit note.
      try {
        await fs.readFile(join(cell.record.workdir, `${tag}.snap`), "utf8");
      } catch (err) {
        failCell(cell, `restore failed: ${tag}: ${errMsg(err)}`);
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT" || asMissingSnapshot(err, tag)) {
          throw new EveError("SNAPSHOT_NOT_FOUND", `Snapshot not found: ${tag}`);
        }
        throw err instanceof EveError ? err : new EveError("RESTORE_FAILED", `Restore failed: ${errMsg(err)}`);
      }
      cell.go("RUNNING", "restore-complete");
      const id = `${vmId}@${tag}`;
      cell.note("restore", id);
      return id;
    });
  }

  async clone(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    const rec = await this.create(src.record.spec, newOwner);
    const dst = cellOrThrow(this.cells, rec.vmId);
    dst.note("clone", `from ${vmId}`);
    return dst.snapshotRecord();
  }

  async fork(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    // Source locked for the whole fork; clone/boot only lock the destination.
    return this.withCellLock(src, async () => {
      if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
      if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
      const rec = await this.clone(vmId, newOwner);
      src.note("fork", `forked to ${rec.vmId}`);
      await this.boot(rec.vmId);
      const dst = cellOrThrow(this.cells, rec.vmId);
      dst.note("fork", `forked from ${vmId}`);
      return dst.snapshotRecord();
    });
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    return this.withCellLock(cell, async () => {
      // V5: tolerate any pre-DESTROYING state (e.g. RESTORING left behind by
      // a failed restore racing this call) via driveToDestroyable.
      cell.startedAtMs = null;
      await fs.rm(cell.record.workdir, { recursive: true, force: true });
      driveToDestroyable(cell, "destroy");
      cell.go("DESTROYING", "destroy-requested");
      cell.go("DESTROYED", "destroy-complete");
      this.cells.delete(vmId);
    });
  }

  async screendump(vmId: string): Promise<Buffer> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot screendump from ${cell.sm.state}`);
    }
    return Buffer.from(DEV_PNG_B64, "base64");
  }

  async status(vmId: string): Promise<VmStatus> {
    const cell = cellOrThrow(this.cells, vmId);
    return VmStatusSchema.parse({
      vmId: cell.record.vmId,
      backend: this.backend,
      state: cell.sm.state,
      uptimeMs: cell.startedAtMs ? Date.now() - cell.startedAtMs : 0,
      detail: this.note,
    });
  }

  auditLog(vmId: string): VmAuditEntry[] {
    return [...cellOrThrow(this.cells, vmId).audit];
  }
}

// ── Backend auto-select ──────────────────────────────────────────────────────

export interface BackendSelection {
  driver: VmDriver;
  backend: string;
  note: string;
}

export async function selectDriver(opts: QemuDriverOpts & DockerDriverOpts = {}): Promise<BackendSelection> {
  const env = (process.env["VM_BACKEND"] ?? "auto").toLowerCase();
  const qemu = new QemuDriver(opts);
  const docker = new DockerDesktopDriver(opts);
  const dev = new DevFramebufferDriver();
  if (env === "qemu") return { driver: qemu, backend: "qemu", note: "VM_BACKEND=qemu (explicit)" };
  if (env === "docker") return { driver: docker, backend: "docker", note: "VM_BACKEND=docker (explicit)" };
  if (env === "dev" || env === "dev-framebuffer" || env === "devfb") {
    return { driver: dev, backend: dev.backend, note: `VM_BACKEND=${env} (explicit): ${dev.note}` };
  }
  if (await hasBinary("qemu-system-x86_64")) {
    return { driver: qemu, backend: "qemu", note: "auto: qemu-system-x86_64 present" };
  }
  if (await hasBinary("docker")) {
    try {
      const info = await runCmd("docker", ["info"], 10000);
      if (info.code === 0) return { driver: docker, backend: "docker", note: "auto: docker daemon reachable" };
    } catch { /* fall through */ }
  }
  return { driver: dev, backend: dev.backend, note: `auto: no hypervisor found; ${dev.note}` };
}

// ── VmManager (multi-tenant registry, quotas, leases, single ownership) ─────

export const QuotaConfigSchema = z.object({
  maxVmsPerTenant: z.number().int().min(1).max(64).default(4),
  maxTotalVms: z.number().int().min(1).max(512).default(32),
  maxCpuPerTenant: z.number().int().min(1).max(256).default(16),
  maxMemMbPerTenant: z.number().int().min(512).max(524288).default(32768),
});
export type QuotaConfig = z.infer<typeof QuotaConfigSchema>;

interface RegistryEntry {
  owner: string;
  backend: string;
  spec: VmSpecT;
}

interface Lease {
  owner: string;
  expiresAtMs: number;
  ttlMs: number;
}

// V10: durable registry record. workdir/pid/booted exist so recover() can kill
// orphan QEMU children and decide which workdirs are safe to remove.
const PersistedLeaseSchema = z.object({
  owner: z.string(),
  expiresAtMs: z.number(),
  ttlMs: z.number(),
});
const PersistedEntrySchema = z.object({
  owner: z.string(),
  backend: z.string(),
  spec: VmSpec,
  workdir: z.string().default(""),
  pid: z.number().optional(),
  containerName: z.string().optional(),
  booted: z.boolean().default(false),
  display: z.number().int().optional(),
  ports: z.object({ vnc: z.number().int(), agent: z.number().int(), ssh: z.number().int() }).optional(),
  lease: PersistedLeaseSchema.optional(),
});
const PersistedFileSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), PersistedEntrySchema),
});
type PersistedEntry = z.infer<typeof PersistedEntrySchema>;

export interface RecoveryReport {
  recovered: number;
  orphansKilled: number;
  stale: string[];
}

export class VmManager {
  private readonly drivers = new Map<string, VmDriver>();
  private readonly primary: VmDriver;
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly leases = new Map<string, Lease>();
  private readonly persisted = new Map<string, PersistedEntry>();
  private readonly stale = new Set<string>();
  private readonly quotas: QuotaConfig;

  constructor(primary: VmDriver, extraDrivers: VmDriver[] = [], quotasInput: unknown = {}) {
    this.primary = primary;
    this.drivers.set(primary.backend, primary);
    for (const d of extraDrivers) this.drivers.set(d.backend, d);
    this.quotas = QuotaConfigSchema.parse(quotasInput ?? {});
  }

  private driverFor(vmId: string): { driver: VmDriver; entry: RegistryEntry } {
    const entry = this.registry.get(vmId);
    if (!entry) throw new EveError("VM_NOT_FOUND", `Unknown vm: ${vmId}`);
    const driver = this.drivers.get(entry.backend);
    if (!driver) throw new EveError("BACKEND_GONE", `Backend ${entry.backend} is not registered`);
    return { driver, entry };
  }

  private mustOwn(vmId: string, owner: string): { driver: VmDriver; entry: RegistryEntry } {
    const found = this.driverFor(vmId);
    if (found.entry.owner !== owner) {
      throw new EveError("NOT_OWNER", `vm ${vmId} is owned by another tenant; double ownership denied`);
    }
    return found;
  }

  // V10: registry + leases live in DATA_DIR/vm-registry.json, written atomically
  // (tmp + rename) on every mutation. Writes are best-effort: a persistence
  // failure must never fail the VM operation itself.
  private dataDir(): string {
    return process.env["DATA_DIR"] ?? "./data";
  }

  private registryPath(): string {
    return join(this.dataDir(), "vm-registry.json");
  }

  private async persist(): Promise<void> {
    try {
      const dir = this.dataDir();
      await fs.mkdir(dir, { recursive: true });
      const payload = { version: 1 as const, entries: Object.fromEntries(this.persisted) };
      const tmp = join(dir, `vm-registry.${process.pid}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
      await fs.rename(tmp, this.registryPath());
    } catch { /* in-memory registry remains the source of truth */ }
  }

  private trackPersisted(vmId: string, rec: VmRecord, owner: string, booted: boolean, display?: number): void {
    const lease = this.leases.get(vmId);
    const prev = this.persisted.get(vmId);
    this.persisted.set(vmId, {
      owner,
      backend: rec.backend,
      spec: rec.spec,
      workdir: rec.workdir,
      pid: rec.pid,
      containerName: rec.containerName,
      booted,
      display: display ?? prev?.display,
      ports: prev?.ports,
      lease: lease ? { owner: lease.owner, expiresAtMs: lease.expiresAtMs, ttlMs: lease.ttlMs } : undefined,
    });
  }

  private checkQuotas(owner: string, spec: VmSpecT): void {
    if (this.registry.size >= this.quotas.maxTotalVms) {
      throw new EveError("QUOTA_TOTAL", `Global VM quota reached (${this.quotas.maxTotalVms})`);
    }
    let count = 0;
    let cpu = 0;
    let mem = 0;
    for (const e of this.registry.values()) {
      if (e.owner !== owner) continue;
      count++;
      cpu += e.spec.cpu;
      mem += e.spec.memoryMb;
    }
    if (count + 1 > this.quotas.maxVmsPerTenant) {
      const staleMine = [...this.stale].filter((id) => this.registry.get(id)?.owner === owner).length;
      const hint = staleMine > 0 ? ` (${staleMine} stale; destroy stale VMs or raise EVEX_MAX_VMS_PER_TENANT)` : "";
      throw new EveError("QUOTA_COUNT", `Tenant VM quota reached (${this.quotas.maxVmsPerTenant})${hint}`);
    }
    if (cpu + spec.cpu > this.quotas.maxCpuPerTenant) {
      throw new EveError("QUOTA_CPU", `Tenant CPU quota exceeded (${this.quotas.maxCpuPerTenant})`);
    }
    if (mem + spec.memoryMb > this.quotas.maxMemMbPerTenant) {
      throw new EveError("QUOTA_MEM", `Tenant memory quota exceeded (${this.quotas.maxMemMbPerTenant})`);
    }
  }

  async create(owner: string, specInput: unknown, leaseTtlMs = 3600000, driverOpts: CreateOpts = {}): Promise<VmRecord> {
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const ttl = z.number().int().min(60000).max(86400000).parse(leaseTtlMs);
    // V8: parse the spec and enforce quotas BEFORE driver.create, so a denied
    // create never allocates a disk. Single-process scope: the registry only
    // mutates inside this method, so check-then-create is race-free here
    // (concurrent callers serialize on the event loop between these awaits).
    const spec = VmSpec.parse(specInput);
    this.checkQuotas(owner, spec);
    const rec = await this.primary.create(spec, owner, driverOpts);
    this.registry.set(rec.vmId, { owner, backend: this.primary.backend, spec: rec.spec });
    this.leases.set(rec.vmId, { owner, expiresAtMs: Date.now() + ttl, ttlMs: ttl });
    this.trackPersisted(rec.vmId, rec, owner, false);
    await this.persist();
    return rec;
  }

  heartbeat(vmId: string, owner: string, ttlMs?: number): number {
    const { entry } = this.mustOwn(vmId, owner);
    void entry;
    const lease = this.leases.get(vmId);
    if (!lease) throw new EveError("LEASE_GONE", `No lease for vm ${vmId}`);
    if (lease.owner !== owner) throw new EveError("NOT_OWNER", `Lease for ${vmId} belongs to another tenant`);
    const ttl = ttlMs === undefined ? lease.ttlMs : z.number().int().min(60000).max(86400000).parse(ttlMs);
    lease.ttlMs = ttl;
    lease.expiresAtMs = Date.now() + ttl;
    const persisted = this.persisted.get(vmId);
    if (persisted) persisted.lease = { owner: lease.owner, expiresAtMs: lease.expiresAtMs, ttlMs: lease.ttlMs };
    void this.persist();
    return lease.expiresAtMs;
  }

  async sweepExpired(nowMs: number = Date.now()): Promise<string[]> {
    const dead: string[] = [];
    for (const [vmId, lease] of this.leases) {
      if (lease.expiresAtMs > nowMs) continue;
      const entry = this.registry.get(vmId);
      const driver = entry ? this.drivers.get(entry.backend) : undefined;
      try { await driver?.destroy(vmId); } catch { /* best effort */ }
      this.registry.delete(vmId);
      this.leases.delete(vmId);
      this.persisted.delete(vmId);
      this.stale.delete(vmId);
      dead.push(vmId);
    }
    if (dead.length > 0) await this.persist();
    return dead;
  }

  listByOwner(owner: string): string[] {
    const out: string[] = [];
    for (const [vmId, e] of this.registry) if (e.owner === owner) out.push(vmId);
    return out;
  }

  ownerOf(vmId: string): string {
    return this.driverFor(vmId).entry.owner;
  }

  /** Backend name (qemu/docker/dev-framebuffer) for routing decisions. */
  backendOf(vmId: string): string {
    return this.driverFor(vmId).entry.backend;
  }

  /** Host VNC port for QEMU guests (throws UNSUPPORTED otherwise).
   *  NOTE: deliberately no persisted-ports fallback. After a restart the
   *  recorded ports may have been reused by an unrelated process; returning
   *  stale numbers could steer input into the wrong guest. Callers must go
   *  through withLiveDriver (QMP-proven reattach + claim restore) first. */
  vncPort(vmId: string, owner: string): number {
    const { driver } = this.mustOwn(vmId, owner);
    const q = driver as unknown as { vncPortFor?: (id: string) => number };
    if (typeof q.vncPortFor !== "function") throw new EveError("UNSUPPORTED", `Backend ${driver.backend} exposes no VNC port`);
    return q.vncPortFor(vmId);
  }

  /** Host forwarded port of the in-guest EVE agent (QEMU backend). Same
   *  no-fallback rule as vncPort: stale numbers must never steer traffic. */
  guestAgentPort(vmId: string, owner: string): number {
    const { driver } = this.mustOwn(vmId, owner);
    const q = driver as unknown as { guestAgentPort?: (id: string) => number };
    if (typeof q.guestAgentPort !== "function") throw new EveError("UNSUPPORTED", `Backend ${driver.backend} exposes no agent port`);
    return q.guestAgentPort(vmId);
  }

  isStale(vmId: string): boolean {
    return this.stale.has(vmId);
  }

  staleIds(): string[] {
    return [...this.stale];
  }

  // V10: reload registry+leases persisted by a previous process. A live
  // ChildProcess handle cannot cross a process boundary, so live re-attach is
  // explicitly unsupported: entries return as STALE metadata (visible via
  // isStale/staleIds, operable only after fresh boot/destroy), orphan QEMU
  // pids recorded in the file are SIGKILLed best-effort, and workdirs are
  // removed ONLY for entries whose disk was never booted.
  async recover(opts: { killOrphans?: boolean } = {}): Promise<RecoveryReport> {
    const killOrphans = opts.killOrphans ?? true;
    let parsed: z.infer<typeof PersistedFileSchema>;
    try {
      const raw = await fs.readFile(this.registryPath(), "utf8");
      parsed = PersistedFileSchema.parse(JSON.parse(raw) as unknown);
    } catch {
      return { recovered: 0, orphansKilled: 0, stale: [] };
    }
    let orphansKilled = 0;
    const stale: string[] = [];
    for (const [vmId, e] of Object.entries(parsed.entries)) {
      this.registry.set(vmId, { owner: e.owner, backend: e.backend, spec: e.spec });
      if (e.lease) {
        this.leases.set(vmId, { owner: e.lease.owner, expiresAtMs: e.lease.expiresAtMs, ttlMs: e.lease.ttlMs });
      }
      this.persisted.set(vmId, { ...e });
      this.stale.add(vmId);
      stale.push(vmId);
      // Display claims are NOT restored here: pid numbers can be recycled by
      // the OS, so a claim is only restored after the on-demand reattach
      // proves QMP liveness (see withLiveDriver). Dead entries simply boot
      // fresh with probed ports later.
      if (killOrphans && e.backend === "qemu" && typeof e.pid === "number") {
        try {
          process.kill(e.pid, 0);
          try { process.kill(e.pid, "SIGKILL"); orphansKilled += 1; } catch { /* already exiting */ }
        } catch { /* pid is not alive; nothing to reap */ }
      }
      if (!e.booted && e.workdir) {
        try { await fs.rm(e.workdir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
    await this.persist();
    return { recovered: stale.length, orphansKilled, stale };
  }

  async boot(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.boot(vmId);
    const persisted = this.persisted.get(vmId);
    if (persisted) {
      persisted.booted = true;
      try {
        const st = await driver.status(vmId);
        if (st.pid !== undefined) persisted.pid = st.pid;
      } catch { /* pid is best-effort metadata */ }
      try {
        const q = driver as unknown as {
          claimedDisplay?: (id: string) => number | null;
          guestAgentPort?: (id: string) => number;
          guestSshPort?: (id: string) => number;
          vncPortFor?: (id: string) => number;
        };
        const d = q.claimedDisplay?.(vmId);
        if (typeof d === "number") {
          persisted.display = d;
          try {
            persisted.ports = {
              vnc: Number(q.vncPortFor?.(vmId)),
              agent: Number(q.guestAgentPort?.(vmId)),
              ssh: Number(q.guestSshPort?.(vmId)),
            };
            if (![persisted.ports.vnc, persisted.ports.agent, persisted.ports.ssh].every(Number.isInteger)) {
              persisted.ports = undefined;
            }
          } catch { /* ports best-effort */ }
        }
      } catch { /* display is best-effort metadata */ }
      await this.persist();
    }
  }

  /**
   * Run a driver op, transparently reattaching stale post-restart entries.
   * After a control-plane restart the driver forgot its live cells while the
   * QEMU processes kept running; the persisted record (workdir + display)
   * plus a QMP liveness probe re-establishes control without disturbing the
   * guest. Probe failure fails closed (no hallucinated VMs).
   */
  private async withLiveDriver<T>(
    vmId: string,
    owner: string,
    op: (driver: VmDriver, entry: RegistryEntry) => Promise<T>,
  ): Promise<T> {
    const found = this.mustOwn(vmId, owner);
    try {
      return await op(found.driver, found.entry);
    } catch (err) {
      if (!(err instanceof EveError) || err.code !== "VM_NOT_FOUND") throw err;
      if (!this.stale.has(vmId)) throw err;
      const p = this.persisted.get(vmId);
      const qemu = found.driver as unknown as {
        reattach?: (id: string, o: string, spec: unknown, workdir: string, pid?: number) => Promise<unknown>;
        restoreDisplayClaim?: (id: string, d: number) => void;
      };
      if (!p?.workdir || typeof qemu.reattach !== "function") throw err;
      await qemu.reattach(vmId, owner, found.entry.spec, p.workdir, p.pid);
      if (typeof p.display === "number" && typeof qemu.restoreDisplayClaim === "function") {
        try {
          qemu.restoreDisplayClaim(vmId, p.display);
        } catch { /* ports re-probed on next boot; observe fails loudly meanwhile */ }
      }
      this.stale.delete(vmId);
      await this.persist();
      return op(found.driver, found.entry);
    }
  }

  async shutdown(vmId: string, owner: string): Promise<void> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.shutdown(vmId));
  }

  async pause(vmId: string, owner: string): Promise<void> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.pause(vmId));
  }

  async resume(vmId: string, owner: string): Promise<void> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.resume(vmId));
  }

  async reboot(vmId: string, owner: string): Promise<void> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.reboot(vmId));
  }

  async snapshot(vmId: string, owner: string, name: string): Promise<string> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.snapshot(vmId, name));
  }

  async restore(vmId: string, owner: string, name: string): Promise<string> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.restore(vmId, name));
  }

  async fork(vmId: string, owner: string, newOwner: string): Promise<VmRecord> {
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    // V9: newOwner === owner is allowed (same-tenant branch for
    // human-branching and counterfactual runs); mustOwn still guards source.
    return this.withLiveDriver(vmId, owner, async (driver, entry) => {
      const rec = await driver.fork(vmId, newOwner);
      const now = Date.now();
      const ttl = 3600000;
      this.registry.set(rec.vmId, { owner: newOwner, backend: entry.backend, spec: rec.spec });
      this.leases.set(rec.vmId, { owner: newOwner, expiresAtMs: now + ttl, ttlMs: ttl });
      this.trackPersisted(rec.vmId, rec, newOwner, true);
      await this.persist();
      return rec;
    });
  }

  async destroy(vmId: string, owner: string): Promise<void> {
    const { driver, entry } = this.mustOwn(vmId, owner);
    try {
      await driver.destroy(vmId);
    } catch (err) {
      if (!(err instanceof EveError) || err.code !== "VM_NOT_FOUND") throw err;
      // Post-restart stale entry: the driver never saw this VM in this
      // process (live handles cannot cross restarts), but the persisted
      // record has a workdir (+ recorded pid). Reap best-effort so destroy
      // stays idempotent instead of stranding the entry forever.
      const rec = this.persisted.get(vmId);
      const workdir = rec?.workdir;
      if (typeof entry.owner === "string" && workdir) {
        if (typeof rec?.pid === "number") {
          try {
            process.kill(rec.pid, 0);
            try { process.kill(rec.pid, "SIGKILL"); } catch { /* exiting */ }
          } catch { /* pid not alive */ }
        }
        try {
          await fs.rm(workdir, { recursive: true, force: true });
        } catch { /* best effort */ }
      } else {
        throw err;
      }
    }
    this.registry.delete(vmId);
    this.leases.delete(vmId);
    this.persisted.delete(vmId);
    this.stale.delete(vmId);
    await this.persist();
  }

  async screendump(vmId: string, owner: string): Promise<Buffer> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.screendump(vmId));
  }

  /** qemu-guest-agent exec (QEMU backend only; others throw UNSUPPORTED). */
  async guestExec(vmId: string, owner: string, argv: readonly string[]): Promise<{ pid: number }> {
    return this.withLiveDriver(vmId, owner, (driver) => {
      const q = driver as unknown as { guestExec?: (id: string, a: readonly string[]) => Promise<{ pid: number }> };
      if (typeof q.guestExec !== "function") throw new EveError("UNSUPPORTED", `Backend ${driver.backend} has no guest-exec channel`);
      return q.guestExec(vmId, argv);
    });
  }

  async guestExecSync(
    vmId: string,
    owner: string,
    argv: readonly string[],
    timeoutMs = 60000,
  ): Promise<{ exitcode: number; out: string; err: string }> {
    return this.withLiveDriver(vmId, owner, (driver) => {
      const q = driver as unknown as {
        guestExecSync?: (id: string, a: readonly string[], t?: number) => Promise<{ exitcode: number; out: string; err: string }>;
      };
      if (typeof q.guestExecSync !== "function") throw new EveError("UNSUPPORTED", `Backend ${driver.backend} has no guest-exec channel`);
      return q.guestExecSync(vmId, argv, timeoutMs);
    });
  }

  async status(vmId: string, owner: string): Promise<VmStatus> {
    return this.withLiveDriver(vmId, owner, (driver) => driver.status(vmId));
  }

  /** Driver audit trail for a VM (lifecycle transitions + reasons). */
  async auditLog(vmId: string, owner: string): Promise<Array<{ at: string; op: string; detail: string }>> {
    return this.withLiveDriver(vmId, owner, async (driver) => {
      const q = driver as unknown as { auditLog?: (id: string) => Array<{ at: string; op: string; detail: string }> };
      if (typeof q.auditLog !== "function") return [];
      return q.auditLog(vmId);
    });
  }
}
