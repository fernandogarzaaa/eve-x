#!/usr/bin/env node
// Live QGA channel test: create, boot, guest-exec hostname with full errors.
import { QemuDriver } from "/root/evex/dist/packages/vm/src/index.js";
const driver = new QemuDriver({ imagesDir: "/var/lib/eve-images/qual", vncBase: 16 });
const spec = { image: "ubuntu-desktop-v1", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "allowlisted" };
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-base-noble.qcow2", hostname: "eve-qual-live" });
console.log("VM=" + vm.vmId, "FLUSH");
await driver.boot(vm.vmId);
console.log("RUNNING", "FLUSH");
const t0 = Date.now();
for (let i = 0; i < 48; i++) {
  try {
    const r = await driver.guestExecSync(vm.vmId, ["/bin/hostname"], 20000);
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s HOSTNAME=${r.out.trim()} exit=${r.exitcode} FLUSH`);
    break;
  } catch (e) {
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s ERR=${String(e?.message ?? e).slice(0, 160)} FLUSH`);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log("LIVE-DONE", "FLUSH");
setInterval(() => undefined, 1000000);
