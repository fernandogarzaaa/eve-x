#!/usr/bin/env node
// Driver-direct boot with API-identical spec (3072MB, default seed, no key).
import { QemuDriver } from "/root/evex-prod/dist/packages/vm/src/index.js";
const IMGDIR = "/var/lib/eve-images/qual";
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 44 });
const spec = { image: "eve-desktop-xorg", cpu: 2, memoryMb: 3072, diskGb: 32, width: 1280, height: 800, locale: "en-US", timezone: "UTC", network: "allowlisted" };
const vm = await driver.create(spec, "default:master", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-api-ident" });
console.log("VM=" + vm.vmId);
await driver.boot(vm.vmId);
console.log("RUNNING");
setInterval(() => undefined, 1000000);
