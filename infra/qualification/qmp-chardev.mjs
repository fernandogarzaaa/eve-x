#!/usr/bin/env node
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = process.argv[2];
const q = new QmpConnection();
await q.connect(sock, 8000);
const st = await q.command("query-status");
console.log("STATUS:", JSON.stringify(st.return));
const cd = await q.command("query-chardev");
for (const c of cd.return ?? []) {
  if (JSON.stringify(c).includes("qga")) console.log("CHARDEV:", JSON.stringify(c).slice(0, 300));
}
q.close();
process.exit(0);
