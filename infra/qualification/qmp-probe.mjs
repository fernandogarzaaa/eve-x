#!/usr/bin/env node
// Direct QMP interrogation of an orphaned qual VM (no driver state needed).
import { QmpConnection } from "/root/evex/dist/packages/vm/src/index.js";
const sock = process.argv[2];
const q = new QmpConnection();
await q.connect(sock, 5000);
console.log("QMP connected");
const st = await q.command("query-status");
console.log("STATUS:", JSON.stringify(st.return));
try {
  const ex = await q.command("guest-exec", { path: "hostname", arg: [], "capture-output": true });
  console.log("EXEC pid:", JSON.stringify(ex.return));
  await new Promise((r) => setTimeout(r, 3000));
  const es = await q.command("guest-exec-status", { pid: ex.return.pid });
  console.log("EXEC-STATUS:", JSON.stringify(es.return).slice(0, 300));
} catch (e) {
  console.log("EXEC-FAIL:", e instanceof Error ? e.message : String(e));
}
q.close();
