#!/usr/bin/env node
// QMP status check against a workdir socket.
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = process.argv[2];
const q = new QmpConnection();
await q.connect(sock, 8000);
const st = await q.command("query-status");
console.log("STATUS:", JSON.stringify(st.return));
const cpus = await q.command("query-cpus-fast").catch((e) => ({ error: String(e.message).slice(0, 80) }));
console.log("CPUS:", JSON.stringify(cpus.return ?? cpus).slice(0, 200));
q.close();
process.exit(0);
