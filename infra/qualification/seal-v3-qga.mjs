#!/usr/bin/env node
// Seal v3 (retry): configure GDM autologin via the per-VM QGA channel
// (no TCP ports, no wrong-guest hazard), verify a real graphical session,
// power off, merge+seal over the XORG base (keeps the Xorg flip).
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 60 });
const spec = { image: "eve-desktop-autologin", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-sealv3" });
console.log("VM=" + vm.vmId);
writeFileSync("/tmp/sealv3-vm.txt", vm.vmId + "\n");
await driver.boot(vm.vmId);
console.log("RUNNING");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await driver.guestExecSync(vm.vmId, ["/bin/hostname"], 15000);
    if (r.exitcode === 0) { up = true; break; }
  } catch {}
  await sleep(15000);
}
if (!up) throw new Error("qga never came up");
console.log("QGA-UP");
const gx = async (argv, t = 30000) => {
  const r = await driver.guestExecSync(vm.vmId, argv, t).catch((e) => ({ exitcode: -1, out: "", err: String(e?.message ?? e) }));
  console.log("$", argv.slice(0, 4).join(" "), "=> exit=" + r.exitcode, (r.out || r.err || "").trim().slice(0, 300));
  return r;
};
// GDM autologin (keep Xorg flip already in the base).
await gx(["/bin/sh", "-c", `cat > /etc/gdm3/custom.conf <<'EOF'
[daemon]
WaylandEnable=false
AutomaticLoginEnable=True
AutomaticLogin=eveagent
[security]
[xdmcp]
[chooser]
[debug]
EOF
grep -E "WaylandEnable|AutomaticLogin" /etc/gdm3/custom.conf`]);
// Lock/idle/suspend off (passwordless account must never lock).
await gx(["/bin/sh", "-c", `U=$(id -u eveagent); export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$U/bus
sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS gsettings set org.gnome.desktop.screensaver lock-enabled false
sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS gsettings set org.gnome.desktop.screensaver idle-activation-enabled false
sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS gsettings set org.gnome.desktop.session idle-delay 0
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target 2>/dev/null
echo LOCK-OFF`]);
await gx(["/bin/systemctl", "restart", "gdm3"]);
console.log("GDM-RESTARTED, waiting 90s for autologin...");
await sleep(90000);
await gx(["/bin/sh", "-c", "loginctl list-sessions --no-legend; echo ---; loginctl show-user eveagent -p State; echo ---; pgrep -u eveagent -a gnome-shell | head -2; pgrep -u eveagent -a gnome-session-b | head -2"]);
console.log("SEALV3-CONFIGURED (powered off + merged by caller)");
process.exit(0);
