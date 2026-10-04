#!/usr/bin/env node
const API = "http://127.0.0.1:8080";
const H = { "Content-Type": "application/json", Authorization: "Bearer " + (process.env.EVEX_AUTH_TOKEN ?? "") };
const SID = "sess-40ca42e3";
const s = await fetch(`${API}/v1/sessions/${SID}`, { headers: H }).then((r) => r.json());
console.log("session vm:", s.vmId);
const st = await fetch(`${API}/v1/vms/${s.vmId}/status`, { headers: H }).then((r) => r.json());
console.log("vm status:", JSON.stringify(st));
const f = await fetch(`${API}/v1/vms/${s.vmId}/fork`, { method: "POST", headers: H, body: "{}" });
console.log("FORK:", f.status, (await f.text()).slice(0, 400));
const a = await fetch(`${API}/v1/vms/${s.vmId}/audit`, { headers: H }).then((r) => r.json()).catch((e) => ({ error: String(e).slice(0, 100) }));
for (const e of a.audit ?? []) console.log("AUDIT:", e.at.slice(11, 19), e.op, "::", String(e.detail).slice(0, 100));
process.exit(0);
