#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const vms = await fetch(API + "/v1/vms", { headers: H }).then((r) => r.json());
console.log("vms:", JSON.stringify(vms.vms.map((v) => ({ id: v.id, state: v.state, backend: v.backend, snaps: v.snapshots }))).slice(0, 300));
const first = vms.vms[0];
const r = await fetch(`${API}/v1/vms/${first.id}/fork`, { method: "POST", headers: H, body: "{}" });
console.log("FORK status:", r.status);
console.log("FORK body:", (await r.text()).slice(0, 400));
process.exit(0);
