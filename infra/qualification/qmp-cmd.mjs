#!/usr/bin/env node
import { QmpConnection } from "/root/evex-prod/dist/packages/vm/src/index.js";
const sock = process.argv[2];
const cmd = process.argv[3] ?? "query-status";
const q = new QmpConnection();
await q.connect(sock, 8000);
console.log("connected");
const r = await q.command(cmd);
console.log(JSON.stringify(r).slice(0, 200));
q.close();
process.exit(0);
