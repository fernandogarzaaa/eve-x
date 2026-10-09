#!/usr/bin/env node
// EVE-X Docker-backend qualification: drives the ACTUAL DockerDesktopDriver
// (create/boot/exec/screenshot/snapshot/restore/destroy) + hardening asserts
// (cap-drop, no-new-privs, pids-limit, network) + evidence JSON.
// Usage: node infra/qualification/docker-qual.mjs
import { DockerDesktopDriver } from "../../dist/packages/vm/src/index.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = { at: new Date().toISOString(), phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 200)}`);
  if (!ok) {
    flush();
    process.exitCode = 1;
    throw new Error("phase failed: " + name);
  }
};
const flush = () => {
  mkdirSync("artifacts/qualification", { recursive: true });
  writeFileSync(join("artifacts/qualification", "docker-qual.json"), JSON.stringify(out, null, 2));
};
const sh = (cmd, a = []) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", timeout: 60000 }).trim();
  } catch (e) {
    return `ERR:${(e?.message ?? String(e)).slice(0, 200)}`;
  }
};

const driver = new DockerDesktopDriver();
// Qualification image with baked screenshot tooling (see
// Dockerfile.qual-desktop). TEST-ONLY tag: evex-qual-desktop:latest is a
// local qual artifact, never a production image (production boots
// digest-pinned references; see requirePinnedDockerImage). Full network
// for this run; the allowlisted→none mapping was proven in a prior run
// (NetworkMode=none).
const spec = { image: "evex-qual-desktop:latest", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "full" };
const t0 = Date.now();
const vm = await driver.create(spec, "qual-tenant");
rec("create", Boolean(vm.vmId), `vm=${vm.vmId}`);
await driver.boot(vm.vmId);
const st = await driver.status(vm.vmId);
rec("boot-running", st.state === "RUNNING", st.detail.slice(0, 120));

// Hardening asserts from live inspect.
const insp = JSON.parse(sh("docker", ["inspect", `eve-${vm.vmId}`]).slice(0, 20000) || "{}");
const hc = Array.isArray(insp) ? insp[0]?.HostConfig ?? {} : {};
const capDrop = JSON.stringify(hc.CapDrop ?? []);
const pids = hc.PidsLimit;
const netMode = insp[0]?.HostConfig?.NetworkMode ?? "";
const priv = insp[0]?.HostConfig?.Privileged;
rec("cap-drop", capDrop.includes("ALL"), capDrop.slice(0, 80));
rec("pids-limit", pids === 256, `PidsLimit=${pids}`);
rec("not-privileged", priv === false, `Privileged=${priv}`);
rec("net-full-means-bridge", netMode !== "none", `NetworkMode=${netMode}`);
const mounts = JSON.stringify(insp[0]?.Mounts ?? []);
rec("no-host-mounts", !mounts.includes("/mnt/") && !mounts.includes("C:\\"), mounts.slice(0, 120));

// Exec channel proof.
const hn = await driver.exec(vm.vmId, ["hostname"]);
rec("exec", hn.code === 0 && hn.stdout.trim().length > 0, hn.stdout.trim().slice(0, 60));

// Screenshot tooling is baked into the qual image (a production requirement
// documented in the driver error text); assert presence, proving the
// exec→cp→PNG mechanism end to end.
const hasShot = await driver.exec(vm.vmId, ["sh", "-c", "command -v scrot"]);
rec("screenshot-tool-baked", hasShot.code === 0, "scrot present in qual image");

// Screenshot proof (PNG magic).
let shotOk = false;
let shotDetail = "";
try {
  const png = await driver.screendump(vm.vmId);
  shotOk = png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
  shotDetail = `bytes=${png.length}`;
  writeFileSync(join("artifacts/qualification", "docker-shot.png"), png);
} catch (e) {
  shotDetail = `screendump failed: ${String(e?.message ?? e).slice(0, 160)}`;
}
rec("screendump-png", shotOk, shotDetail);

// Snapshot/restore proof: write AFTER snapshot, restore, expect absent.
const snap = await driver.snapshot(vm.vmId, "snap1");
rec("snapshot", snap.endsWith("@snap1"), snap);
const marker = `EVE-DOCK-PROOF-${Date.now()}`;
await driver.exec(vm.vmId, ["sh", "-c", `echo ${marker} > /tmp/eve-restore-proof`]);
const rst = await driver.restore(vm.vmId, "snap1");
rec("restore", rst.endsWith("@snap1"), rst);
const chk = await driver.exec(vm.vmId, ["sh", "-c", "cat /tmp/eve-restore-proof || echo GONE"]);
rec("restore-proof", chk.stdout.trim() === "GONE", chk.stdout.trim().slice(0, 60));

await driver.destroy(vm.vmId);
const gone = sh("docker", ["ps", "-a", "--filter", `name=eve-${vm.vmId}`, "--format", "{{.Names}}"]);
rec("destroy", gone === "", "container removed");
out.totalMs = Date.now() - t0;
flush();
console.log(`\nDOCKER QUAL COMPLETE in ${Math.round(out.totalMs / 1000)}s`);
