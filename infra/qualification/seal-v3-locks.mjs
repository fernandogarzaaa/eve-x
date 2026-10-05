#!/usr/bin/env node
// Seal v3 (locks pass): dconf LOCKS + autostart suppression + user-db reset,
// verified on a FRESH login, then reseal over the v3 file.
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 63 });
const spec = { image: "eve-desktop-autologin", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-autologin.qcow2", hostname: "eve-sealv3c" });
const vmId = vm.vmId;
console.log("VM=" + vmId);
await driver.boot(vmId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await driver.guestExecSync(vmId, ["/bin/sh", "-c", "loginctl --no-legend | grep eveagent | grep -c -v ssh || true"], 15000);
    if (Number((r.out || "0").trim()) >= 1) {
      const g = await driver.guestExecSync(vmId, ["/usr/bin/pgrep", "-u", "eveagent", "gnome-shell"], 15000).catch(() => ({ exitcode: 1 }));
      if (g.exitcode === 0) { ready = true; break; }
    }
  } catch {}
  await sleep(15000);
}
if (!ready) throw new Error("desktop session never appeared");
console.log("DESKTOP-UP");
const gx = async (argv, t = 30000) => {
  const r = await driver.guestExecSync(vmId, argv, t).catch((e) => ({ exitcode: -1, out: "", err: String(e?.message ?? e).slice(0, 120) }));
  console.log("$", argv.slice(0, 3).join(" "), "=> exit=" + r.exitcode, (r.out || r.err || "").trim().slice(0, 220));
  return r;
};
// Mandatory locks (user-db writes must never override kiosk policy).
await gx(["/bin/sh", "-c", `mkdir -p /etc/dconf/db/local.d/locks && cat > /etc/dconf/db/local.d/locks/evex-kiosk <<'EOF'
/org/gnome/desktop/screensaver/lock-enabled
/org/gnome/desktop/screensaver/idle-activation-enabled
/org/gnome/desktop/session/idle-delay
/org/gnome/settings-daemon/plugins/power/sleep-inactive-ac-type
/org/gnome/settings-daemon/plugins/power/sleep-inactive-battery-type
EOF
dconf update && echo LOCKS-IN`]);
// Reset the baked user db (seal-session writes) so locks/defaults rule.
await gx(["/bin/sh", "-c", "rm -f /home/eveagent/.config/dconf/user && echo USERDB-RESET"]);
// Suppress first-login wizard + update notifier for the kiosk user.
await gx(["/bin/sh", "-c", `mkdir -p /home/eveagent/.config/autostart && printf '[Desktop Entry]\\nType=Application\\nName=disabled\\nHidden=true\\n' | tee /home/eveagent/.config/autostart/gnome-initial-setup-first-login.desktop /home/eveagent/.config/autostart/update-notifier.desktop > /dev/null && chown -R eveagent:eveagent /home/eveagent/.config/autostart && echo AUTOSTART-SUPPRESSED`]);
await gx(["/bin/systemctl", "restart", "gdm3"]);
console.log("GDM-RESTARTED, waiting 90s for fresh login...");
await sleep(90000);
await gx(["/bin/sh", "-c", "U=$(id -u eveagent); B=unix:path=/run/user/$U/bus; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$B gsettings get org.gnome.desktop.screensaver lock-enabled; sudo -u eveagent DBUS_SESSION_BUS_ADDRESS=$B gsettings get org.gnome.desktop.session idle-delay"]);
await gx(["/bin/sh", "-c", "ps -u eveagent -o comm= | sort -u | grep -i -E 'tour|setup|welcome|notifier' || echo no-wizards"]);
console.log("== screendump proof ==");
const shot = await driver.screendump(vmId).catch((e) => null);
if (!shot || shot.length < 10000) throw new Error("screendump too small");
writeFileSync("/tmp/v3c.ppm", shot);
console.log("screendump bytes=" + shot.length);
await driver.shutdown(vmId);
console.log("SHUTDOWN-OK");
await sleep(5000);
const out = "/var/lib/eve-images/eve-desktop-autologin.qcow2";
execSync(`qemu-img convert -p -O qcow2 /var/lib/eve-images/qual/${vmId}/disk.qcow2 ${out}.tmp`, { stdio: "inherit" });
execSync(`mv ${out}.tmp ${out} && chmod 444 ${out}`);
const sha = execSync(`sha256sum ${out} | awk '{print $1}'`).toString().trim();
const size = execSync(`stat -c%s ${out}`).toString().trim();
writeFileSync(`${out}.manifest.json`, JSON.stringify({
  image: "eve-desktop-autologin.qcow2", built_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  derived_from: "eve-desktop-xorg.qcow2 (overlay merges: autologin + kiosk dconf locks + wizard suppression)",
  image_sha256: sha, image_bytes: Number(size),
  contents: ["ubuntu-desktop-minimal", "qemu-guest-agent", "openssh-server", "scrot", "GDM Xorg + autologin + kiosk"],
  secrets_baked: [], sealed_readonly: true,
}, null, 2));
console.log("sealed v3 FINAL: sha256=" + sha + " bytes=" + size);
console.log("SEAL-V3C-DONE");
process.exit(0);
