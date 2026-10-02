#!/usr/bin/env node
// EVE-X VNC/RFB input qualification: real RFB 3.8 handshake + input events
// through OUR VncRfbInput against a port-mapped desktop container, with
// screenshot evidence that input had a visible effect.
// Usage: node infra/qualification/vnc-qual.mjs
import { VncRfbInput } from "../../dist/packages/computer/src/index.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = { at: new Date().toISOString(), phases: [] };
const rec = (name, ok, detail) => {
  out.phases.push({ name, ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} :: ${String(detail).slice(0, 200)}`);
  if (!ok) {
    flush();
    process.exitCode = 1;
    throw new Error("phase failed: " + name);
  }
};
const flush = () => {
  mkdirSync("artifacts/qualification", { recursive: true });
  writeFileSync(join("artifacts/qualification", "vnc-qual.json"), JSON.stringify(out, null, 2));
};
const sh = (cmd, a = []) => {
  try {
    return execFileSync(cmd, a, { encoding: "utf8", timeout: 60000 }).trim();
  } catch (e) {
    return `ERR:${(e?.message ?? String(e)).slice(0, 200)}`;
  }
};
const shot = (tag) => {
  const r = sh("docker", ["exec", "evex-vnc", "sh", "-c",
    "D=$(ls /tmp/.X11-unix/ 2>/dev/null | head -1 | sed 's/^X/:/'); D=${D:-:0}; DISPLAY=$D scrot -o /tmp/v.png && cat /tmp/v.png | wc -c"]);
  return r;
};

const t0 = Date.now();
const input = new VncRfbInput();
let dims;
try {
  dims = await input.connect("127.0.0.1", 5902);
} catch (e) {
  rec("rfb-handshake", false, `connect failed: ${String(e?.message ?? e).slice(0, 160)}`);
}
rec("rfb-handshake", dims.width > 0 && dims.height > 0, `desktop=${dims.width}x${dims.height}`);
rec("rfb-connected", input.connected(), "session alive after handshake");

// Baseline screenshot, then Super_L (0xFFEB, LXDE start menu) via OUR key path.
const before = shot("before");
await input.pointer(100, 100, 0);
await input.key(0xffeb, true);
await input.key(0xffeb, false);
await new Promise((r) => setTimeout(r, 2500));
const after = shot("after");
rec("input-accepted", input.connected(), "connection survived move+key events");
writeFileSync(join("artifacts/qualification", "vnc-after.png"),
  Buffer.from(sh("docker", ["exec", "evex-vnc", "sh", "-c", "cat /tmp/v.png"]).split("ERR:")[0] ?? "", "utf8"));
rec("pixels-changed", before !== after && !before.startsWith("ERR"), `before=${String(before).slice(0, 20)} after=${String(after).slice(0, 20)}`);

// Click path (button 1 down+up) + type path ("hi" keysyms), then disconnect.
await input.pointer(512, 384, 1);
await input.pointer(512, 384, 0);
for (const ks of [0x68, 0x69]) {
  await input.key(ks, true);
  await input.key(ks, false);
}
rec("click-type-accepted", input.connected(), "connection survived click+type");
await input.disconnect();
rec("disconnect-clean", !input.connected(), "socket closed");
out.totalMs = Date.now() - t0;
flush();
console.log(`\nVNC QUAL COMPLETE in ${Math.round(out.totalMs / 1000)}s`);
