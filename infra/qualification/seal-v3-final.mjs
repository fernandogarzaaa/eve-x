#!/usr/bin/env node
// Seal v3 (final): single process does everything — overlay on XORG base,
// GDM autologin via QGA, lock/idle off (short commands), verify graphical
// session + SCREENDUMP proof, guest poweroff, merge overlay, seal.
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 61 });
const spec = { image: "eve-desktop-autologin", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-sealv3" });
const vmId = vm.vmId;
console.log("VM=" + vmId);
await driver.boot(vmId);
console.log("RUNNING");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await driver.guestExecSync(vmId, ["/bin/hostname"], 15000);
    if (r.exitcode === 0) { up = true; break; }
  } catch {}
  await sleep(15000);
}
if (!up) throw new Error("qga never came up");
console.log("QGA-UP");
const gx = async (argv, t = 30000) => {
  const r = await driver.guestExecSync(vmId, argv, t).catch((e) => ({ exitcode: -1, out: "", err: String(e?.message ?? e).slice(0, 120) }));
  console.log("$", argv.slice(0, 3).join(" "), "=> exit=" + r.exitcode, (r.out || r.err || "").trim().slice(0, 200));
  return r;
};
await gx(["/bin/sh", "-c", "cat > /etc/gdm3/custom.conf <<'EOF'\n[daemon]\nWaylandEnable=false\nAutomaticLoginEnable=True\nAutomaticLogin=eveagent\n[security]\n[xdmcp]\n[chooser]\n[debug]\nEOF\ngrep -c AutomaticLogin /etc/gdm3/custom.conf"]);
await gx(["/bin/sh", "-c", "U=$(id -u eveagent); B=unix:path=/run/user/$U/bus; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$B gsettings set org.gnome.desktop.screensaver lock-enabled false"]);
await gx(["/bin/sh", "-c", "U=$(id -u eveagent); B=unix:path=/run/user/$U/bus; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$B gsettings set org.gnome.desktop.session idle-delay 0"]);
await gx(["/bin/systemctl", "mask", "sleep.target", "suspend.target"]);
await gx(["/bin/systemctl", "restart", "gdm3"]);
console.log("GDM-RESTARTED, waiting 90s...");
await sleep(90000);
await gx(["/bin/sh", "-c", "loginctl --no-legend | head -4; pgrep -u eveagent -a gnome-shell | head -1"]);
console.log("== screendump proof ==");
const shot = await driver.screendump(vmId).catch((e) => null);
if (!shot || shot.length < 10000) throw new Error("screendump too small: " + (shot?.length ?? 0));
writeFileSync("/tmp/v3-proof.ppm", shot);
console.log("screendump bytes=" + shot.length);
console.log("== guest poweroff via driver shutdown ==");
await driver.shutdown(vmId);
console.log("SHUTDOWN-OK");
await sleep(5000);
const out = "/var/lib/eve-images/eve-desktop-autologin.qcow2";
execSync(`qemu-img convert -p -O qcow2 /var/lib/eve-images/qual/${vmId}/disk.qcow2 ${out}.tmp`, { stdio: "inherit" });
execSync(`mv ${out}.tmp ${out} && chmod 444 ${out}`);
const sha = execSync(`sha256sum ${out} | awk '{print $1}'`).toString().trim();
const size = execSync(`stat -c%s ${out}`).toString().trim();
const manifest = {
  image: "eve-desktop-autologin.qcow2", built_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  derived_from: "eve-desktop-xorg.qcow2 (overlay merge + GDM autologin eveagent + lock/idle/suspend off)",
  image_sha256: sha, image_bytes: Number(size),
  contents: ["ubuntu-desktop-minimal", "qemu-guest-agent", "openssh-server", "scrot", "GDM Xorg + autologin"],
  secrets_baked: [], sealed_readonly: true,
};
writeFileSync(`${out}.manifest.json`, JSON.stringify(manifest, null, 2));
console.log("sealed v3: sha256=" + sha + " bytes=" + size);
console.log("SEAL-V3-DONE");
process.exit(0);
