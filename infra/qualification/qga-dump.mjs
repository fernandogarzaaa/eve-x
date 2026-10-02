#!/usr/bin/env node
// Dump raw bytes from qga.sock of a running qual VM (proves greeting shape).
import { createConnection } from "node:net";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
const qual = "/var/lib/eve-images/qual";
const dirs = readdirSync(qual).filter((d) => d.startsWith("vm-"));
console.log("workdirs:", dirs.join(","));
for (const d of dirs) {
  const sock = join(qual, d, "qga.sock");
  if (!existsSync(sock)) {
    console.log(d, "no qga.sock");
    continue;
  }
  console.log("probing", sock);
  await new Promise((resolve) => {
    const s = createConnection({ path: sock });
    const t = setTimeout(() => { console.log("TIMEOUT: agent silent"); s.destroy(); resolve(); }, 8000);
    s.on("data", (c) => {
      clearTimeout(t);
      console.log("BYTES:", JSON.stringify(c.toString("utf8").slice(0, 300)));
      s.destroy();
      resolve();
    });
    s.on("error", (e) => { clearTimeout(t); console.log("ERR:", e.message); resolve(); });
  });
}
console.log("DUMP-DONE");
