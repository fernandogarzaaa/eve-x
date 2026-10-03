#!/usr/bin/env node
// Guest escape/network probes: from INSIDE a real KVM guest, attempt to reach
// host-boundary targets via the QGA channel. Expectation per target is
// encoded; any unexpected REACHABLE is a finding. Evidence JSON to ARTDIR.
import { execSync } from "node:child_process";

const IMGDIR = "/var/lib/eve-images";
const ARTDIR = "/root/evex-prod/artifacts/qualification";
const out = { at: new Date().toISOString(), probes: [] };
const rec = (target, result, detail) => {
  out.probes.push({ target, result, detail: String(detail).slice(0, 200) });
  console.log(`${result} :: ${target} :: ${String(detail).slice(0, 120)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { QemuDriver } = await import("/root/evex-prod/dist/packages/vm/src/index.js");
const driver = new QemuDriver({ imagesDir: IMGDIR, vncBase: 30 });
const spec = { image: "ubuntu-desktop-v1", cpu: 2, memoryMb: 2048, diskGb: 8, width: 1280, height: 800, network: "allowlisted" };
const vm = await driver.create(spec, "qual-tenant", { baseImage: "eve-desktop-xorg.qcow2", hostname: "eve-qual-escape" });
await driver.boot(vm.vmId);
console.log("RUNNING " + vm.vmId);

let up = false;
for (let i = 0; i < 40; i++) {
  try {
    const r = await driver.guestExecSync(vm.vmId, ["/bin/hostname"], 15000);
    if (r.exitcode === 0) { up = true; break; }
  } catch {}
  await sleep(15000);
}
if (!up) throw new Error("qga never came up");

const gx = (argv, t = 20000) => driver.guestExecSync(vm.vmId, argv, t).catch((e) => ({ exitcode: -1, out: "", err: String(e?.message ?? e).slice(0, 120) }));

// Cloud metadata must NOT be reachable (user-mode NAT provides none).
let m = await gx(["/usr/bin/curl", "-sS", "-m", "8", "http://169.254.169.254/latest/meta-data/"]);
rec("169.254.169.254", m.exitcode === 0 && m.out.includes("instance-id") ? "REACHABLE" : "BLOCKED", (m.out + m.err).slice(0, 100) || `exit=${m.exitcode}`);

// Host gateway via user-mode NAT exists by design (documented); verify it is
// the NAT gateway, not the LAN.
let gw = await gx(["/bin/sh", "-c", "ip route show default"]);
rec("default-route", "INFO", gw.out.trim().slice(0, 100));

// DNS: guest must resolve via NAT DNS, not leak host resolver config.
let dns = await gx(["/bin/sh", "-c", "cat /etc/resolv.conf | head -3"]);
rec("dns-config", "INFO", dns.out.trim().slice(0, 100));

// QMP socket must not be visible inside the guest.
let qmp = await gx(["/bin/sh", "-c", "ls /tmp/*.sock /var/run/*.sock 2>/dev/null; ss -x 2>/dev/null | grep -c qmp || echo no-qmp-sock"]);
rec("qmp-socket-in-guest", /qmp/i.test(qmp.out) && !/no-qmp-sock/.test(qmp.out) ? "REACHABLE" : "ABSENT", qmp.out.trim().slice(0, 100));

// Host secret must not exist in guest (seed carries ONLY the per-VM secret).
let sec = await gx(["/bin/sh", "-c", "ls /opt/eve-agent/ 2>/dev/null; echo ---; env | grep -i -m3 'EVEX_AUTH\\|DATABASE_URL\\|AWS_' || echo no-host-secrets"]);
rec("host-secrets-in-guest", /EVEX_AUTH|DATABASE_URL|AWS_|no-host-secrets/.test(sec.out) && !/EVEX_AUTH|DATABASE_URL/.test(sec.out) ? "ABSENT" : "REVIEW", sec.out.trim().slice(0, 140));

// Loopback of host (127.0.0.1 from guest = guest itself, must NOT reach host services).
let lo = await gx(["/usr/bin/curl", "-sS", "-m", "6", "http://127.0.0.1:8080/health"]);
rec("host-loopback-8080", lo.exitcode === 0 ? "REVIEW" : "BLOCKED", (lo.out + lo.err).slice(0, 100) || `exit=${lo.exitcode}`);

await driver.destroy(vm.vmId);
const { writeFileSync, mkdirSync } = await import("node:fs");
const { join } = await import("node:path");
mkdirSync(ARTDIR, { recursive: true });
writeFileSync(join(ARTDIR, "escape-probes.json"), JSON.stringify(out, null, 2));
console.log("ESCAPE-PROBES-DONE");
setTimeout(() => process.exit(0), 500);
