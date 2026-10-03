#!/usr/bin/env node
// Boot the SEALED desktop base via OUR driver; prove desktop renders.
// Evidence: artifacts/qualification/desktop-boot.json + desktop-shot.png
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { QemuDriver } = await import(join(ROOT, "dist", "packages", "vm", "src", "index.js"));
const IMGDIR = process.env.IMGDIR ?? "/var/lib/eve-images/qual";
const ARTDIR = process.env.ARTDIR ?? join(ROOT, "artifacts", "qualification");
const out = { at: new Date().toISOString(), phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 160)}`);
  if (!ok) { flush(); process.exitCode = 1; throw new Error(name); }
};
const flush = () => {
  mkdirSync(ARTDIR, { recursive: true });
  writeFileSync(join(ARTDIR, "desktop-boot.json"), JSON.stringify(out, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("pkill -9 -f 'qemu-system-x86_6[4]'"); await sleep(3000); } catch {}

const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 20 });
const spec = { image: "eve-desktop-noble", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
const t0 = Date.now();
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-desktop-01" });
rec("create-desktop-overlay", true, `vm=${vm.vmId}`);
await driver.boot(vm.vmId);
rec("boot-running", (await driver.status(vm.vmId)).state === "RUNNING", "hypervisor running");
// Wait for GNOME session (desktop actually rendered, not just kernel up).
let desktop = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await driver.guestExecSync(vm.vmId, ["/bin/sh", "-c", "pgrep -c gnome-shell || echo 0"], 20000);
    if (Number(r.out.trim()) > 0) { desktop = true; break; }
  } catch {}
  await sleep(15000);
}
rec("gnome-shell-running", desktop, "desktop session up");
// Enforce the requested mode at runtime (GDM/Xorg negotiates its own
// default; xrandr is the deterministic control). Uses the GDM cookie.
const xr = await driver.guestExecSync(vm.vmId, ["/bin/sh", "-c",
  'C=$(find /run -maxdepth 4 -name Xauthority -path "*gdm*" 2>/dev/null | head -1); ' +
  'XAUTHORITY=$C DISPLAY=:0 xrandr --output default --mode 1280x800'], 30000);
rec("xrandr-mode-set", xr.exitcode === 0, (xr.out + xr.err).trim().slice(0, 100) || "mode applied");
await sleep(3000);
// Graphical frame: parse IHDR dimensions (must equal the requested mode)
// and require real pixel entropy (a live desktop is never a 1.5KB console).
const png = await driver.screendump(vm.vmId);
const isPng = png[0] === 0x89 && png[1] === 0x50;
const w = png.readUInt32BE(16);
const h = png.readUInt32BE(20);
writeFileSync(join(ARTDIR, "desktop-shot.png"), png);
rec("desktop-frame-png", isPng && w === 1280 && h === 800 && png.length > 10000, `${w}x${h} bytes=${png.length}`);
// Sanity: firefox binary present in the running guest.
const fx = await driver.guestExecSync(vm.vmId, ["/bin/sh", "-c", "command -v firefox"], 20000);
rec("firefox-present", fx.exitcode === 0, fx.out.trim().slice(0, 60));
writeFileSync(join(ARTDIR, "desktop-vmid.txt"), `${vm.vmId}\n`);
out.totalMs = Date.now() - t0;
flush();
console.log(`\nDESKTOP BOOT COMPLETE in ${Math.round(out.totalMs / 1000)}s (VM ${vm.vmId} left RUNNING)`);
setInterval(() => undefined, 1000000);
