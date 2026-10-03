#!/usr/bin/env node
// Rapid snapshot->restore->fork to catch the transient post-restore fork failure.
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, json: j };
}
const s = await call("POST", "/v1/sessions", { goal: "transient probe", vm: { image: "eve-desktop-xorg", cpu: 2, memoryMb: 3072, width: 1280, height: 800, network: "allowlisted" } });
console.log("sess:", s.json.id, s.json.backend);
// Wait for desktop (fast path: poll up to 12 min).
let ok = false;
for (let i = 0; i < 48; i++) {
  const o = await call("GET", `/v1/computer/${s.json.id}/observe`);
  if (o.status === 200 && o.json.width === 1280) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log("desktop-ready:", ok);
const vmId = s.json.vmId;
await call("POST", `/v1/vms/${vmId}/snapshot`, { label: "t1" });
console.log("snap ok");
await call("POST", `/v1/vms/${vmId}/restore`, { snapshot: "t1" });
console.log("restore ok");
const f = await call("POST", `/v1/vms/${vmId}/fork`, {});
console.log("FORK-IMMEDIATE:", f.status, JSON.stringify(f.json).slice(0, 300));
process.exit(0);
