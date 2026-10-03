#!/usr/bin/env node
// Boot sealed desktop base overlay with SSH, report session type + xrandr modes.
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { readFileSync } from "node:fs";
const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 32 });
const spec = { image: "eve-desktop-noble", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, network: "allowlisted" };
const sshKey = readFileSync("/root/.ssh/eve-qual.pub", "utf8").trim();
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-noble.qcow2", hostname: "eve-modes", sshKey });
console.log("VM=" + vm.vmId);
await driver.boot(vm.vmId);
console.log("RUNNING");
setInterval(() => undefined, 1000000);
