#!/usr/bin/env node
// Spawn a seeded qual VM and print its workdir + ssh details for diagnostics.
import { QemuDriver } from "/root/evex/dist/packages/vm/src/index.js";
import { readFileSync, existsSync } from "node:fs";

const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 12 });
const spec = { image: "ubuntu-desktop-v1", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "allowlisted" };
const sshKey = readFileSync("/root/.ssh/eve-qual.pub", "utf8").trim();
const vm = await driver.create(spec, "qual-tenant", {
  baseImage: "eve-base-noble.qcow2",
  hostname: "eve-qual-ssh",
  sshKey,
});
console.log("VM=" + vm.vmId);
await driver.boot(vm.vmId);
console.log("STATE=" + (await driver.status(vm.vmId)).state);
console.log("AUDIT=" + driver.auditLog(vm.vmId).map((e) => e.op + ":" + e.detail).join(" | ").slice(0, 600));
setInterval(() => undefined, 1000000);
