#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = "sess-3e605379";
const s = await fetch(`${API}/v1/sessions/${SID}`, { headers: H }).then((r) => r.json());
console.log("vm:", s.vmId);
const t0 = Date.now();
const f = await fetch(`${API}/v1/vms/${s.vmId}/fork`, { method: "POST", headers: H, body: "{}" });
console.log(`FORK status=${f.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
console.log("BODY:", (await f.text()).slice(0, 400));
process.exit(0);
