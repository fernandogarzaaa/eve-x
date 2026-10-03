#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const ID = "vm-397e84fd";
const st = await fetch(`${API}/v1/vms/${ID}/status`, { headers: H }).then((r) => r.json());
console.log("state:", st.state);
const t0 = Date.now();
const f = await fetch(`${API}/v1/vms/${ID}/fork`, { method: "POST", headers: H, body: "{}" });
console.log(`FORK status=${f.status} after ${Math.round((Date.now() - t0) / 1000)}s`);
console.log("BODY:", (await f.text()).slice(0, 400));
process.exit(0);
