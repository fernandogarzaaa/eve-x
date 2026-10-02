import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { EveError } from "../packages/core/src/index.js";
import {
  DevFramebufferDriver,
  DockerDesktopDriver,
  QemuDriver,
  QmpConnection,
  VmManager,
  parseGuestExecPid,
  portsForDisplay,
  validateDockerImage,
  validateSnapshotLabel,
} from "../packages/vm/src/index.js";

const OWNER = "tenant-a";
const OTHER = "tenant-b";

function tinySpec(): Record<string, unknown> {
  return { cpu: 1, memoryMb: 512, diskGb: 8 };
}

async function assertThrowsCode(fn: () => unknown, code: string): Promise<EveError> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof EveError, `expected EveError, got ${String(err)}`);
    assert.equal((err as EveError).code, code, `expected code ${code}, got ${(err as EveError).code}`);
    return err as EveError;
  }
  assert.fail(`expected throw with code ${code}`);
}

function freshManager(quotas: unknown = {}): { dev: DevFramebufferDriver; mgr: VmManager } {
  const dev = new DevFramebufferDriver();
  const mgr = new VmManager(dev, [], quotas);
  return { dev, mgr };
}

let dataDir = "";
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env["DATA_DIR"];
  dataDir = mkdtempSync(join(tmpdir(), "evex-vmtest-"));
  process.env["DATA_DIR"] = dataDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env["DATA_DIR"];
  else process.env["DATA_DIR"] = prevDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("vm lifecycle (hardened)", () => {
  it("rejects double boot and boot-during-RUNNING without mutating state", async () => {
    const dev = new DevFramebufferDriver();
    const rec = await dev.create(tinySpec(), OWNER);
    await dev.boot(rec.vmId);
    await assertThrowsCode(() => dev.boot(rec.vmId), "INVALID_TRANSITION");
    const st = await dev.status(rec.vmId);
    assert.equal(st.state, "RUNNING");
    await dev.destroy(rec.vmId);
  });

  it("destroy twice: second reports VM_NOT_FOUND", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await mgr.destroy(rec.vmId, OWNER);
    await assertThrowsCode(() => mgr.destroy(rec.vmId, OWNER), "VM_NOT_FOUND");
  });

  it("restore of a missing snapshot -> SNAPSHOT_NOT_FOUND and never RUNNING/READY", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await mgr.boot(rec.vmId, OWNER);
    await assertThrowsCode(() => mgr.restore(rec.vmId, OWNER, "ghost"), "SNAPSHOT_NOT_FOUND");
    const st = await mgr.status(rec.vmId, OWNER);
    assert.ok(st.state !== "RUNNING" && st.state !== "READY", `state must not be RUNNING/READY, got ${st.state}`);
    assert.equal(st.state, "FAILED");
    await mgr.destroy(rec.vmId, OWNER);
  });

  it("snapshot from STOPPED is rejected", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await mgr.boot(rec.vmId, OWNER);
    await mgr.shutdown(rec.vmId, OWNER);
    await assertThrowsCode(() => mgr.snapshot(rec.vmId, OWNER, "s1"), "INVALID_TRANSITION");
    await mgr.destroy(rec.vmId, OWNER);
  });

  it("fork from non-RUNNING is rejected", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await assertThrowsCode(() => mgr.fork(rec.vmId, OWNER, OTHER), "INVALID_TRANSITION");
    await mgr.destroy(rec.vmId, OWNER);
  });

  it("same-owner fork is allowed and registered", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await mgr.boot(rec.vmId, OWNER);
    const forked = await mgr.fork(rec.vmId, OWNER, OWNER);
    assert.notEqual(forked.vmId, rec.vmId);
    assert.equal(mgr.ownerOf(forked.vmId), OWNER);
    const ids = mgr.listByOwner(OWNER);
    assert.ok(ids.includes(rec.vmId) && ids.includes(forked.vmId));
    const st = await mgr.status(forked.vmId, OWNER);
    assert.equal(st.state, "RUNNING");
    await mgr.destroy(forked.vmId, OWNER);
    await mgr.destroy(rec.vmId, OWNER);
  });

  it("quota denial happens before driver.create (no cell allocated)", async () => {
    const { dev, mgr } = freshManager({ maxVmsPerTenant: 1 });
    const first = await mgr.create(OWNER, tinySpec());
    assert.equal(dev.cellCountForTest(), 1);
    await assertThrowsCode(() => mgr.create(OWNER, tinySpec()), "QUOTA_COUNT");
    assert.equal(dev.cellCountForTest(), 1);
    assert.deepEqual(mgr.listByOwner(OWNER), [first.vmId]);
    await mgr.destroy(first.vmId, OWNER);
  });

  it("illegal transition never mutates: FAILED stays FAILED", async () => {
    const dev = new DevFramebufferDriver();
    const rec = await dev.create(tinySpec(), OWNER);
    await dev.boot(rec.vmId);
    await assertThrowsCode(() => dev.restore(rec.vmId, "missing"), "SNAPSHOT_NOT_FOUND");
    assert.equal((await dev.status(rec.vmId)).state, "FAILED");
    await assertThrowsCode(() => dev.resume(rec.vmId), "INVALID_TRANSITION");
    await assertThrowsCode(() => dev.reboot(rec.vmId), "INVALID_TRANSITION");
    assert.equal((await dev.status(rec.vmId)).state, "FAILED");
    await dev.destroy(rec.vmId);
  });

  it("boot retry after FAILED re-enters via CREATING and reaches RUNNING", async () => {
    const dev = new DevFramebufferDriver();
    const rec = await dev.create(tinySpec(), OWNER);
    await dev.boot(rec.vmId);
    await assertThrowsCode(() => dev.restore(rec.vmId, "missing"), "SNAPSHOT_NOT_FOUND");
    assert.equal((await dev.status(rec.vmId)).state, "FAILED");
    await dev.boot(rec.vmId);
    assert.equal((await dev.status(rec.vmId)).state, "RUNNING");
    const trail = dev.auditLog(rec.vmId).map((e) => e.detail).join("\n");
    assert.ok(trail.includes("boot-retry: failed-requeue"));
    await dev.destroy(rec.vmId);
  });

  it("destroy tolerates a stuck RESTORING cell (in-flight op leftovers)", async () => {
    const dev = new DevFramebufferDriver();
    const rec = await dev.create(tinySpec(), OWNER);
    await dev.boot(rec.vmId);
    dev.transitionForTest(rec.vmId, "RESTORING");
    await dev.destroy(rec.vmId);
    await assertThrowsCode(() => dev.status(rec.vmId), "VM_NOT_FOUND");
  });

  it("sweepExpired destroys expired leases and reports them", async () => {
    const { dev, mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await mgr.boot(rec.vmId, OWNER);
    const dead = await mgr.sweepExpired(Date.now() + 7200000);
    assert.deepEqual(dead, [rec.vmId]);
    assert.deepEqual(mgr.listByOwner(OWNER), []);
    await assertThrowsCode(() => dev.status(rec.vmId), "VM_NOT_FOUND");
  });

  it("heartbeat from the wrong owner is rejected with NOT_OWNER", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    await assertThrowsCode(() => mgr.heartbeat(rec.vmId, OTHER), "NOT_OWNER");
    await mgr.destroy(rec.vmId, OWNER);
  });

  it("VNC display allocation is unique, bounded, and reusable", async () => {
    // Hermetic bases: production defaults (18080/22000) may be held by
    // out-of-band processes on a dev box; the probe must skip those.
    const q = new QemuDriver({ vncBase: 50, agentBase: 38080, sshBase: 42000 });
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const d = await q.allocateDisplay(`vm-${i}`);
      assert.ok(d >= 50 && d < 90, `display ${d} out of range`);
      assert.ok(!seen.has(d), `display ${d} allocated twice`);
      seen.add(d);
    }
    await assertThrowsCode(() => q.allocateDisplay("vm-overflow"), "NO_DISPLAY");
    q.releaseDisplay("vm-0");
    const reused = await q.allocateDisplay("vm-new");
    assert.ok(seen.has(reused), "freed display should be reusable");
  });

  it("display allocator skips ports held by out-of-band processes", async () => {
    const { createServer } = await import("node:net");
    // Squat the VNC port of display 50 so the allocator must skip it.
    const squat = createServer(() => undefined);
    await new Promise<void>((resolve) => squat.listen(5950, "127.0.0.1", resolve));
    try {
      const q = new QemuDriver({ vncBase: 50, agentBase: 38180, sshBase: 42180 });
      const d = await q.allocateDisplay("vm-skip");
      assert.notEqual(d, 50, "display with busy VNC port must be skipped, never stolen");
      assert.ok(d >= 51 && d < 90);
    } finally {
      await new Promise<void>((resolve) => squat.close(() => resolve()));
    }
  });

  it("display port triples are derived and disjoint per display", async () => {
    const a = portsForDisplay(10, 10);
    const b = portsForDisplay(10, 11);
    assert.deepEqual(a, { vnc: 5910, agent: 18080, ssh: 22000 });
    assert.deepEqual(b, { vnc: 5911, agent: 18081, ssh: 22001 });
    const all = [a.vnc, a.agent, a.ssh, b.vnc, b.agent, b.ssh];
    assert.equal(new Set(all).size, all.length, "port triples must not overlap");
  });

  it("snapshot labels and docker image names are validated", async () => {
    assert.equal(validateSnapshotLabel("good-tag_1"), "good-tag_1");
    assert.throws(() => validateSnapshotLabel(""));
    assert.throws(() => validateSnapshotLabel("x".repeat(65)));
    assert.throws(() => validateSnapshotLabel("-leading-dash"));
    assert.equal(validateDockerImage("dorowu/ubuntu-desktop-lxde-vnc:latest"), "dorowu/ubuntu-desktop-lxde-vnc:latest");
    await assertThrowsCode(() => validateDockerImage("evil image!!"), "BAD_IMAGE");
  });

  it("docker create rejects an illegal image without allocating", async () => {
    const dd = new DockerDesktopDriver();
    await assertThrowsCode(() => dd.create({ ...tinySpec(), image: "evil image!!" }, OWNER), "BAD_IMAGE");
    assert.equal(dd.cellCountForTest(), 0);
  });

  it("QMP framing: greeting plus two replies split across chunks resolve once each", async () => {
    const dir = process.platform === "win32" ? "" : mkdtempSync(join(tmpdir(), "evex-qmp-"));
    // Windows cannot listen(2) on a filesystem path; named pipes are the
    // local-socket equivalent there. node:net maps both to `path`.
    const sockPath = process.platform === "win32"
      ? `\\\\?\\pipe\\evex-qmp-${process.pid}-${Date.now()}`
      : join(dir, "qmp.sock");
    const server = createServer((conn: Socket) => {
      conn.write(`${JSON.stringify({ QMP: { version: {}, capabilities: [] } })}\n`);
      let acc = "";
      conn.on("data", (d: Buffer) => {
        acc += d.toString("utf8");
        let nl = acc.indexOf("\n");
        while (nl >= 0) {
          const line = acc.slice(0, nl);
          acc = acc.slice(nl + 1);
          if (line.trim().length > 0) {
            const msg = JSON.parse(line) as { execute: string; id: number };
            const payload = msg.execute === "qmp_capabilities"
              ? `${JSON.stringify({ return: {}, id: msg.id })}\n`
              : `${JSON.stringify({ return: { echo: msg.execute }, id: msg.id })}\n`;
            // Split every reply across two chunks: proves reassembly works and
            // that no byte is buffered twice (duplication would corrupt JSON).
            const mid = Math.floor(payload.length / 2);
            conn.write(payload.slice(0, mid));
            setImmediate(() => conn.write(payload.slice(mid)));
          }
          nl = acc.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const qmp = new QmpConnection();
    try {
      await qmp.connect(sockPath, 5000);
      const [a, b] = await Promise.all([qmp.command("query-status"), qmp.command("query-version")]);
      assert.deepEqual((a["return"] as { echo: string }).echo, "query-status");
      assert.deepEqual((b["return"] as { echo: string }).echo, "query-version");
    } finally {
      qmp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guest-exec parsers honor the real QMP {return:{...}} envelope", async () => {
    // Real QEMU shape: payload nested under "return".
    assert.equal(parseGuestExecPid({ return: { pid: 7 }, id: 3 }), 7);
    // Bare-payload shape (the old bug) must fail closed, not yield undefined.
    await assertThrowsCode(() => parseGuestExecPid({ pid: 7 }), "QGA_ABSENT");
    await assertThrowsCode(() => parseGuestExecPid({ return: {} }), "QGA_ABSENT");
  });

  it("QGA channel: greeting without capabilities + guest-sync + guest-exec round-trip", async () => {
    const dir = process.platform === "win32" ? "" : mkdtempSync(join(tmpdir(), "evex-qga-"));
    const sockPath = process.platform === "win32"
      ? `\\\\?\\pipe\\evex-qga-${process.pid}-${Date.now()}`
      : join(dir, "qga.sock");
    const server = createServer((conn: Socket) => {
      // qemu-guest-agent style: NO greeting (the agent stays silent until
      // spoken to) and no capabilities handshake. The client must initiate
      // with guest-sync — a greeting-waiting client would hang here.
      let acc = "";
      conn.on("data", (d: Buffer) => {
        acc += d.toString("utf8");
        let nl = acc.indexOf("\n");
        while (nl >= 0) {
          const line = acc.slice(0, nl);
          acc = acc.slice(nl + 1);
          if (line.trim().length > 0) {
            const msg = JSON.parse(line) as { execute: string; id: number; arguments?: Record<string, unknown> };
            let ret: unknown = {};
            if (msg.execute === "guest-sync") ret = (msg.arguments as { id: number }).id;
            else if (msg.execute === "guest-exec") ret = { pid: 7 };
            else if (msg.execute === "guest-exec-status") {
              ret = { exited: true, exitcode: 0, "out-data": Buffer.from("eve-qual-01\n", "utf8").toString("base64") };
            }
            conn.write(`${JSON.stringify({ return: ret, id: msg.id })}\n`);
          }
          nl = acc.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(sockPath, resolve));
    const qmp = new QmpConnection();
    try {
      // capabilities must NOT be required on the QGA channel.
      await qmp.connectQga(sockPath, 5000);
      const ex = await qmp.command("guest-exec", { path: "/bin/hostname", arg: [], "capture-output": true });
      assert.equal(parseGuestExecPid(ex), 7);
      const st = await qmp.command("guest-exec-status", { pid: 7 });
      const out64 = ((st["return"] ?? {}) as Record<string, unknown>)["out-data"];
      assert.equal(typeof out64 === "string" ? Buffer.from(out64, "base64").toString("utf8") : "", "eve-qual-01\n");
    } finally {
      qmp.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registry persistence round-trips and recover() reports shape", async () => {
    const { mgr } = freshManager();
    const rec = await mgr.create(OWNER, tinySpec());
    const raw = await readFile(join(dataDir, "vm-registry.json"), "utf8");
    assert.ok(raw.includes(rec.vmId), "registry file must contain the new vm");
    const mgr2 = new VmManager(new DevFramebufferDriver());
    const report = await mgr2.recover();
    assert.equal(typeof report.recovered, "number");
    assert.equal(typeof report.orphansKilled, "number");
    assert.ok(Array.isArray(report.stale));
    assert.equal(report.recovered, 1);
    assert.equal(report.orphansKilled, 0);
    assert.deepEqual(report.stale, [rec.vmId]);
    assert.deepEqual(mgr2.staleIds(), [rec.vmId]);
    assert.ok(mgr2.isStale(rec.vmId));
    // Recover is idempotent: the file still lists the entry, so a second
    // manager recovers the same stale record rather than erroring.
    const again = await new VmManager(new DevFramebufferDriver()).recover();
    assert.deepEqual(again, { recovered: 1, orphansKilled: 0, stale: [rec.vmId] });
    await mgr.destroy(rec.vmId, OWNER);
  });
});
