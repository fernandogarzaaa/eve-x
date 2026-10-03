#!/usr/bin/env node
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = "/var/lib/eve-images/qual/vm-1617d36c/qga.sock";
for (let i = 0; i < 6; i++) {
  const q = new QmpConnection();
  try {
    await q.connectQga(sock, 15000);
    console.log(`attempt ${i}: SYNC-OK`);
    const r = await q.command("guest-exec", { path: "/bin/hostname", arg: [], "capture-output": true });
    console.log("EXEC:", JSON.stringify(r).slice(0, 160));
    q.close();
    break;
  } catch (e) {
    console.log(`attempt ${i}: ${String(e?.message ?? e).slice(0, 100)}`);
    try { q.close(); } catch {}
  }
  await new Promise((r) => setTimeout(r, 20000));
}
process.exit(0);
