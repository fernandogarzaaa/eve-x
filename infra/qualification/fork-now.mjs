#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer qual-canonical-token-0123456789abcdef" };
const ID = "vm-090eee2d";
const st = await fetch(`${API}/v1/vms/${ID}/status`, { headers: H }).then((r) => r.json());
console.log("state:", st.state);
const f = await fetch(`${API}/v1/vms/${ID}/fork`, { method: "POST", headers: H, body: "{}" });
console.log("FORK:", f.status, (await f.text()).slice(0, 400));
const a = await fetch(`${API}/v1/vms/${ID}/audit`, { headers: H }).then((r) => r.json()).catch((e) => ({}));
for (const e of (a.audit ?? []).slice(-8)) console.log("AUDIT:", e.at.slice(11, 19), e.op, "::", String(e.detail).slice(0, 100));
process.exit(0);
