#!/usr/bin/env node
// Controlled RAM experiment: two identical desktop VMs, 4096 vs 8192 MB.
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { readFileSync } from "node:fs";
const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 50 });
const sshKey = readFileSync("/root/.ssh/eve-qual.pub", "utf8").trim();
async function mk(name, mem) {
  const spec = { image: "eve-desktop-xorg", cpu: 2, memoryMb: mem, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
  const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-xorg.qcow2", hostname: name, sshKey });
  await driver.boot(vm.vmId);
  console.log(`${name}=${vm.vmId} RUNNING`);
  return vm.vmId;
}
const a = await mk("eve-ram4g", 4096);
const b = await mk("eve-ram8g", 8192);
console.log("BOTH-UP");
setInterval(() => undefined, 1000000);
