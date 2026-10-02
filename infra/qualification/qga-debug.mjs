#!/usr/bin/env node
// QGA debug: boot via driver, attempt guest-exec with FULL error visibility.
import { QemuDriver } from "/root/evex/dist/packages/vm/src/index.js";
import { readFileSync } from "node:fs";

const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 14 });
const spec = { image: "ubuntu-desktop-v1", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "allowlisted" };
const sshKey = readFileSync("/root/.ssh/eve-qual.pub", "utf8").trim();
const vm = await driver.create(spec, "qual-tenant", {
  baseImage: "eve-base-noble.qcow2", hostname: "eve-qual-dbg", sshKey,
});
console.log("VM=" + vm.vmId);
await driver.boot(vm.vmId);
console.log("RUNNING");
const q = driver.qmpForTest(vm.vmId);
for (let i = 0; i < 40; i++) {
  try {
    const r = await q.command("guest-exec", { path: "/bin/hostname", arg: [], "capture-output": true });
    console.log(`t=${i * 30}s EXEC-OK:`, JSON.stringify(r).slice(0, 200));
    const pid = r?.return?.pid;
    const s = await q.command("guest-exec-status", { pid });
    console.log("STATUS:", JSON.stringify(s).slice(0, 300));
    break;
  } catch (e) {
    console.log(`t=${i * 30}s EXEC-ERR:`, e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220));
  }
  await new Promise((r) => setTimeout(r, 30000));
}
console.log("DBG-DONE");
setInterval(() => undefined, 1000000);
