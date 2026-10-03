#!/usr/bin/env node
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = "/var/lib/eve-images/qual/vm-1617d36c/qga.sock";
const q = new QmpConnection();
await q.connectQga(sock, 15000);
async function sh(cmd) {
  const ex = await q.command("guest-exec", { path: "/bin/sh", arg: ["-c", cmd], "capture-output": true });
  for (let i = 0; i < 20; i++) {
    const st = await q.command("guest-exec-status", { pid: ex.return.pid });
    if (st.return.exited) {
      const out = st.return["out-data"] ? Buffer.from(st.return["out-data"], "base64").toString() : "";
      return out.trim();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "TIMEOUT";
}
console.log("uptime:", (await sh("cat /proc/uptime")).split(" ")[0], "s");
console.log("qga-active-since:", await sh("systemctl show qemu-guest-agent -p ActiveEnterTimestamp --value"));
console.log("date:", await sh("date -u +%H:%M:%S"));
console.log("gdm:", await sh("systemctl is-active gdm3 display-manager"));
console.log("gnome:", await sh("pgrep -c gnome-shell || echo 0"));
q.close();
process.exit(0);
