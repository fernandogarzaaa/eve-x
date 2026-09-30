import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { promises as fs } from "node:fs";
import { join } from "node:path";
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
  create(specInput: unknown, owner: string): Promise<VmRecord>;
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class QmpConnection {
  private sock: Socket | null = null;
  private buf = "";
  private pending = new Map<number, { resolve: (v: QmpResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  connect(sockPath: string, timeoutMs = 15000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock: Socket = createConnection({ path: sockPath });
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        sock.destroy();
        reject(new EveError("QMP_TIMEOUT", `QMP connect timed out: ${sockPath}`));
      }, timeoutMs);
      let greeted = false;
      let done = false;
      const finish = (fn: () => void): void => {
        if (!done) { done = true; clearTimeout(timer); fn(); }
      };
      sock.on("error", (err: Error) => {
        finish(() => reject(new EveError("QMP_CONNECT", `QMP socket error: ${err.message}`)));
      });
      sock.on("data", (chunk: Buffer) => {
        this.buf += chunk.toString("utf8");
        if (!greeted) {
          const nl = this.buf.indexOf("\n");
          if (nl < 0) return;
          const line = this.buf.slice(0, nl);
          this.buf = this.buf.slice(nl + 1);
          if (!line.includes("\"QMP\"")) {
            finish(() => reject(new EveError("QMP_GREETING", "Unexpected QMP greeting")));
            sock.destroy();
            return;
          }
          greeted = true;
          this.sock = sock;
          sock.on("data", (c: Buffer) => {
            this.buf += c.toString("utf8");
            this.pump();
          });
          sock.on("error", (err: Error) => this.failAll(err));
          // negotiate capabilities, then resolve
          this.commandRaw("qmp_capabilities").then(
            () => finish(() => resolve()),
            (err: Error) => finish(() => reject(err)),
          );
          return;
        }
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

  private commandRaw(execute: string, args?: Record<string, unknown>): Promise<QmpResponse> {
    const sock = this.sock;
    if (!sock || sock.destroyed) return Promise.reject(new EveError("QMP_CLOSED", "QMP socket is closed"));
    const id = this.nextId++;
    const payload: Record<string, unknown> = args ? { execute, arguments: args, id } : { execute, id };
    return new Promise<QmpResponse>((resolve, reject) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
        this.pending.delete(id);
        reject(new EveError("QMP_TIMEOUT", `QMP command timed out: ${execute}`));
      }, 10000);
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

  command(execute: string, args?: Record<string, unknown>): Promise<QmpResponse> {
    return this.commandRaw(execute, args);
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
}

export class VmCell {
  readonly record: VmRecord;
  readonly sm: StateMachine<VmStateT>;
  proc: ChildProcess | null = null;
  qmp: QmpConnection | null = null;
  startedAtMs: number | null = null;
  readonly audit: VmAuditEntry[] = [];

  constructor(init: CellInit) {
    this.sm = new StateMachine<VmStateT>("CREATING", TRANSITIONS);
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
  }

  go(to: VmStateT, reason: string): void {
    this.sm.transition(to, reason);
    this.record.state = this.sm.state;
    this.note("transition", `${reason} -> ${to}`);
  }

  note(op: string, detail: string): void {
    this.audit.push({ at: nowIso(), op, detail });
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
}

export class QemuDriver implements VmDriver {
  readonly backend = "qemu";
  private readonly cells = new Map<string, VmCell>();
  private readonly imagesDir: string;
  private readonly vncBase: number;

  constructor(opts: QemuDriverOpts = {}) {
    this.imagesDir = opts.imagesDir ?? join(tmpdir(), "eve-x", "images");
    this.vncBase = opts.vncBase ?? 10;
  }

  private qcow2(cell: VmCell): string {
    return join(cell.record.workdir, "disk.qcow2");
  }

  private qmpPath(cell: VmCell): string {
    return join(cell.record.workdir, "qmp.sock");
  }

  async create(specInput: unknown, owner: string): Promise<VmRecord> {
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const vmId = uid("vm");
    const workdir = join(this.imagesDir, vmId);
    await fs.mkdir(workdir, { recursive: true });
    const cell = new VmCell({ vmId, owner, backend: this.backend, spec, workdir });
    const img = await runCmd("qemu-img", ["create", "-f", "qcow2", this.qcow2(cell), `${spec.diskGb}G`], 60000);
    if (img.code !== 0) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new EveError("QEMU_IMAGE_FAILED", `qemu-img failed: ${img.stderr || img.stdout}`);
    }
    cell.note("create", `qcow2 ${spec.diskGb}G cpu=${spec.cpu} mem=${spec.memoryMb}Mb`);
    cell.go("CREATED", "image-ready");
    this.cells.set(vmId, cell);
    return cell.snapshotRecord();
  }

  async boot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("BOOTING", "boot-requested");
    const spec = cell.record.spec;
    const qmpSock = this.qmpPath(cell);
    const display = this.vncBase + (Math.abs(hashStr(vmId)) % 40);
    const args: string[] = [
      "-m", String(spec.memoryMb),
      "-smp", String(spec.cpu),
      "-drive", `file=${this.qcow2(cell)},format=qcow2,if=virtio`,
      "-qmp", `unix:${qmpSock},server=on,wait=off`,
      "-display", "none",
      "-vnc", `127.0.0.1:${display}`,
      "-k", "en-us",
      "-rtc", "base=utc",
    ];
    if (spec.network === "none") {
      args.push("-net", "none");
    } else {
      args.push("-netdev", "user,id=net0", "-device", "virtio-net-pci,netdev=net0");
    }
    let proc: ChildProcess;
    try {
      proc = spawn("qemu-system-x86_64", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      cell.go("FAILED", `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new EveError("QEMU_SPAWN", "qemu-system-x86_64 spawn failed");
    }
    cell.proc = proc;
    cell.record.pid = proc.pid;
    proc.stdout?.on("data", () => undefined);
    proc.stderr?.on("data", () => undefined);
    proc.on("error", () => {
      try { cell.go("FAILED", "qemu process error"); } catch { /* terminal */ }
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
      cell.go("FAILED", "qmp-handshake-failed");
      throw new EveError("QMP_HANDSHAKE", "QEMU started but QMP handshake failed");
    }
    cell.qmp = qmp;
    cell.startedAtMs = Date.now();
    cell.note("boot", `pid=${proc.pid ?? -1} vnc=127.0.0.1:${display} qmp=${qmpSock}`);
    cell.go("READY", "qmp-handshake-ok");
    cell.go("RUNNING", "boot-complete");
  }

  private async qmpOf(cell: VmCell): Promise<QmpConnection> {
    const q = cell.qmp;
    if (!q) throw new EveError("QMP_CLOSED", `No QMP channel for ${cell.record.vmId}`);
    return q;
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("STOPPING", "shutdown-requested");
    try {
      const q = await this.qmpOf(cell);
      if (cell.sm.state === "STOPPING" && cell.record.state === "STOPPING") {
        // best-effort graceful powerdown (PAUSED vms need cont first)
        try { await q.command("cont"); } catch { /* maybe already running */ }
        await q.command("system_powerdown");
      }
    } catch { /* fall through to SIGTERM */ }
    if (cell.proc) {
      try { cell.proc.kill("SIGTERM"); } catch { /* gone */ }
      await waitExit(cell.proc, 8000);
      cell.proc = null;
    }
    cell.qmp?.close();
    cell.qmp = null;
    cell.startedAtMs = null;
    cell.go("STOPPED", "shutdown-complete");
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("PAUSING", "pause-requested");
    const q = await this.qmpOf(cell);
    await q.command("stop");
    cell.go("PAUSED", "qmp-stop-ok");
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
    const q = await this.qmpOf(cell);
    await q.command("cont");
    cell.go("RUNNING", "qmp-cont-ok");
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
    const q = await this.qmpOf(cell);
    await q.command("system_reset");
    cell.note("reboot", "qmp-system_reset-ok");
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
    const q = await this.qmpOf(cell);
    await q.command("human-monitor-command", { "command-line": `savevm ${tag}` });
    const id = `${vmId}@${tag}`;
    cell.note("snapshot", id);
    return id;
  }

  async restore(vmId: string, name: string): Promise<string> {
    void 0;
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state === "PAUSED") {
      const q = await this.qmpOf(cell);
      cell.go("RESTORING", `restore ${tag}`);
      await q.command("human-monitor-command", { "command-line": `loadvm ${tag}` });
      await q.command("cont");
      cell.go("RUNNING", "restore-complete");
    } else if (cell.sm.state === "RUNNING") {
      const q = await this.qmpOf(cell);
      cell.go("RESTORING", `restore ${tag}`);
      await q.command("human-monitor-command", { "command-line": `loadvm ${tag}` });
      cell.go("RUNNING", "restore-complete");
    } else {
      throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
    }
    const id = `${vmId}@${tag}`;
    cell.note("restore", id);
    return id;
  }

  async clone(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    const dstId = uid("vm");
    const workdir = join(this.imagesDir, dstId);
    await fs.mkdir(workdir, { recursive: true });
    const dst = new VmCell({ vmId: dstId, owner: newOwner, backend: this.backend, spec: src.record.spec, workdir });
    const cp = await runCmd("qemu-img", ["convert", "-O", "qcow2", this.qcow2(src), this.qcow2(dst)], 120000);
    if (cp.code !== 0) {
      await fs.rm(workdir, { recursive: true, force: true });
      throw new EveError("QEMU_CLONE_FAILED", `qemu-img convert failed: ${cp.stderr || cp.stdout}`);
    }
    dst.note("clone", `from ${vmId}`);
    dst.go("CREATED", "clone-ready");
    this.cells.set(dstId, dst);
    return dst.snapshotRecord();
  }

  async fork(vmId: string, newOwner: string): Promise<VmRecord> {
    const src = cellOrThrow(this.cells, vmId);
    if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
    // QEMU fork = clone the disk image, then boot the copy independently.
    const rec = await this.clone(vmId, newOwner);
    const dst = cellOrThrow(this.cells, rec.vmId);
    dst.go("BOOTING", "fork-boot");
    // fork goes through the normal boot path but keeps FORKING visible in audit
    dst.note("fork", `forked from ${vmId}`);
    dst.sm.transition("CREATED", "fork-rebase");
    dst.record.state = dst.sm.state;
    await this.boot(dst.record.vmId);
    return dst.snapshotRecord();
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    const st = cell.sm.state;
    if (st === "RUNNING" || st === "PAUSED" || st === "READY" || st === "PAUSING") {
      await this.shutdown(vmId);
    }
    cell.go("DESTROYING", "destroy-requested");
    if (cell.proc) {
      try { cell.proc.kill("SIGKILL"); } catch { /* gone */ }
      cell.proc = null;
    }
    cell.qmp?.close();
    cell.qmp = null;
    await fs.rm(cell.record.workdir, { recursive: true, force: true });
    cell.go("DESTROYED", "destroy-complete");
    this.cells.delete(vmId);
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

  auditLog(vmId: string): VmAuditEntry[] {
    return [...cellOrThrow(this.cells, vmId).audit];
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ── DockerDesktopDriver (real docker CLI: run/start/stop/commit/cp/exec/logs) ─

const DEFAULT_DOCKER_IMAGE = "dorowu/ubuntu-desktop-lxde-vnc:latest";

export interface DockerDriverOpts {
  workdirBase?: string;
  defaultImage?: string;
}

export class DockerDesktopDriver implements VmDriver {
  readonly backend = "docker";
  private readonly cells = new Map<string, VmCell>();
  private readonly base: string;
  private readonly defaultImage: string;

  constructor(opts: DockerDriverOpts = {}) {
    this.base = opts.workdirBase ?? join(tmpdir(), "eve-x", "docker");
    this.defaultImage = opts.defaultImage ?? DEFAULT_DOCKER_IMAGE;
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

  async create(specInput: unknown, owner: string): Promise<VmRecord> {
    const spec = VmSpec.parse(specInput);
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
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
    cell.go("BOOTING", "boot-requested");
    const spec = cell.record.spec;
    const name = this.cname(cell);
    // reuse an existing stopped container when present, else run a fresh xfce+x11vnc guest
    const inspect = await runCmd("docker", ["inspect", name], 15000);
    if (inspect.code === 0) {
      await this.docker(["start", name]);
    } else {
      const args = [
        "run", "-d", "--name", name,
        "--memory", `${spec.memoryMb}m`,
        "--cpus", String(spec.cpu),
        "-e", `VNC_RESOLUTION=${spec.width}x${spec.height}`,
        "-e", `TZ=${spec.timezone}`,
        this.imageFor(spec),
      ];
      await this.docker(args, 120000);
    }
    cell.startedAtMs = Date.now();
    cell.note("boot", `container=${name} image=${this.imageFor(spec)}`);
    cell.go("READY", "container-running");
    cell.go("RUNNING", "boot-complete");
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("STOPPING", "shutdown-requested");
    await this.docker(["stop", "-t", "10", this.cname(cell)], 60000);
    cell.startedAtMs = null;
    cell.go("STOPPED", "container-stopped");
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("PAUSING", "pause-requested");
    await this.docker(["pause", this.cname(cell)]);
    cell.go("PAUSED", "container-paused");
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
    await this.docker(["unpause", this.cname(cell)]);
    cell.go("RUNNING", "container-unpaused");
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
    await this.docker(["restart", "-t", "10", this.cname(cell)], 90000);
    cell.startedAtMs = Date.now();
    cell.note("reboot", "container-restarted");
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
    }
    const ref = `${this.cname(cell)}:${tag}`;
    await this.docker(["commit", "-p", this.cname(cell), ref], 120000);
    cell.note("snapshot", ref);
    return `${vmId}@${tag}`;
  }

  async restore(vmId: string, name: string): Promise<string> {
    void 0;
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED" && cell.sm.state !== "STOPPED") {
      throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
    }
    cell.go("RESTORING", `restore ${tag}`);
    const ref = `${this.cname(cell)}:${tag}`;
    await runCmd("docker", ["rm", "-f", this.cname(cell)], 60000);
    await this.docker(["run", "-d", "--name", this.cname(cell), ref], 120000);
    cell.startedAtMs = Date.now();
    cell.go("RUNNING", "restore-complete");
    const id = `${vmId}@${tag}`;
    cell.note("restore", id);
    return id;
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
    if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
    const rec = await this.clone(vmId, newOwner);
    await this.boot(rec.vmId);
    const dst = cellOrThrow(this.cells, rec.vmId);
    dst.note("fork", `forked from ${vmId}`);
    return dst.snapshotRecord();
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    const st = cell.sm.state;
    if (st === "RUNNING" || st === "PAUSED" || st === "READY" || st === "PAUSING") {
      await this.shutdown(vmId);
    }
    cell.go("DESTROYING", "destroy-requested");
    await runCmd("docker", ["rm", "-f", this.cname(cell)], 60000);
    await fs.rm(cell.record.workdir, { recursive: true, force: true });
    cell.go("DESTROYED", "destroy-complete");
    this.cells.delete(vmId);
  }

  async screendump(vmId: string): Promise<Buffer> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot screendump from ${cell.sm.state}`);
    }
    const name = this.cname(cell);
    const shot = await runCmd("docker", ["exec", name, "sh", "-c",
      "command -v scrot >/dev/null && scrot -o /tmp/eve-shot.png || (command -v import >/dev/null && DISPLAY=:0 import -window root /tmp/eve-shot.png)"], 30000);
    if (shot.code !== 0) throw new EveError("SCREENSHOT_FAILED", `Guest screenshot tool failed: ${shot.stderr || shot.stdout}`);
    const local = join(cell.record.workdir, `screen-${Date.now()}.png`);
    await this.docker(["cp", `${name}:/tmp/eve-shot.png`, local]);
    const data = await fs.readFile(local);
    await fs.rm(local, { force: true });
    return data;
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
    let detail = "container-state=unknown";
    try {
      const r = await runCmd("docker", ["inspect", "--format", "{{.State.Status}} pid={{.State.Pid}}", this.cname(cell)], 15000);
      if (r.code === 0) detail = r.stdout.trim();
    } catch { /* keep unknown */ }
    return VmStatusSchema.parse({
      vmId: cell.record.vmId,
      backend: this.backend,
      state: cell.sm.state,
      uptimeMs: cell.startedAtMs ? Date.now() - cell.startedAtMs : 0,
      detail,
    });
  }
}

// ── DevFramebufferDriver (explicit fallback when no hypervisor exists) ───────

const DEV_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export class DevFramebufferDriver implements VmDriver {
  readonly backend = "dev-framebuffer";
  readonly note = "Development framebuffer: no hypervisor present; lifecycle transitions are enforced, screen is a 1x1 sentinel.";
  private readonly cells = new Map<string, VmCell>();

  async create(specInput: unknown, owner: string): Promise<VmRecord> {
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
    cell.go("BOOTING", "boot-requested");
    cell.startedAtMs = Date.now();
    cell.go("READY", "framebuffer-ready");
    cell.go("RUNNING", "boot-complete");
  }

  async shutdown(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("STOPPING", "shutdown-requested");
    cell.startedAtMs = null;
    cell.go("STOPPED", "shutdown-complete");
  }

  async pause(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    cell.go("PAUSING", "pause-requested");
    cell.go("PAUSED", "paused");
  }

  async resume(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "PAUSED") throw new EveError("INVALID_TRANSITION", `Cannot resume from ${cell.sm.state}`);
    cell.go("RUNNING", "resumed");
  }

  async reboot(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    if (cell.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot reboot from ${cell.sm.state}`);
    cell.startedAtMs = Date.now();
    cell.note("reboot", "framebuffer-reset");
  }

  async snapshot(vmId: string, name: string): Promise<string> {
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot snapshot from ${cell.sm.state}`);
    }
    const id = `${vmId}@${tag}`;
    await fs.writeFile(join(cell.record.workdir, `${tag}.snap`), id, "utf8");
    cell.note("snapshot", id);
    return id;
  }

  async restore(vmId: string, name: string): Promise<string> {
    void 0;
    const cell = cellOrThrow(this.cells, vmId);
    const tag = SnapshotName.parse(name);
    if (cell.sm.state !== "RUNNING" && cell.sm.state !== "PAUSED") {
      throw new EveError("INVALID_TRANSITION", `Cannot restore from ${cell.sm.state}`);
    }
    cell.go("RESTORING", `restore ${tag}`);
    await fs.readFile(join(cell.record.workdir, `${tag}.snap`), "utf8");
    cell.go("RUNNING", "restore-complete");
    const id = `${vmId}@${tag}`;
    cell.note("restore", id);
    return id;
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
    if (src.sm.state !== "RUNNING") throw new EveError("INVALID_TRANSITION", `Cannot fork from ${src.sm.state}`);
    const rec = await this.clone(vmId, newOwner);
    await this.boot(rec.vmId);
    const dst = cellOrThrow(this.cells, rec.vmId);
    dst.note("fork", `forked from ${vmId}`);
    return dst.snapshotRecord();
  }

  async destroy(vmId: string): Promise<void> {
    const cell = cellOrThrow(this.cells, vmId);
    const st = cell.sm.state;
    if (st === "RUNNING" || st === "PAUSED" || st === "READY" || st === "PAUSING") {
      await this.shutdown(vmId);
    }
    cell.go("DESTROYING", "destroy-requested");
    await fs.rm(cell.record.workdir, { recursive: true, force: true });
    cell.go("DESTROYED", "destroy-complete");
    this.cells.delete(vmId);
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

export class VmManager {
  private readonly drivers = new Map<string, VmDriver>();
  private readonly primary: VmDriver;
  private readonly registry = new Map<string, RegistryEntry>();
  private readonly leases = new Map<string, Lease>();
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
      throw new EveError("QUOTA_COUNT", `Tenant VM quota reached (${this.quotas.maxVmsPerTenant})`);
    }
    if (cpu + spec.cpu > this.quotas.maxCpuPerTenant) {
      throw new EveError("QUOTA_CPU", `Tenant CPU quota exceeded (${this.quotas.maxCpuPerTenant})`);
    }
    if (mem + spec.memoryMb > this.quotas.maxMemMbPerTenant) {
      throw new EveError("QUOTA_MEM", `Tenant memory quota exceeded (${this.quotas.maxMemMbPerTenant})`);
    }
  }

  async create(owner: string, specInput: unknown, leaseTtlMs = 3600000): Promise<VmRecord> {
    if (!owner) throw new EveError("BAD_OWNER", "Owner is required");
    const ttl = z.number().int().min(60000).max(86400000).parse(leaseTtlMs);
    const rec = await this.primary.create(specInput, owner);
    try {
      this.checkQuotas(owner, rec.spec);
    } catch (err) {
      await this.primary.destroy(rec.vmId).catch(() => undefined);
      throw err;
    }
    this.registry.set(rec.vmId, { owner, backend: this.primary.backend, spec: rec.spec });
    this.leases.set(rec.vmId, { owner, expiresAtMs: Date.now() + ttl, ttlMs: ttl });
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
      dead.push(vmId);
    }
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

  async boot(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.boot(vmId);
  }

  async shutdown(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.shutdown(vmId);
  }

  async pause(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.pause(vmId);
  }

  async resume(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.resume(vmId);
  }

  async reboot(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.reboot(vmId);
  }

  async snapshot(vmId: string, owner: string, name: string): Promise<string> {
    const { driver } = this.mustOwn(vmId, owner);
    return driver.snapshot(vmId, name);
  }

  async restore(vmId: string, owner: string, name: string): Promise<string> {
    const { driver } = this.mustOwn(vmId, owner);
    return driver.restore(vmId, name);
  }

  async fork(vmId: string, owner: string, newOwner: string): Promise<VmRecord> {
    const { driver, entry } = this.mustOwn(vmId, owner);
    if (!newOwner) throw new EveError("BAD_OWNER", "Owner is required");
    if (newOwner === owner) throw new EveError("BAD_OWNER", "Fork target must be a different tenant");
    const rec = await driver.fork(vmId, newOwner);
    this.registry.set(rec.vmId, { owner: newOwner, backend: entry.backend, spec: rec.spec });
    this.leases.set(rec.vmId, { owner: newOwner, expiresAtMs: Date.now() + 3600000, ttlMs: 3600000 });
    return rec;
  }

  async destroy(vmId: string, owner: string): Promise<void> {
    const { driver } = this.mustOwn(vmId, owner);
    await driver.destroy(vmId);
    this.registry.delete(vmId);
    this.leases.delete(vmId);
  }

  async screendump(vmId: string, owner: string): Promise<Buffer> {
    const { driver } = this.mustOwn(vmId, owner);
    return driver.screendump(vmId);
  }

  async status(vmId: string, owner: string): Promise<VmStatus> {
    const { driver } = this.mustOwn(vmId, owner);
    return driver.status(vmId);
  }
}
