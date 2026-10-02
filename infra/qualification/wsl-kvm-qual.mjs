#!/usr/bin/env node
// EVE-X real-KVM qualification runner (runs inside a KVM-capable Linux host).
// Drives the ACTUAL compiled QemuDriver: overlay create, seed, boot, QMP,
// screendump, savevm/loadvm with guest-filesystem proof, lifecycle + races.
// Evidence: artifacts/qualification/wsl-kvm-qual.json + console transcript.
// Usage: IMGDIR=/var/lib/eve-images node wsl-kvm-qual.mjs [--phase=N] [--base-img=path]
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Portable paths: repo root is two levels above this script; everything else
// honors env overrides so any Linux host (not just WSL2) can qualify.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const { QemuDriver, backingDigest } = await import(join(REPO_ROOT, "dist", "packages", "vm", "src", "index.js"));
const IMGDIR = process.env.IMGDIR ?? "/var/lib/eve-images/qual";
const BASE_SRC = process.env.BASE_SRC ?? "/var/lib/eve-images/noble-minimal.img";
const ARTDIR = process.env.ARTDIR ?? join(REPO_ROOT, "artifacts", "qualification");
const PHASE = process.env.PHASE ?? "all"; // "boot" | "guest" | "all"
const VMFILE = join(ARTDIR, "qual-vmid.txt");
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);

const evidence = { at: new Date().toISOString(), host: {}, phases: [] };
const rec = (name, ok, detail) => {
  evidence.phases.push({ name, ok, detail, at: new Date().toISOString() });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${typeof detail === "string" ? detail.slice(0, 300) : JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) {
    flush();
    process.exitCode = 1;
    throw new Error(`phase failed: ${name}`);
  }
};
const flush = () => {
  mkdirSync(ARTDIR, { recursive: true });
  writeFileSync(join(ARTDIR, "wsl-kvm-qual.json"), JSON.stringify(evidence, null, 2));
};
const sh = (cmd, a = []) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", timeout: 60000 }).trim();
  } catch (e) {
    return `ERR:${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Pre-flight: reap orphaned QEMU from previous runs. Their VNC/forward
  // ports would otherwise collide with fresh claims and surface as a
  // misleading QMP-handshake failure at boot.
  try {
    execSync("pkill -9 -f qemu-system-x86_64", { stdio: "ignore" });
  } catch { /* none running */ }
  await sleep(3000);
  try {
    // Bracket trick: the pattern must not match the pgrep parent shell itself.
    const leftovers = execSync("pgrep -f 'qemu-system-x86_6[4]' || true", { encoding: "utf8" }).trim();
    if (leftovers) throw new Error("orphaned qemu-system-x86_64 still alive after pkill; refusing to start");
  } catch (e) {
    if (e instanceof Error && e.message.includes("orphaned")) throw e;
  }
  evidence.host.qemuVersion = sh("qemu-system-x86_64", ["--version"]).split("\n")[0];
  evidence.host.qemuImgVersion = sh("qemu-img", ["--version"]).split("\n")[0];
  evidence.host.kvm = existsSync("/dev/kvm") ? "present" : "ABSENT";
  evidence.host.accel = sh("qemu-system-x86_64", ["-accel", "help"]);
  evidence.host.cloudLocalds = sh("sh", ["-c", "command -v cloud-localds || echo ABSENT"]);
  evidence.host.kernel = sh("uname", ["-r"]);
  rec("env-probe", existsSync("/dev/kvm"), evidence.host);

  mkdirSync(IMGDIR, { recursive: true });
  const base = join(IMGDIR, "eve-base-noble.qcow2");
  if (!existsSync(base)) {
    copyFileSync(BASE_SRC, base);
    chmodSync(base, 0o444);
  }
  const pin0 = await backingDigest(base);
  evidence.base = { path: base, ...pin0 };
  rec("base-sealed", pin0.size > 100_000_000, `size=${pin0.size} digest=${pin0.digest.slice(0, 16)}`);

  const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 10 });
  const spec = { image: "ubuntu-desktop-v1", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "allowlisted" };
  const t0 = Date.now();
  let vm;
  if (PHASE === "guest") {
    const saved = readFileSync(VMFILE, "utf8").trim().split("\n");
    const vmId = saved[0];
    // Re-attach driver bookkeeping is in-memory only; phase 2 runs in the
    // SAME process invocation as phase 1 in normal use. Standalone guest
    // phase requires the VM record: re-create is not possible, so guest phase
    // must follow boot phase in one run unless --resume is implemented.
    throw new Error("standalone guest phase unsupported; run PHASE=all");
    void vmId;
  }
  vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-base-noble.qcow2", hostname: "eve-qual-01" });
  mkdirSync(ARTDIR, { recursive: true });
  writeFileSync(VMFILE, `${vm.vmId}\n${join(IMGDIR, vm.vmId)}\n`);
  const workdir = join(IMGDIR, vm.vmId);
  rec("create-overlay", existsSync(join(workdir, "disk.qcow2")), `vm=${vm.vmId}`);
  const info = sh("qemu-img", ["info", "--output=json", join(workdir, "disk.qcow2")]);
  rec("overlay-backing", info.includes("eve-base-noble.qcow2"), info.slice(0, 200));
  rec("seed-iso", existsSync(join(workdir, "seed.iso")), "seed.iso attached readonly at boot");
  try {
    const st = execFileSync("stat", ["-c", "%a", join(workdir, "guest-secret")], { encoding: "utf8" }).trim();
    rec("guest-secret-perms", st === "600", `mode=${st}`);
  } catch {
    rec("guest-secret-perms", false, "stat failed");
  }

  const tb = Date.now();
  await driver.boot(vm.vmId);
  const bootMs = Date.now() - tb;
  const st = await driver.status(vm.vmId);
  rec("boot-running", st.state === "RUNNING", `state=${st.state} bootMs=${bootMs} detail=${st.detail}`);
  evidence.qemuArgv = driver.auditLog(vm.vmId).map((e) => `${e.op}:${e.detail}`).join(" | ").slice(0, 2000);

  // QMP command battery through the driver's own connection.
  const cell = driver.auditLog(vm.vmId);
  void cell;
  const qmp = driver.qmpForTest(vm.vmId);
  const qver = await qmp.command("query-version");
  rec("qmp-version", Boolean(qver?.return?.qemu), JSON.stringify(qver?.return?.qemu ?? qver).slice(0, 160));
  const qstat = await qmp.command("query-status");
  rec("qmp-status", qstat?.return?.status === "running", JSON.stringify(qstat?.return).slice(0, 160));

  // Screendump: must be a real PNG (magic bytes), saved as artifact.
  const png = await driver.screendump(vm.vmId);
  const isPng = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  mkdirSync(ARTDIR, { recursive: true });
  writeFileSync(join(ARTDIR, "qual-screendump.png"), png);
  rec("screendump-png", isPng, `bytes=${png.length}`);

  // Wait for qemu-guest-agent (cloud-init installs + starts it; first-boot
  // apt can take several minutes, so the cap is generous).
  let agentUp = false;
  const tWait = Date.now();
  while (Date.now() - tWait < 20 * 60 * 1000) {
    try {
      const r = await driver.guestExecSync(vm.vmId, ["hostname"], 15000);
      if (r.exitcode === 0 && r.out.trim().length > 0) {
        agentUp = true;
        evidence.guestHostname = r.out.trim();
        break;
      }
    } catch { /* not yet */ }
    await sleep(15000);
  }
  rec("qga-up", agentUp, `hostname=${evidence.guestHostname ?? "?"} waitedMs=${Date.now() - tWait}`);

  // Filesystem-state proof for savevm/loadvm.
  const marker = `EVE-PROOF-${Date.now()}`;
  const target = "/tmp/eve-restore-proof";
  const w1 = await driver.guestExecSync(vm.vmId, ["sh", "-c", `echo ${marker} > ${target} && cat ${target}`]);
  rec("guest-write", w1.out.trim() === marker, w1.out.trim().slice(0, 80));
  const snap = await driver.snapshot(vm.vmId, "snap1");
  rec("savevm", snap.endsWith("@snap1"), snap);
  const w2 = await driver.guestExecSync(vm.vmId, ["sh", "-c", `rm -f ${target} && (cat ${target} || echo GONE)`]);
  rec("guest-delete", w2.out.trim() === "GONE", w2.out.trim().slice(0, 40));
  const rst = await driver.restore(vm.vmId, "snap1");
  rec("loadvm", rst.endsWith("@snap1"), rst);
  await sleep(5000);
  const w3 = await driver.guestExecSync(vm.vmId, ["sh", "-c", `cat ${target} || echo GONE`]);
  rec("restore-proof", w3.out.trim() === marker, `after loadvm: ${w3.out.trim().slice(0, 80)}`);

  // Lifecycle: pause/resume + illegal ops.
  await driver.pause(vm.vmId);
  const ps = await driver.status(vm.vmId);
  rec("pause", ps.state === "PAUSED", ps.state);
  await driver.resume(vm.vmId);
  const rs = await driver.status(vm.vmId);
  rec("resume", rs.state === "RUNNING", rs.state);
  let dbl = false;
  try {
    await driver.boot(vm.vmId);
  } catch (e) {
    dbl = e instanceof Error && /BOOTING|RUNNING|INVALID/.test(e.message);
  }
  rec("double-boot-rejected", dbl, "boot while RUNNING refused");

  // Fork isolation: branch writes file A, sibling writes file B.
  const fork = await driver.fork(vm.vmId, "qual-tenant");
  rec("fork", Boolean(fork.vmId), `child=${fork.vmId}`);
  const fa = await driver.guestExecSync(fork.vmId, ["sh", "-c", "echo BRANCH-A > /tmp/eve-branch && cat /tmp/eve-branch"]);
  const fb = await driver.guestExecSync(vm.vmId, ["sh", "-c", "echo BRANCH-B > /tmp/eve-branch && cat /tmp/eve-branch"]);
  const fa2 = await driver.guestExecSync(fork.vmId, ["sh", "-c", "cat /tmp/eve-branch"]);
  rec("fork-isolation", fa.out.trim() === "BRANCH-A" && fb.out.trim() === "BRANCH-B" && fa2.out.trim() === "BRANCH-A", `A=${fa2.out.trim()} B=${fb.out.trim()}`);

  await driver.destroy(fork.vmId);
  await driver.destroy(vm.vmId);
  rec("destroy", !existsSync(workdir), "workdir removed");
  const pin1 = await backingDigest(base);
  rec("base-immutable", pin1.digest === pin0.digest && pin1.size === pin0.size, "golden base untouched by full lifecycle");

  evidence.totalMs = Date.now() - t0;
  flush();
  console.log(`\nQUAL COMPLETE in ${Math.round(evidence.totalMs / 1000)}s`);
}

main().catch((e) => {
  console.error(`QUAL ABORT: ${e instanceof Error ? e.message : String(e)}`);
  try { flush(); } catch { /* ignore */ }
  process.exit(1);
});
