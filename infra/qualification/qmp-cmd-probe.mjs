#!/usr/bin/env node
// List QMP commands containing "guest" on this QEMU build.
import { QmpConnection } from "/root/evex/dist/packages/vm/src/index.js";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
const sock = "/tmp/eve-qmp-probe.sock";
try { rmSync(sock, { force: true }); } catch {}
const qemu = spawn("qemu-system-x86_64", [
  "-display", "none",
  "-qmp", `unix:${sock},server=on,wait=off`,
]);
await new Promise((r) => setTimeout(r, 2500));
const q = new QmpConnection();
await q.connect(sock, 5000);
const cmds = await q.command("query-commands");
const names = cmds.return.map((c) => c.name).filter((n) => n.includes("guest"));
console.log("GUEST-CMDS:", JSON.stringify(names));
q.close();
qemu.kill("SIGKILL");
console.log("PROBE-DONE");
