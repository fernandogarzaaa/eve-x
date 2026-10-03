#!/usr/bin/env node
// Replicate API provisioning EXACTLY (same spec shape, default seed), plus SSH key.
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
import { readFileSync } from "node:fs";
const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 40 });
const spec = { image: "eve-desktop-xorg", cpu: 2, memoryMb: 4096, diskGb: 24, width: 1280, height: 800, locale: "en-US", timezone: "UTC", network: "allowlisted" };
const sshKey = readFileSync("/root/.ssh/eve-qual.pub", "utf8").trim();
const vm = await driver.create(spec, "default:master", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-repro-01", sshKey });
console.log("VM=" + vm.vmId);
await driver.boot(vm.vmId);
console.log("RUNNING");
setInterval(() => undefined, 1000000);
