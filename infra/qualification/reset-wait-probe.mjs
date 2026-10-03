#!/usr/bin/env node
// Reset the canonical VM guest via QMP, then leave it alone; single qga probe at the end.
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = "/var/lib/eve-images/qual/vm-969d9500/qmp.sock";
const q = new QmpConnection();
await q.connect(sock, 8000);
console.log("QMP ok");
await q.command("system_reset");
console.log("RESET sent");
q.close();
const waitMs = Number(process.argv[2] ?? 300000);
console.log(`waiting ${waitMs / 1000}s without touching the VM...`);
await new Promise((r) => setTimeout(r, waitMs));
const { execSync } = await import("node:child_process");
try {
  const out = execSync("python3 /root/qga-sync.py /var/lib/eve-images/qual/vm-969d9500/qga.sock", { encoding: "utf8", timeout: 30000 });
  console.log("QGA:", out.trim().slice(0, 100));
} catch (e) {
  console.log("QGA-PROBE-FAILED");
}
process.exit(0);
